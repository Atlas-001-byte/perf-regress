'use strict';

const fs = require('node:fs/promises');
const { computeSummary, round6, welchTest } = require('./stats');
const { parseArgs, EXIT_OK, EXIT_USAGE, EXIT_OUTPUT_ERROR } = require('./collect');

const KNOWN_KEYS = new Set(['baseline', 'candidate', 'output', 'alpha', 'min-change-percent']);

const DEFAULT_ALPHA = 0.05;
const DEFAULT_MIN_CHANGE_PERCENT = 5;

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// 解析有限数值选项；check 为取值范围校验，不满足时返回 describe 描述的错误。
function parseNumberOption(values, key, { defaultValue, check, describe }) {
  if (!Object.prototype.hasOwnProperty.call(values, key)) {
    return { value: defaultValue };
  }
  const raw = values[key];
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || !check(value)) {
    return { error: `参数 --${key} 必须${describe}，实际为: ${raw}` };
  }
  return { value };
}

// 读取并校验一份 collect JSON，提取 exit_code 为 0 的 duration_ns。
// 返回 { command, durations } 或 { error }。
async function loadInput(path, label) {
  let text;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    return { error: `无法读取 ${label} 文件 ${path}: ${err.message}` };
  }
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return { error: `${label} 文件不是合法 JSON: ${path}` };
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { error: `${label} 文件结构无效: 顶层须为对象` };
  }
  if (report.unit !== 'ns') {
    return { error: `${label} 文件 unit 必须为 "ns"` };
  }
  if (typeof report.command !== 'string') {
    return { error: `${label} 文件缺少有效的 command 字段` };
  }
  if (!Array.isArray(report.samples)) {
    return { error: `${label} 文件 samples 必须为数组` };
  }
  const durations = [];
  for (const sample of report.samples) {
    if (!sample || typeof sample !== 'object' || sample.exit_code !== 0) {
      continue;
    }
    if (!Number.isSafeInteger(sample.duration_ns) || sample.duration_ns < 0) {
      return { error: `${label} 文件含非法 duration_ns（须为非负安全整数）` };
    }
    durations.push(sample.duration_ns);
  }
  if (durations.length < 2) {
    return { error: `${label} 有效样本不足 2 个（exit_code 为 0 的样本）` };
  }
  return { command: report.command, durations };
}

// 单项指标的候选减基线差：ns 差与百分比。
// 基线为 0 时：候选也为 0 则百分比为 0，否则为 null。
function metricDelta(base, cand) {
  const ns = round6(cand - base);
  let percent;
  if (base === 0) {
    percent = cand === 0 ? 0 : null;
  } else {
    percent = round6(((cand - base) / base) * 100);
  }
  return { ns, percent };
}

// 归因：central_tendency/tail_latency/variability 分别对应 mean/p95/stddev 的百分比。
// dominant_factor 取最大正向项，平手按上述顺序；百分比为 null（基线 0 候选非 0）
// 视为无穷大正向；无正向值为 none。
function buildAttribution(delta) {
  const attribution = {
    central_tendency_percent: delta.mean.percent,
    tail_latency_percent: delta.p95.percent,
    variability_percent: delta.stddev.percent,
  };
  const entries = [
    ['central_tendency', attribution.central_tendency_percent],
    ['tail_latency', attribution.tail_latency_percent],
    ['variability', attribution.variability_percent],
  ];
  let dominant = null;
  let best = 0;
  for (const [name, percent] of entries) {
    const effective = percent === null ? Infinity : percent;
    if (effective > 0 && effective > best) {
      best = effective;
      dominant = name;
    }
  }
  attribution.dominant_factor = dominant === null ? 'none' : dominant;
  return attribution;
}

