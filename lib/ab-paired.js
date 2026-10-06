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
  decide,
  metricDelta,
  buildAttribution,
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

// 按轮次配对：同一 index 的 baseline 与 candidate 均 exit_code 为 0
// （即都出现在各自 samples 中）才构成一对。delta_ns 为候选减基线。
function buildPairs(baselineSamples, candidateSamples) {
  const candidateByIndex = new Map(candidateSamples.map((s) => [s.index, s]));
  const pairs = [];
  for (const b of baselineSamples) {
    const c = candidateByIndex.get(b.index);
    if (c === undefined) {
      continue;
    }
    pairs.push({
      index: b.index,
      baseline_duration_ns: b.duration_ns,
      candidate_duration_ns: c.duration_ns,
      delta_ns: c.duration_ns - b.duration_ns,
    });
  }
  return pairs;
}

// 逐对差值的五项汇总；空样本时除 count 外均为 null。
function deltaSummary(deltas) {
  if (deltas.length === 0) {
    return { count: 0, mean: null, median: null, p95: null, stddev: null };
  }
  const s = computeSummary(deltas);
  return {
    count: s.count,
    mean: s.mean,
    median: s.median,
    p95: s.p95,
    stddev: s.stddev,
  };
}

// 配对口径的归因：对成对的 baseline/candidate 样本按 compare 口径
// 重算 summary，再取 mean/p95/stddev 三项百分比归因。
// 无成对样本时三项百分比为 null、dominant_factor 为 none。
function pairedAttribution(pairs) {
  if (pairs.length === 0) {
    return {
      central_tendency_percent: null,
      tail_latency_percent: null,
      variability_percent: null,
      dominant_factor: 'none',
    };
  }
  const baselineSummary = computeSummary(pairs.map((p) => p.baseline_duration_ns));
  const candidateSummary = computeSummary(pairs.map((p) => p.candidate_duration_ns));
  return buildAttribution({
    mean: metricDelta(baselineSummary.mean, candidateSummary.mean),
    p95: metricDelta(baselineSummary.p95, candidateSummary.p95),
    stddev: metricDelta(baselineSummary.stddev, candidateSummary.stddev),
  });
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

  // 执行口径与 ab 一致：先全部预热再逐轮测量，每轮先 baseline 后 candidate，
  // 全程串行；warmup 错只记录，measure 错跳过该次后继续；
  // 进程无法启动（spawn 失败或 shell 126/127）属致命错误：退出码 2，不写 output。
  const { baseline, candidate, fatal } = await executeInterleaved(
    baselineCommand, candidateCommand, runs, warmup, timeoutMs);
  if (fatal) {
    return EXIT_USAGE;
  }

  const baselineReport = buildSideReport(baselineCommand, runs, warmup, timeoutMs, baseline);
  const candidateReport = buildSideReport(candidateCommand, runs, warmup, timeoutMs, candidate);

  const pairs = buildPairs(baseline.samples, candidate.samples);
  const deltas = pairs.map((p) => p.delta_ns);

  // 完整 pairs 至少 2 对时才给出配对 t 检验、均值差区间与 decision；
  // 不足时三者均为 null，summary.count 仍为完整对数。
  let tTest = null;
  let confidenceInterval = null;
  let decision = null;
  if (pairs.length >= 2) {
    const baselineSummary = computeSummary(pairs.map((p) => p.baseline_duration_ns));
    const candidateSummary = computeSummary(pairs.map((p) => p.candidate_duration_ns));
    const meanPercent = metricDelta(baselineSummary.mean, candidateSummary.mean).percent;

    tTest = pairedTTest(deltas);
    const interval = pairedMeanInterval(deltas, baselineSummary.mean, alpha);
    confidenceInterval = {
      level: round6(interval.level),
      lower_ns: round6(interval.lower_ns),
      upper_ns: round6(interval.upper_ns),
      lower_percent: interval.lower_percent === null ? null : round6(interval.lower_percent),
      upper_percent: interval.upper_percent === null ? null : round6(interval.upper_percent),
    };
    decision = decide(tTest.p_value, alpha, meanPercent, minChangePercent);
  }

  const report = {
    baseline: baselineReport,
    candidate: candidateReport,
    paired: {
      pairs,
      summary: deltaSummary(deltas),
      t_test: tTest,
      confidence_interval: confidenceInterval,
      decision,
      attribution: pairedAttribution(pairs),
    },
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

  // 普通测量错误或完整 pairs 少于 2：写完整 JSON 后退出 3。
  const hasMeasureErrors = baselineReport.errors.some((e) => e.stage === 'measure')
    || candidateReport.errors.some((e) => e.stage === 'measure');
  return hasMeasureErrors || pairs.length < 2 ? EXIT_MEASURE_ERROR : EXIT_OK;
}

module.exports = {
  abPaired,
  buildPairs,
  deltaSummary,
  pairedAttribution,
};
