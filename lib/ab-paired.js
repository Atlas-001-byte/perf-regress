'use strict';

const fs = require('node:fs/promises');
const {
  parseArgs,
  parsePositiveIntOption,
  computeSummary,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_MEASURE_ERROR,
  EXIT_OUTPUT_ERROR,
} = require('./collect');
const {
  metricDelta,
  buildAttribution,
  decide,
  parseNumberOption,
  DEFAULT_ALPHA,
  DEFAULT_MIN_CHANGE_PERCENT,
} = require('./compare');
const { round6, pairedTTest, pairedMeanInterval } = require('./stats');
const { executeInterleaved, buildSideReport } = require('./ab');

const KNOWN_KEYS = new Set([
  'baseline-command',
  'candidate-command',
  'runs',
  'warmup',
  'timeout-ms',
  'output',
  'alpha',
  'min-change-percent',
]);

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// 由两侧 measure 样本按原始 index 内连接得到完整配对：
// 仅同轮两侧均退出 0 时该 index 计为一个 pair，delta_ns 为候选减基线。
function buildPairs(baseline, candidate) {
  const baselineByIndex = new Map(
    baseline.samples.map((s) => [s.index, s.duration_ns]));
  const pairs = [];
  for (const s of candidate.samples) {
    if (!baselineByIndex.has(s.index)) continue;
    const baselineDuration = baselineByIndex.get(s.index);
    pairs.push({
      index: s.index,
      baseline_duration_ns: baselineDuration,
      candidate_duration_ns: s.duration_ns,
      delta_ns: s.duration_ns - baselineDuration,
    });
  }
  pairs.sort((a, b) => a.index - b.index);
  return pairs;
}

// delta_ns 的 summary：count/mean/median/p95/stddev 五项
// （不含 collect 口径的 min/max）；空样本除 count 外为 null。
function buildDeltaSummary(pairs) {
  if (pairs.length === 0) {
    return { count: 0, mean: null, median: null, p95: null, stddev: null };
  }
  const full = computeSummary(pairs.map((p) => p.delta_ns));
  return {
    count: full.count,
    mean: full.mean,
    median: full.median,
    p95: full.p95,
    stddev: full.stddev,
  };
}

// 完整 pairs 不少于 2 时，按 compare 语义由配对样本重算两侧统计，
// 给出配对 t 检验、均值差区间、decision 与归因；否则统计字段均为 null。
function buildPairedResult(pairs, alpha, minChangePercent) {
  const summary = buildDeltaSummary(pairs);
  if (pairs.length < 2) {
    return {
      pairs,
      summary,
      t_test: null,
      confidence_interval: null,
      decision: null,
      attribution: null,
    };
  }

  const baselineDurations = pairs.map((p) => p.baseline_duration_ns);
  const candidateDurations = pairs.map((p) => p.candidate_duration_ns);
  const deltas = pairs.map((p) => p.delta_ns);

  // compare 语义：四项指标差与归因均由配对后的两侧 summary 计算。
  const baselineSummary = computeSummary(baselineDurations);
  const candidateSummary = computeSummary(candidateDurations);
  const delta = {
    mean: metricDelta(baselineSummary.mean, candidateSummary.mean),
    median: metricDelta(baselineSummary.median, candidateSummary.median),
    p95: metricDelta(baselineSummary.p95, candidateSummary.p95),
    stddev: metricDelta(baselineSummary.stddev, candidateSummary.stddev),
  };

  // 区间与百分比使用原始（未取整）均值，口径同 compare 的 welchMeanInterval。
  const baselineMean = baselineDurations.reduce((acc, v) => acc + v, 0)
    / baselineDurations.length;
  const interval = pairedMeanInterval(deltas, baselineMean, alpha);
  const confidenceInterval = {
    level: round6(interval.level),
    lower_ns: round6(interval.lower_ns),
    upper_ns: round6(interval.upper_ns),
    lower_percent: interval.lower_percent === null ? null : round6(interval.lower_percent),
    upper_percent: interval.upper_percent === null ? null : round6(interval.upper_percent),
  };
  delta.mean.confidence_interval = confidenceInterval;

  const tTest = pairedTTest(deltas);
  const decisionValue = decide(
    tTest.p_value, alpha, delta.mean.percent, minChangePercent);
  const attribution = buildAttribution(delta);

  return {
    pairs,
    summary,
    t_test: tTest,
    confidence_interval: confidenceInterval,
    decision: decisionValue,
    attribution,
  };
}

async function abPaired(tokens) {
  const { values, error: parseError } = parseArgs(tokens, KNOWN_KEYS);
  if (parseError) {
    return fail(parseError);
  }

  const baselineCommand = values['baseline-command'];
  const candidateCommand = values['candidate-command'];
  const output = values.output;
  if (baselineCommand === undefined || baselineCommand === '') {
    return fail('--baseline-command 不能为空');
  }
  if (candidateCommand === undefined || candidateCommand === '') {
    return fail('--candidate-command 不能为空');
  }
  if (output === undefined || output === '') {
    return fail('--output 不能为空');
  }

  const runsR = parsePositiveIntOption(values, 'runs', { min: 2, required: true });
  if (runsR.error) {
    return fail(runsR.error);
  }
  const warmupR = parsePositiveIntOption(values, 'warmup', { min: 0, required: false });
  if (warmupR.error) {
    return fail(warmupR.error);
  }
  const timeoutR = parsePositiveIntOption(values, 'timeout-ms', { min: 1, required: true });
  if (timeoutR.error) {
    return fail(timeoutR.error);
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

  const runs = runsR.value;
  const warmup = warmupR.value === undefined ? 0 : warmupR.value;
  const timeoutMs = timeoutR.value;
  const alpha = alphaR.value;
  const minChangePercent = minChangeR.value;

  // 执行口径与 ab 完全一致：先两侧全部预热，再逐轮先 baseline 后 candidate，
  // 全程串行，输出丢弃；timeout/nonzero_exit 记录后跳过该次，
  // 进程无法启动属致命错误（退出码 2，不写 output）。
  const { baseline, candidate, fatal } = await executeInterleaved(
    baselineCommand, candidateCommand, runs, warmup, timeoutMs);
  if (fatal) {
    return EXIT_USAGE;
  }

  const baselineReport = buildSideReport(baselineCommand, runs, warmup, timeoutMs, baseline);
  const candidateReport = buildSideReport(candidateCommand, runs, warmup, timeoutMs, candidate);

  const pairs = buildPairs(baseline, candidate);
  const paired = buildPairedResult(pairs, alpha, minChangePercent);

  const report = {
    baseline: baselineReport,
    candidate: candidateReport,
    paired,
  };

  let payload;
  try {
    payload = JSON.stringify(report, null, 2) + '\n';
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

  const hasMeasureErrors = baselineReport.errors.some((e) => e.stage === 'measure')
    || candidateReport.errors.some((e) => e.stage === 'measure');
  return hasMeasureErrors || pairs.length < 2 ? EXIT_MEASURE_ERROR : EXIT_OK;
}

module.exports = {
  abPaired,
  buildPairs,
  buildDeltaSummary,
  buildPairedResult,
};
