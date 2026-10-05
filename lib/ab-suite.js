'use strict';

const fs = require('node:fs/promises');
const {
  parseArgs,
  parsePositiveIntOption,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_MEASURE_ERROR,
  EXIT_OUTPUT_ERROR,
} = require('./collect');
const {
  buildCompareResult,
  decide,
  parseNumberOption,
  DEFAULT_ALPHA,
  DEFAULT_MIN_CHANGE_PERCENT,
} = require('./compare');
const {
  benjaminiHochberg,
  medianPercent,
  dominantFactor,
} = require('./compare-suite');
const { executeInterleaved, buildSideReport } = require('./ab');

const KNOWN_KEYS = new Set(['manifest', 'output', 'alpha', 'min-change-percent']);

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// 读取并校验 ab-suite manifest：UTF-8 JSON 对象，cases 为非空数组；
// 每项 name 非空且唯一，baseline_command/candidate_command 非空，
// runs/warmup/timeout_ms 沿用 ab 口径（runs >= 2、warmup >= 0、
// timeout_ms >= 1，均为整数），未知字段忽略。返回 { cases } 或 { error }。
async function loadManifest(manifestPath) {
  let text;
  try {
    text = await fs.readFile(manifestPath, 'utf8');
  } catch (err) {
    return { error: `无法读取 manifest 文件 ${manifestPath}: ${err.message}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { error: `manifest 文件不是合法 JSON: ${manifestPath}` };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { error: 'manifest 结构无效: 顶层须为对象' };
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    return { error: 'manifest cases 必须为非空数组' };
  }

  const cases = [];
  const names = new Set();
  for (let i = 0; i < manifest.cases.length; i++) {
    const item = manifest.cases[i];
    const where = `manifest cases[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `${where} 必须为对象` };
    }
    if (typeof item.name !== 'string' || item.name === '') {
      return { error: `${where} 的 name 必须为非空字符串` };
    }
    if (names.has(item.name)) {
      return { error: `manifest cases 中 name 重复: ${item.name}` };
    }
    if (typeof item.baseline_command !== 'string' || item.baseline_command === '') {
      return { error: `${where} (${item.name}) 的 baseline_command 必须为非空字符串` };
    }
    if (typeof item.candidate_command !== 'string' || item.candidate_command === '') {
      return { error: `${where} (${item.name}) 的 candidate_command 必须为非空字符串` };
    }
    const intField = (key, min) => {
      if (!Number.isSafeInteger(item[key])) {
        return `${where} (${item.name}) 的 ${key} 必须为整数，实际为: ${JSON.stringify(item[key])}`;
      }
      if (item[key] < min) {
        return `${where} (${item.name}) 的 ${key} 必须为 >= ${min} 的整数，实际为: ${item[key]}`;
      }
      return null;
    };
    for (const e of [
      intField('runs', 2),
      intField('warmup', 0),
      intField('timeout_ms', 1),
    ]) {
      if (e) return { error: e };
    }
    names.add(item.name);
    cases.push({
      name: item.name,
      baseline_command: item.baseline_command,
      candidate_command: item.candidate_command,
      runs: item.runs,
      warmup: item.warmup,
      timeout_ms: item.timeout_ms,
    });
  }
  return { cases };
}