// 由两份已通过 loadInput 校验的输入，按 compare 口径重算统计量、Welch 与归因。
// decision 不在此给出：compare 以 welch.p_value 判定，compare-suite 以校正后 p 判定。
function buildCompareResult(baseline, candidate) {
  const baselineSummary = computeSummary(baseline.durations);
  const candidateSummary = computeSummary(candidate.durations);

  const delta = {
    mean: metricDelta(baselineSummary.mean, candidateSummary.mean),
    median: metricDelta(baselineSummary.median, candidateSummary.median),
    p95: metricDelta(baselineSummary.p95, candidateSummary.p95),
    stddev: metricDelta(baselineSummary.stddev, candidateSummary.stddev),
  };

  const welch = welchTest(baseline.durations, candidate.durations);
  const attribution = buildAttribution(delta);
  return { baselineSummary, candidateSummary, delta, welch, attribution };
}

// compare 四类 decision 口径：p_value <= alpha 为显著，再按 mean 百分比与阈值判定。
// 基线均值为 0 而候选非 0（percent 为 null）视为达到阈值的增加。
function decide(pValue, alpha, meanPercent, minChangePercent) {
  if (!(pValue <= alpha)) {
    return 'not_significant';
  }
  const pct = meanPercent === null ? Infinity : meanPercent;
  if (pct > 0 && pct >= minChangePercent) {
    return 'regression';
  }
  if (pct < 0 && -pct >= minChangePercent) {
    return 'improvement';
  }
  return 'no_material_change';
}

async function compare(tokens) {
  const { values, error: parseError } = parseArgs(tokens, KNOWN_KEYS);
  if (parseError) {
    return fail(parseError);
  }

  const baselinePath = values.baseline;
  const candidatePath = values.candidate;
  const output = values.output;
  if (baselinePath === undefined || baselinePath === '') {
    return fail('--baseline 不能为空');
  }
  if (candidatePath === undefined || candidatePath === '') {
    return fail('--candidate 不能为空');
  }
  if (output === undefined || output === '') {
    return fail('--output 不能为空');
  }

  const alphaR = parseNumberOption(values, 'alpha', {
    defaultValue: DEFAULT_ALPHA,
    check: (v) => v > 0 && v < 1,
    describe: '满足 0 < alpha < 1',
  });
  if (alphaR.error) {
    return fail(alphaR.error);
  }
  const minChangeR = parseNumberOption(values, 'min-change-percent', {
    defaultValue: DEFAULT_MIN_CHANGE_PERCENT,
    check: (v) => v >= 0,
    describe: '为不小于 0 的数',
  });
  if (minChangeR.error) {
    return fail(minChangeR.error);
  }
  const alpha = alphaR.value;
  const minChangePercent = minChangeR.value;

  const baseline = await loadInput(baselinePath, '--baseline');
  if (baseline.error) {
    return fail(baseline.error);
  }
  const candidate = await loadInput(candidatePath, '--candidate');
  if (candidate.error) {
    return fail(candidate.error);
  }
  if (baseline.command !== candidate.command) {
    return fail('两份输入的 command 不一致');
  }

  const {
    baselineSummary, candidateSummary, delta, welch, attribution,
  } = buildCompareResult(baseline, candidate);

  const decision = decide(welch.p_value, alpha, delta.mean.percent, minChangePercent);

  const result = {
    baseline_summary: baselineSummary,
    candidate_summary: candidateSummary,
    delta,
    welch,
    decision,
    attribution,
  };

  let payload;
  try {
    payload = JSON.stringify(result, null, 2) + '\n';
  } catch (err) {
    process.stderr.write(`perf-regress: 结果序列化失败: ${err.message}\n`);
    return EXIT_OUTPUT_ERROR;
  }

  try {
    await fs.writeFile(output, payload, 'utf8');
  } catch (err) {
    process.stderr.write(`perf-regress: 无法写入 --output ${output}: ${err.message}\n`);
    return EXIT_OUTPUT_ERROR;
  }

  return EXIT_OK;
}

module.exports = {
  compare,
  loadInput,
  buildCompareResult,
  decide,
  parseNumberOption,
  DEFAULT_ALPHA,
  DEFAULT_MIN_CHANGE_PERCENT,
};
