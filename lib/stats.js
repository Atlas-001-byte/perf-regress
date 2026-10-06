'use strict';

// 按 duration_ns 计算基准统计量。
// 入参为已升序排序的整数数组（至少 1 个样本）。
// 浮点结果保留六位小数。

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function meanOf(values) {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function medianOfSorted(sorted) {
  const n = sorted.length;
  const mid = n >> 1;
  if (n % 2 === 1) return sorted[mid];
  // 偶数样本取中间两值平均（可能为 x.5，无需 round6 也会被统一处理）
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95OfSorted(sorted) {
  const n = sorted.length;
  // 排序后第 ceil(0.95 * count) 项（1-based -> 转 0-based）
  const rank = Math.ceil(0.95 * n);
  return sorted[rank - 1];
}

function stddevPopulation(values, avg) {
  let acc = 0;
  for (const v of values) {
    const d = v - avg;
    acc += d * d;
  }
  return Math.sqrt(acc / values.length);
}

function computeSummary(durations) {
  const sorted = durations.slice().sort((a, b) => a - b);
  const count = sorted.length;
  const min = sorted[0];
  const max = sorted[count - 1];
  const mean = meanOf(sorted);
  const median = medianOfSorted(sorted);
  const p95 = p95OfSorted(sorted);
  const stddev = stddevPopulation(sorted, mean);
  return {
    count,
    min,
    max,
    mean: round6(mean),
    median: round6(median),
    p95,
    stddev: round6(stddev),
  };
}

// ---- Welch 双侧 t 检验 ----
// 无第三方依赖，t 分布 CDF 经正则化不完全 beta 函数求得：
// 双侧 p = I_{df/(df+t^2)}(df/2, 1/2)。

// Lanczos 近似系数（g = 7, n = 9）
const LANCZOS = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function logGamma(z) {
  if (z < 0.5) {
    // 反射公式
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const w = z - 1;
  let x = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) {
    x += LANCZOS[i] / (w + i);
  }
  const t = w + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (w + 0.5) * Math.log(t) - t + Math.log(x);
}

// Lentz 连分式求值（Numerical Recipes betacf）
function betaContinuedFraction(a, b, x) {
  const MAX_ITER = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// 正则化不完全 beta 函数 I_x(a, b)
function regularizedIncompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront =
    a * Math.log(x) + b * Math.log(1 - x) +
    logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(lnFront);
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

// 样本方差（无偏，除以 n-1）；调用方保证 values.length >= 2
function sampleVariance(values, avg) {
  let acc = 0;
  for (const v of values) {
    const d = v - avg;
    acc += d * d;
  }
  return acc / (values.length - 1);
}

// 双侧 Welch t 检验：baseline 与 candidate 均为至少 2 个样本的数组。
// t 取候选减基线方向。返回保留六位小数的
// { t_statistic, degrees_of_freedom, p_value }。
// 两边方差均为 0 的退化情形：均值相同 -> {0, null, 1}；均值不同 -> {null, null, 0}。
function welchTest(baseline, candidate) {
  const n1 = baseline.length;
  const n2 = candidate.length;
  const m1 = meanOf(baseline);
  const m2 = meanOf(candidate);
  const v1 = sampleVariance(baseline, m1);
  const v2 = sampleVariance(candidate, m2);

  if (v1 === 0 && v2 === 0) {
    if (m1 === m2) {
      return { t_statistic: 0, degrees_of_freedom: null, p_value: 1 };
    }
    return { t_statistic: null, degrees_of_freedom: null, p_value: 0 };
  }

  const s1 = v1 / n1;
  const s2 = v2 / n2;
  const t = (m2 - m1) / Math.sqrt(s1 + s2);
  const df = (s1 + s2) ** 2 / (s1 ** 2 / (n1 - 1) + s2 ** 2 / (n2 - 1));
  const p = regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
  return {
    t_statistic: round6(t),
    degrees_of_freedom: round6(df),
    p_value: round6(p),
  };
}

// t 分布双侧尾概率：给定自由度 df 与 t >= 0，返回 P(|T| >= t)。
// 与 welchTest 的 p 值同一口径：I_{df/(df+t^2)}(df/2, 1/2)。
function tTwoTailedP(df, t) {
  return regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
}

// 反解双侧临界值 t*（t* >= 0），使 tTwoTailedP(df, t*) = twoTailedP。
// t>=0 上双侧尾概率随 t 严格单调递减：先倍增找上界，再二分收敛。
// 调用方保证 df > 0、0 < twoTailedP < 1。
function tCriticalValue(df, twoTailedP) {
  let hi = 1;
  while (tTwoTailedP(df, hi) > twoTailedP) {
    hi *= 2;
  }
  let lo = 0;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoTailedP(df, mid) > twoTailedP) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

// 候选均值减基线均值差的双侧 Welch（1 - alpha）区间，内部原始（未取整）值。
// baseline 与 candidate 均为至少 2 个样本的数组，0 < alpha < 1。
// 返回 { level, lower_ns, upper_ns, lower_percent, upper_percent }；
// 基线均值为 0 时两个百分比端点为 null。
// 两边方差均为 0 的退化情形：区间退化为单点，两端均为候选减基线均值
// （均值相同即两端为 0），不反解临界值；welch 与 decision 仍走 welchTest 口径。
function welchMeanInterval(baseline, candidate, alpha) {
  const n1 = baseline.length;
  const n2 = candidate.length;
  const m1 = meanOf(baseline);
  const m2 = meanOf(candidate);
  const v1 = sampleVariance(baseline, m1);
  const v2 = sampleVariance(candidate, m2);
  const diff = m2 - m1;

  let lower;
  let upper;
  if (v1 === 0 && v2 === 0) {
    lower = diff;
    upper = diff;
  } else {
    const s1 = v1 / n1;
    const s2 = v2 / n2;
    const standardError = Math.sqrt(s1 + s2);
    const df = (s1 + s2) ** 2 / (s1 ** 2 / (n1 - 1) + s2 ** 2 / (n2 - 1));
    const margin = tCriticalValue(df, alpha) * standardError;
    lower = diff - margin;
    upper = diff + margin;
  }

  return {
    level: 1 - alpha,
    lower_ns: lower,
    upper_ns: upper,
    lower_percent: m1 === 0 ? null : (lower / m1) * 100,
    upper_percent: m1 === 0 ? null : (upper / m1) * 100,
  };
}

// ---- 配对（成对）双侧 t 检验 ----
// 入参为同一轮次两侧之差（候选减基线），数组长度即完整 pairs 数（>= 2）。
// t = mean / (sample_stddev / sqrt(count))，自由度 count - 1。
// 零方差退化与 welchTest 同语义：均值为 0 -> {0, null, 1}；
// 均值非 0 -> {null, null, 0}。
function pairedTTest(deltas) {
  const n = deltas.length;
  const m = meanOf(deltas);
  const v = sampleVariance(deltas, m);

  if (v === 0) {
    if (m === 0) {
      return { t_statistic: 0, degrees_of_freedom: null, p_value: 1 };
    }
    return { t_statistic: null, degrees_of_freedom: null, p_value: 0 };
  }

  const df = n - 1;
  const t = m / (Math.sqrt(v) / Math.sqrt(n));
  const p = regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
  return {
    t_statistic: round6(t),
    degrees_of_freedom: df,
    p_value: round6(p),
  };
}

// 配对均值差的双侧（1 - alpha）区间，内部原始（未取整）值。
// deltas 为至少 2 个差值的数组，0 < alpha < 1。
// 返回 { level, lower_ns, upper_ns, lower_percent, upper_percent }；
// 百分比由两端分别除以基线均值再乘 100，基线均值为 0 时两端为 null。
// 零方差退化与 welchMeanInterval 同语义：区间退化为单点（即均值差），
// 不反解临界值；t_test 与 decision 仍走 pairedTTest 口径。
function pairedMeanInterval(deltas, baselineMean, alpha) {
  const n = deltas.length;
  const m = meanOf(deltas);
  const v = sampleVariance(deltas, m);

  let lower;
  let upper;
  if (v === 0) {
    lower = m;
    upper = m;
  } else {
    const standardError = Math.sqrt(v) / Math.sqrt(n);
    const margin = tCriticalValue(n - 1, alpha) * standardError;
    lower = m - margin;
    upper = m + margin;
  }

  return {
    level: 1 - alpha,
    lower_ns: lower,
    upper_ns: upper,
    lower_percent: baselineMean === 0 ? null : (lower / baselineMean) * 100,
    upper_percent: baselineMean === 0 ? null : (upper / baselineMean) * 100,
  };
}

module.exports = {
  computeSummary,
  round6,
  welchTest,
  tCriticalValue,
  welchMeanInterval,
  pairedTTest,
  pairedMeanInterval,
};