async function abSuite(tokens) {
  const { values, error: parseError } = parseArgs(tokens, KNOWN_KEYS);
  if (parseError) {
    return fail(parseError);
  }

  const manifestPath = values.manifest;
  const output = values.output;
  if (manifestPath === undefined || manifestPath === '') {
    return fail('--manifest 不能为空');
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

  // 执行前完整校验：manifest 不合法直接退出 2，不创建或改写 output。
  const manifestR = await loadManifest(manifestPath);
  if (manifestR.error) {
    return fail(manifestR.error);
  }

  // 按 cases 顺序串行执行：每个 case 沿用 ab 的交错口径
  // （先两侧全部预热，再两侧交错测量，每轮先 baseline 后 candidate）。
  // warmup 错只记录；measure 错跳过该次后继续；
  // 进程无法启动（spawn 失败或 shell 126/127）属致命错误：退出码 2，不写 output。
  const executed = [];
  for (const c of manifestR.cases) {
    const { baseline, candidate, fatal } = await executeInterleaved(
      c.baseline_command, c.candidate_command,
      c.runs, c.warmup, c.timeout_ms);
    if (fatal) {
      return EXIT_USAGE;
    }
    executed.push({ spec: c, baseline, candidate });
  }

  // 仅对两侧均至少有两个有效样本的 case 做 BH 校正与 decision；
  // 其余 case 的 comparison/adjusted_p_value/decision 为 null。
  const annotated = executed.map((entry) => {
    const baselineDurations = entry.baseline.samples.map((s) => s.duration_ns);
    const candidateDurations = entry.candidate.samples.map((s) => s.duration_ns);
    const isComparable = baselineDurations.length >= 2 && candidateDurations.length >= 2;
    return { ...entry, baselineDurations, candidateDurations, isComparable };
  });

  // 可比较 case 的统计口径与 ab 一致；原始 p 值集中做 BH 校正。
  const compareResultByName = new Map();
  const pValues = [];
  for (const entry of annotated) {
    if (!entry.isComparable) continue;
    const result = buildCompareResult(
      { command: entry.spec.baseline_command, durations: entry.baselineDurations },
      { command: entry.spec.candidate_command, durations: entry.candidateDurations },
    );
    compareResultByName.set(entry.spec.name, result);
    pValues.push(result.welch.p_value);
  }
  const adjustedByName = new Map();
  const comparableSpecs = annotated.filter((e) => e.isComparable).map((e) => e.spec);
  benjaminiHochberg(pValues).forEach((q, i) => {
    adjustedByName.set(comparableSpecs[i].name, q);
  });

  let incomplete = 0;
  const caseReports = annotated.map((entry) => {
    const { spec } = entry;
    const baselineReport = buildSideReport(
      spec.baseline_command, spec.runs, spec.warmup, spec.timeout_ms, entry.baseline);
    const candidateReport = buildSideReport(
      spec.candidate_command, spec.runs, spec.warmup, spec.timeout_ms, entry.candidate);

    let comparison = null;
    let adjustedPValue = null;
    let caseDecision = null;
    const c = compareResultByName.get(spec.name);
    if (c) {
      // comparison 字段与 ab 完全一致（含以原始 p 值判定的 decision）。
      comparison = {
        baseline_summary: c.baselineSummary,
        candidate_summary: c.candidateSummary,
        delta: c.delta,
        welch: c.welch,
        decision: decide(c.welch.p_value, alpha, c.delta.mean.percent, minChangePercent),
        attribution: c.attribution,
      };
      adjustedPValue = adjustedByName.get(spec.name);
      // 顶层 decision 沿用 compare-suite：以 BH 校正后的 adjusted_p_value
      // 与 --min-change-percent 判定。
      caseDecision = decide(
        adjustedPValue, alpha, c.delta.mean.percent, minChangePercent);
    } else {
      // 普通测量错误或任一侧有效样本少于 2：该 case 不具可比性。
      incomplete += 1;
    }

    return {
      name: spec.name,
      baseline: baselineReport,
      candidate: candidateReport,
      comparison,
      adjusted_p_value: adjustedPValue,
      decision: caseDecision,
    };
  });

  const counts = {
    regression: 0,
    improvement: 0,
    no_material_change: 0,
    not_significant: 0,
  };
  for (const report of caseReports) {
    if (report.decision !== null) {
      counts[report.decision] += 1;
    }
  }

  // 套件级判定仅统计非 null comparison；优先级：
  // regression > improvement > no_material_change > not_significant；
  // 一个可比较 case 都没有时为 incomplete。
  let suiteDecision = 'incomplete';
  if (counts.regression > 0) {
    suiteDecision = 'regression';
  } else if (counts.improvement > 0) {
    suiteDecision = 'improvement';
  } else if (counts.no_material_change > 0) {
    suiteDecision = 'no_material_change';
  } else if (counts.not_significant > 0) {
    suiteDecision = 'not_significant';
  }

  const suiteSummary = {
    total: caseReports.length,
    comparable: caseReports.length - incomplete,
    incomplete,
    suite_decision: suiteDecision,
  };

  // 套件归因只汇总非 null comparison，口径与 compare-suite 一致：
  // 各 case 百分比的中位数（null 按正无穷，正无穷中位数写 null），
  // dominant_factor 取三个中位数中的最大正值，平手按顺序，无正值为 none。
  const comparableReports = caseReports.filter((c) => c.comparison !== null);
  const suiteAttribution = {
    central_tendency_percent: medianPercent(
      comparableReports.map((c) => c.comparison.attribution.central_tendency_percent)),
    tail_latency_percent: medianPercent(
      comparableReports.map((c) => c.comparison.attribution.tail_latency_percent)),
    variability_percent: medianPercent(
      comparableReports.map((c) => c.comparison.attribution.variability_percent)),
  };
  // 无具可比性 case 时三项 null 表示无数据（而非正无穷），dominant_factor 为 none。
  suiteAttribution.dominant_factor = comparableReports.length === 0 ? 'none'
    : dominantFactor(
      suiteAttribution.central_tendency_percent,
      suiteAttribution.tail_latency_percent,
      suiteAttribution.variability_percent);

  const result = {
    cases: caseReports,
    suite_summary: suiteSummary,
    suite_attribution: suiteAttribution,
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

  // 普通测量错误或任一 case 任一侧有效样本少于 2：写完整 JSON 后退出 3。
  const hasMeasureErrors = executed.some((entry) =>
    entry.baseline.errors.some((e) => e.stage === 'measure')
    || entry.candidate.errors.some((e) => e.stage === 'measure'));
  const hasInsufficientSamples = executed.some((entry) =>
    entry.baseline.samples.length < 2 || entry.candidate.samples.length < 2);
  return hasMeasureErrors || hasInsufficientSamples ? EXIT_MEASURE_ERROR : EXIT_OK;
}

module.exports = {
  abSuite,
  loadManifest,
};
