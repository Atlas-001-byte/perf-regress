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

// ---- Welch t 检验 ----

// Lanczos 近似的 log Gamma 函数
function logGamma(z) {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const w = z - 1;
  let x = c[0];
  for (let i = 1; i < c.length; i++) x += c[i] / (w + i);
  const t = w + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (w + 0.5) * Math.log(t) - t + Math.log(x);
}

// 不完全 Beta 函数的连分式求值（Numerical Recipes betacf）
function betaContinuedFraction(a, b, x) {
  const MAXIT = 200;
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
  for (let m = 1; m <= MAXIT; m++) {
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

// 正则化不完全 Beta 函数 I_x(a, b)
function regularizedIncompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

// t 分布（df 自由度）双侧 p 值：P(|T| >= t)
function tDistTwoTailedP(t, df) {
  const x = df / (df + t * t);
  return regularizedIncompleteBeta(x, df / 2, 0.5);
}

// 样本方差（无偏，n-1）；调用方保证 values.length >= 2
function sampleVariance(values, avg) {
  let acc = 0;
  for (const v of values) {
    const d = v - avg;
    acc += d * d;
  }
  return acc / (values.length - 1);
}

// 双侧 Welch t 检验，t 统计量方向为 candidate - baseline。
// 两边样本方差均为 0 时无法按常规定义：
//   均值相同 -> { t_statistic: 0, degrees_of_freedom: null, p_value: 1 }
//   均值不同 -> { t_statistic: null, degrees_of_freedom: null, p_value: 0 }
// 其余情况各浮点字段保留六位小数。
function welchTTest(baseline, candidate) {
  const n1 = baseline.length;
  const n2 = candidate.length;
  const m1 = meanOf(baseline);
  const m2 = meanOf(candidate);
  const v1 = sampleVariance(baseline, m1);
  const v2 = sampleVariance(candidate, m2);
  if (v1 === 0 && v2 === 0) {
    return m1 === m2
      ? { t_statistic: 0, degrees_of_freedom: null, p_value: 1 }
      : { t_statistic: null, degrees_of_freedom: null, p_value: 0 };
  }
  const s1 = v1 / n1;
  const s2 = v2 / n2;
  const t = (m2 - m1) / Math.sqrt(s1 + s2);
  const df = (s1 + s2) ** 2 / ((s1 * s1) / (n1 - 1) + (s2 * s2) / (n2 - 1));
  const p = tDistTwoTailedP(Math.abs(t), df);
  return {
    t_statistic: round6(t),
    degrees_of_freedom: round6(df),
    p_value: round6(p),
  };
}

module.exports = { computeSummary, round6, welchTTest, tDistTwoTailedP };
