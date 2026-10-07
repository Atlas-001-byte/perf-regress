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
const { buildPairs, buildPairedResult } = require('./ab-paired');
// ab-paired-suite 的 manifest 与 ab-suite 完全同构（name 唯一非空、
// baseline_command/candidate_command 非空、runs >= 2、warmup >= 0、
// timeout_ms >= 1，均为整数，未知字段忽略），直接复用其校验。
const { loadManifest } = require('./ab-suite');

const KNOWN_KEYS = new Set(['manifest', 'output', 'alpha', 'min-change-percent']);

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

async function abPairedSuite(tokens) {
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

  // 按 cases 顺序串行执行：每个 case 沿用 ab-paired 的交错口径
  // （先两侧全部预热，再两侧交错测量，每轮先 baseline 后 candidate），
  // 同轮两侧均退出 0 才构成一对。warmup 错只记录；measure 错跳过该次后继续；
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

  // 仅对完整 pairs >= 2 的 case 做配对统计与 BH 校正；
  // pairs < 2 的 case 只写 paired（含 count），统计/区间/decision 为 null。
  const annotated = executed.map((entry) => {
    const pairs = buildPairs(entry.baseline.samples, entry.candidate.samples);
    const built = buildPairedResult(pairs, alpha, minChangePercent);
    return { ...entry, pairs, ...built, comparable: pairs.length >= 2 };
  });

  // 可比较 case 的 paired 口径与 ab-paired 一致；原始配对 p 值集中做 BH 校正。
  const comparable = annotated.filter((e) => e.comparable);
  const adjustedByName = new Map();
  if (comparable.length > 0) {
    const pValues = comparable.map((e) => e.paired.t_test.p_value);
    benjaminiHochberg(pValues).forEach((q, i) => {
      adjustedByName.set(comparable[i].spec.name, q);
    });
  }

  const counts = {
    regression: 0,
    improvement: 0,
    no_material_change: 0,
    not_significant: 0,
  };

  const caseReports = annotated.map((entry) => {
    const { spec } = entry;
    const baselineReport = buildSideReport(
      spec.baseline_command, spec.runs, spec.warmup, spec.timeout_ms, entry.baseline);
    const candidateReport = buildSideReport(
      spec.candidate_command, spec.runs, spec.warmup, spec.timeout_ms, entry.candidate);

    const { paired, meanPercent } = entry;

    let adjustedPValue = null;
    let caseDecision = null;
    if (entry.comparable) {
      adjustedPValue = adjustedByName.get(spec.name);
      // 顶层 decision 沿用 compare-suite：以 BH 校正后的 adjusted_p_value
      // 与 --min-change-percent 判定；paired 内部 decision 仍用原始 p 值。
      caseDecision = decide(adjustedPValue, alpha, meanPercent, minChangePercent);
      counts[caseDecision] += 1;
    }

    return {
      name: spec.name,
      baseline: baselineReport,
      candidate: candidateReport,
      paired,
      adjusted_p_value: adjustedPValue,
      decision: caseDecision,
    };
  });

  // 套件级判定仅统计可比较 case；优先级：
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
    regression: counts.regression,
    improvement: counts.improvement,
    no_material_change: counts.no_material_change,
    not_significant: counts.not_significant,
    suite_decision: suiteDecision,
  };

  // 套件归因只汇总可比较 case，口径与 compare-suite 一致：
  // 各 case 配对归因百分比的中位数（null 按正无穷，正无穷中位数写 null），
  // dominant_factor 取三个中位数中的最大正值，平手按顺序，无正值为 none。
  const comparableReports = caseReports.filter((c) => c.decision !== null);
  const suiteAttribution = {
    central_tendency_percent: medianPercent(
      comparableReports.map((c) => c.paired.attribution.central_tendency_percent)),
    tail_latency_percent: medianPercent(
      comparableReports.map((c) => c.paired.attribution.tail_latency_percent)),
    variability_percent: medianPercent(
      comparableReports.map((c) => c.paired.attribution.variability_percent)),
  };
  // 无可比较 case 时三项 null 表示无数据（而非正无穷），dominant_factor 为 none。
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

  // 普通测量错误或任一 case 完整 pairs 少于 2：写完整 JSON 后退出 3。
  const hasMeasureErrors = executed.some((entry) =>
    entry.baseline.errors.some((e) => e.stage === 'measure')
    || entry.candidate.errors.some((e) => e.stage === 'measure'));
  const hasTooFewPairs = annotated.some((entry) => entry.pairs.length < 2);
  return hasMeasureErrors || hasTooFewPairs ? EXIT_MEASURE_ERROR : EXIT_OK;
}

module.exports = {
  abPairedSuite,
};
