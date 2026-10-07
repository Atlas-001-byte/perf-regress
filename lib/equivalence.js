'use strict';

const fs = require('node:fs/promises');
const {
  computeSummary, round6, tCdf, welchMeanInterval, welchStandardError,
} = require('./stats');
const { parseArgs, EXIT_OK, EXIT_USAGE, EXIT_OUTPUT_ERROR } = require('./collect');
const {
  loadInput, metricDelta, parseNumberOption, DEFAULT_ALPHA,
} = require('./compare');

const KNOWN_KEYS = new Set(['baseline', 'candidate', 'output', 'margin-percent', 'alpha']);

const DEFAULT_MARGIN_PERCENT = 5;

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// 零方差（Welch 标准误为 0）退化情形的单侧检验结果。
// numerator 为 t 统计量分子（lower 为 diff+margin，upper 为 diff-margin）：
// 为 0（差值恰在边界）时 t 退化为 0、p 为 1；否则 t 为无穷（以 null 表示），
// p 按方向取 0 或 1——lower 检验分子为正 -> 0，upper 检验分子为负 -> 0。
function degenerateOneSided(numerator, side) {
  if (numerator === 0) {
    return { t_statistic: 0, degrees_of_freedom: null, p_value: 1 };
  }
  const p = side === 'lower' ? (numerator > 0 ? 0 : 1) : (numerator < 0 ? 0 : 1);
  return { t_statistic: null, degrees_of_freedom: null, p_value: p };
}

// TOST 两个单侧 Welch 检验：lower 检验差值高于 -margin（p 取右尾），
// upper 检验差值低于 +margin（p 取左尾）；t 统计量分别为
// (diff+margin)/se 与 (diff-margin)/se，自由度沿用 Welch。
// stats 为 welchStandardError 的结果。
function equivalenceTest(stats, marginNs) {
  const { diff, standardError, degreesOfFreedom } = stats;
  if (standardError === 0) {
    return {
      lower: degenerateOneSided(diff + marginNs, 'lower'),
      upper: degenerateOneSided(diff - marginNs, 'upper'),
    };
  }
  const df = degreesOfFreedom;
  const tLower = (diff + marginNs) / standardError;
  const tUpper = (diff - marginNs) / standardError;
  return {
    lower: {
      t_statistic: round6(tLower),
      degrees_of_freedom: round6(df),
      p_value: round6(1 - tCdf(df, tLower)),
    },
    upper: {
      t_statistic: round6(tUpper),
      degrees_of_freedom: round6(df),
      p_value: round6(tCdf(df, tUpper)),
    },
  };
}

// decision 口径：两个单侧 p_value 均 <= alpha 为 equivalent；
// 1 - upper.p_value <= alpha 为 above_margin（差值显著高于正 margin）；
// 1 - lower.p_value <= alpha 为 below_margin（差值显著低于负 margin）；
// 否则 inconclusive。
function decideEquivalence(lowerP, upperP, alpha) {
  if (lowerP <= alpha && upperP <= alpha) return 'equivalent';
  if (1 - upperP <= alpha) return 'above_margin';
  if (1 - lowerP <= alpha) return 'below_margin';
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

  const marginR = parseNumberOption(values, 'margin-percent', {
    defaultValue: DEFAULT_MARGIN_PERCENT,
    check: (v) => v > 0,
    describe: '为大于 0 的数',
  });
  if (marginR.error) {
    return fail(marginR.error);
  }
  const alphaR = parseNumberOption(values, 'alpha', {
    defaultValue: DEFAULT_ALPHA,
    check: (v) => v > 0 && v < 1,
    describe: '满足 0 < alpha < 1',
  });
  if (alphaR.error) {
    return fail(alphaR.error);
  }
  const marginPercent = marginR.value;
  const alpha = alphaR.value;

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
  if (!(baselineSummary.mean > 0)) {
    return fail(`--baseline 均值必须为正（margin 以其为基准），实际为: ${baselineSummary.mean}`);
  }

  // delta.mean：候选均值减基线均值，区间取 1 - 2*alpha 的双侧 Welch 区间
  // （与两个 alpha 水平的单侧检验对偶）。
  const meanDelta = metricDelta(baselineSummary.mean, candidateSummary.mean);
  const interval = welchMeanInterval(baseline.durations, candidate.durations, 2 * alpha);
  meanDelta.confidence_interval = {
    level: round6(interval.level),
    lower_ns: round6(interval.lower_ns),
    upper_ns: round6(interval.upper_ns),
    lower_percent: interval.lower_percent === null ? null : round6(interval.lower_percent),
    upper_percent: interval.upper_percent === null ? null : round6(interval.upper_percent),
  };

  const stats = welchStandardError(baseline.durations, candidate.durations);
  const marginNs = (stats.baselineMean * marginPercent) / 100;
  const test = equivalenceTest(stats, marginNs);
  const decision = decideEquivalence(test.lower.p_value, test.upper.p_value, alpha);

  const result = {
    baseline_summary: baselineSummary,
    candidate_summary: candidateSummary,
    delta: { mean: meanDelta },
    margin: { ns: round6(marginNs), percent: round6(marginPercent) },
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
  equivalenceTest,
  decideEquivalence,
  DEFAULT_MARGIN_PERCENT,
};
