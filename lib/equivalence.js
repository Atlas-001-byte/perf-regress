'use strict';

const fs = require('node:fs/promises');
const {
  computeSummary, round6, welchMeanInterval, equivalenceTest,
} = require('./stats');
const { parseArgs, EXIT_OK, EXIT_USAGE, EXIT_OUTPUT_ERROR } = require('./collect');
const { loadInput, parseNumberOption, metricDelta } = require('./compare');

const KNOWN_KEYS = new Set(['baseline', 'candidate', 'output', 'margin-percent', 'alpha']);

const DEFAULT_ALPHA = 0.05;
const DEFAULT_MARGIN_PERCENT = 5;

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// equivalence 四类 decision 口径：
// 两检验 p_value 均 <= alpha 为等价；否则按单侧反方向检验判定越界方向。
function decideEquivalence(lowerP, upperP, alpha) {
  if (lowerP <= alpha && upperP <= alpha) {
    return 'equivalent';
  }
  if (1 - upperP <= alpha) {
    return 'above_margin';
  }
  if (1 - lowerP <= alpha) {
    return 'below_margin';
  }
  return 'inconclusive';
}

async function equivalence(tokens) {
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
  const marginR = parseNumberOption(values, 'margin-percent', {
    defaultValue: DEFAULT_MARGIN_PERCENT,
    check: (v) => v > 0,
    describe: '为大于 0 的数',
  });
  if (marginR.error) {
    return fail(marginR.error);
  }
  const alpha = alphaR.value;
  const marginPercent = marginR.value;

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

  const baselineSummary = computeSummary(baseline.durations);
  const candidateSummary = computeSummary(candidate.durations);

  // margin 与变化百分比均以基线均值为基准，基线均值非正时输入无效。
  if (!(baselineSummary.mean > 0)) {
    return fail('--baseline 基线均值必须为正（margin 与百分比以基线均值为基准）');
  }

  // 差值：候选均值减基线均值；区间为双侧 1 - 2*alpha 的 Welch 区间。
  const meanDelta = metricDelta(baselineSummary.mean, candidateSummary.mean);
  const interval = welchMeanInterval(baseline.durations, candidate.durations, 2 * alpha);
  meanDelta.confidence_interval = {
    level: round6(interval.level),
    lower_ns: round6(interval.lower_ns),
    upper_ns: round6(interval.upper_ns),
    lower_percent: interval.lower_percent === null ? null : round6(interval.lower_percent),
    upper_percent: interval.upper_percent === null ? null : round6(interval.upper_percent),
  };
  const delta = { mean: meanDelta };

  const margin = {
    ns: round6((baselineSummary.mean * marginPercent) / 100),
    percent: round6(marginPercent),
  };

  const test = equivalenceTest(baseline.durations, candidate.durations, margin.ns);
  const decision = decideEquivalence(test.lower.p_value, test.upper.p_value, alpha);

  const result = {
    baseline_summary: baselineSummary,
    candidate_summary: candidateSummary,
    delta,
    margin,
    equivalence_test: test,
    decision,
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
  equivalence,
  decideEquivalence,
  DEFAULT_ALPHA,
  DEFAULT_MARGIN_PERCENT,
};
