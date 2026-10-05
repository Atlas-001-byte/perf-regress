'use strict';

const fs = require('node:fs/promises');
const {
  parseArgs,
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
const { executeInterleaved, buildSideReport } = require('./ab');
const { benjaminiHochberg, medianPercent, dominantFactor } = require('./compare-suite');

const KNOWN_KEYS = new Set(['manifest', 'output', 'alpha', 'min-change-percent']);

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// 读取并校验 ab-suite manifest：UTF-8 JSON 对象，cases 为非空数组；
// 每项 name 非空且唯一，baseline_command/candidate_command 非空，
// runs/warmup/timeout_ms 按 ab 约束（runs >= 2、warmup >= 0、timeout_ms >= 1，
// 均为整数），未知字段忽略。返回 { cases } 或 { error }。
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

  // 按 manifest 顺序逐 case 交错 A/B（沿用 ab 口径：先两侧 warmup，
  // 再两侧 measure，每轮先 baseline 后 candidate），case 间不并发。
  const measured = [];
  for (const c of manifestR.cases) {
    const { baseline, candidate, fatal } = await executeInterleaved(
      c.baseline_command, c.candidate_command, c.runs, c.warmup, c.timeout_ms);
    // 进程无法启动属致命错误：stderr 已报告，不创建或改写 output。
    if (fatal) {
      return EXIT_USAGE;
    }
    const baselineReport = buildSideReport(
      c.baseline_command, c.runs, c.warmup, c.timeout_ms, baseline);
    const candidateReport = buildSideReport(
      c.candidate_command, c.runs, c.warmup, c.timeout_ms, candidate);

    // 两侧都至少有两个 exit_code 为 0 的样本时，按 compare 口径给出比较结果。
    const baselineDurations = baselineReport.samples.map((s) => s.duration_ns);
    const candidateDurations = candidateReport.samples.map((s) => s.duration_ns);
    let comparison = null;
    if (baselineDurations.length >= 2 && candidateDurations.length >= 2) {
      const {
        baselineSummary, candidateSummary, delta, welch, attribution,
      } = buildCompareResult(
        { command: c.baseline_command, durations: baselineDurations },
        { command: c.candidate_command, durations: candidateDurations },
      );
      comparison = {
        baseline_summary: baselineSummary,
        candidate_summary: candidateSummary,
        delta,
        welch,
        decision: decide(welch.p_value, alpha, delta.mean.percent, minChangePercent),
        attribution,
      };
    }
    measured.push({
      name: c.name,
      baseline: baselineReport,
      candidate: candidateReport,
      comparison,
    });
  }

  // 仅对 comparison 非 null 的 case 做 BH 校正，判定沿用 compare-suite 口径；
  // comparison 为 null 时 adjusted_p_value 与 decision 均为 null。
  const comparable = measured.filter((m) => m.comparison !== null);
  const adjusted = benjaminiHochberg(comparable.map((m) => m.comparison.welch.p_value));
  const adjustedByName = new Map();
  comparable.forEach((m, i) => {
    adjustedByName.set(m.name, adjusted[i]);
  });

  const counts = {
    regression: 0,
    improvement: 0,
    no_material_change: 0,
    not_significant: 0,
  };
  const caseResults = measured.map((m) => {
    let adjustedPValue = null;
    let decision = null;
    if (m.comparison !== null) {
      adjustedPValue = adjustedByName.get(m.name);
      decision = decide(
        adjustedPValue, alpha, m.comparison.delta.mean.percent, minChangePercent);
      counts[decision] += 1;
    }
    return {
      name: m.name,
      baseline: m.baseline,
      candidate: m.candidate,
      comparison: m.comparison,
      adjusted_p_value: adjustedPValue,
      decision,
    };
  });

  // 优先级：regression > improvement > no_material_change > not_significant；
  // 无可比较 case 时为 incomplete。
  const suiteDecision = counts.regression > 0 ? 'regression'
    : counts.improvement > 0 ? 'improvement'
      : counts.no_material_change > 0 ? 'no_material_change'
        : counts.not_significant > 0 ? 'not_significant'
          : 'incomplete';

  const suiteSummary = {
    total: caseResults.length,
    comparable: comparable.length,
    incomplete: caseResults.length - comparable.length,
    suite_decision: suiteDecision,
  };

  // suite 归因只汇总 comparison 非 null 的 case，口径与 compare-suite 相同。
  const comparableAttributions = comparable.map((m) => m.comparison.attribution);
  const suiteAttribution = {
    central_tendency_percent: comparableAttributions.length === 0 ? null
      : medianPercent(comparableAttributions.map((a) => a.central_tendency_percent)),
    tail_latency_percent: comparableAttributions.length === 0 ? null
      : medianPercent(comparableAttributions.map((a) => a.tail_latency_percent)),
    variability_percent: comparableAttributions.length === 0 ? null
      : medianPercent(comparableAttributions.map((a) => a.variability_percent)),
  };
  suiteAttribution.dominant_factor = dominantFactor(
    suiteAttribution.central_tendency_percent,
    suiteAttribution.tail_latency_percent,
    suiteAttribution.variability_percent);

  const result = {
    cases: caseResults,
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

  const hasMeasureErrors = measured.some((m) => m.baseline.errors.some((e) => e.stage === 'measure')
    || m.candidate.errors.some((e) => e.stage === 'measure'));
  const hasInsufficientSamples = measured.some((m) => m.baseline.samples.length < 2
    || m.candidate.samples.length < 2);
  return hasMeasureErrors || hasInsufficientSamples ? EXIT_MEASURE_ERROR : EXIT_OK;
}

module.exports = {
  abSuite,
  loadManifest,
};
