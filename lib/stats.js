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

// 双侧配对 t 检验：deltas 为逐对候选减基线差值（至少 2 个）。
// t = mean / (sample_stddev / sqrt(count))，degrees_of_freedom = count - 1，
// p 与 welchTest 同一口径：I_{df/(df+t^2)}(df/2, 1/2)。
// 差值零方差的退化情形与 welchTest 一致：均值为 0 -> {0, null, 1}；
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

  const t = m / Math.sqrt(v / n);
  const df = n - 1;
  const p = regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
  return {
    t_statistic: round6(t),
    degrees_of_freedom: df,
    p_value: round6(p),
  };
}

// 配对均值差（候选减基线）的双侧（1 - alpha）区间，内部原始（未取整）值。
// deltas 为至少 2 个逐对差值，0 < alpha < 1；baselineMean 为成对基线样本均值，
// 为 0 时两个百分比端点为 null。差值零方差时区间退化为单点（两端均为差值均值），
// 不反解临界值；与 welchMeanInterval 的退化口径一致。
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
    const margin = tCriticalValue(n - 1, alpha) * Math.sqrt(v / n);
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

// ---- Mann-Whitney U 双侧检验 ----
// 无第三方依赖。小样本（合并后 N <= MWU_EXACT_LIMIT）用精确置换分布
// （子集秩和计数 DP，天然支持并列 midrank）；大样本用含结校正的
// 正态近似（连续性校正 0.5）。

const MWU_EXACT_LIMIT = 40;

// 标准正态 CDF，Phi(z)；大样本 MWU 近似用。erf 取 A&S 7.1.26 近似。
function erfApprox(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(z) {
  return 0.5 * (1 + erfApprox(z / Math.SQRT2));
}

// 合并样本的平均秩（1-based midrank），按升序返回与 values 同序的秩数组。
function averageRanks(values) {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
    // 结占据位置 i+1..j+1，平均秩为 (i+1+j+1)/2
    const avg = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[order[k]] = avg;
    i = j + 1;
  }
  return ranks;
}

// 精确双侧 p：枚举从 N 个位置中取 m 个给 x 的所有 C(N,m) 种等可能分配，
// 统计 |U1 - mn/2| 不小于观测值的分配占比。midrank 乘 2 取整做整数 DP。
// N <= MWU_EXACT_LIMIT 时 C(N,m) <= C(40,20) ≈ 1.38e11 < 2^53，
// 计数用 Number 仍为精确整数。
function mannWhitneyExactP(ranks, m, observedDeviation2) {
  const total = ranks.length;
  const n = total - m;
  const ranks2 = ranks.map((r) => Math.round(r * 2));
  // 2*U1 = s - m(m+1)，s 为所选位置 r2 之和；s 上界为 m*2*(N+1)。
  const maxSum = m * 2 * (total + 1);
  const dp = Array.from({ length: m + 1 }, () => new Float64Array(maxSum + 1));
  const lo = new Int32Array(m + 1).fill(maxSum + 1);
  const hi = new Int32Array(m + 1).fill(-1);
  dp[0][0] = 1;
  lo[0] = 0;
  hi[0] = 0;
  for (let idx = 0; idx < total; idx++) {
    const r2 = ranks2[idx];
    for (let k = Math.min(idx, m - 1); k >= 0; k--) {
      if (hi[k] < 0) continue;
      const layer = dp[k];
      const next = dp[k + 1];
      for (let s = lo[k]; s <= hi[k]; s++) {
        const count = layer[s];
        if (count !== 0) next[s + r2] += count;
      }
      if (lo[k] + r2 < lo[k + 1]) lo[k + 1] = lo[k] + r2;
      if (hi[k] + r2 > hi[k + 1]) hi[k + 1] = hi[k] + r2;
    }
  }
  const base = m * (m + 1); // 2*U1 = s - base；中心 2*(mn/2) = mn
  let favorable = 0;
  let grand = 0;
  for (let s = lo[m]; s <= hi[m]; s++) {
    const count = dp[m][s];
    if (count === 0) continue;
    grand += count;
    if (Math.abs(s - base - n * m) >= observedDeviation2) favorable += count;
  }
  return favorable / grand;
}

// 双侧 Mann-Whitney U 检验：x、y 为观测值数组。
// 返回 { u, z, p_value }：u = min(U1, U2)，U1+U2=m*n；
// 大样本近似时附带 z（精确路径 z 为 null）；p_value 为双侧原始 p（未取整）。
function mannWhitneyUTwoSided(x, y) {
  const m = x.length;
  const n = y.length;
  const total = m + n;
  const values = x.concat(y);
  const ranks = averageRanks(values);
  const rankSumX = ranks.slice(0, m).reduce((acc, r) => acc + r, 0);
  const u1 = rankSumX - m * (m + 1) / 2;
  const u = Math.min(u1, m * n - u1);
  const mean = m * n / 2;

  // 结项 sum(t^3 - t)
  const sortedValues = values.slice().sort((a, b) => a - b);
  let tieTerm = 0;
  for (let i = 0; i < total;) {
    let j = i;
    while (j + 1 < total && sortedValues[j + 1] === sortedValues[i]) j++;
    const t = j - i + 1;
    if (t > 1) tieTerm += t ** 3 - t;
    i = j + 1;
  }
  const variance = (m * n / 12) * (total + 1 - tieTerm / (total * (total - 1)));

  // 全部观测并列：分布无方差，U1 必在中心 -> p=1。
  if (variance === 0) {
    return { u, z: null, p_value: u1 === mean ? 1 : 0 };
  }

  if (total <= MWU_EXACT_LIMIT) {
    const observed2 = Math.abs(u1 - mean) * 2; // 乘 2 单位下观测到的偏离
    return { u, z: null, p_value: mannWhitneyExactP(ranks, m, observed2) };
  }

  const sd = Math.sqrt(variance);
  const numerator = Math.max(0, Math.abs(u1 - mean) - 0.5);
  const z = numerator / sd;
  return { u, z, p_value: Math.min(1, 2 * (1 - normalCdf(z))) };
}

// Holm（Holm–Bonferroni）逐步向下校正：m 个 p 升序后记 p_(1)<=...<=p_(m)，
// 调整值 q_(i) = min(1, max over j<=i ((m-j+1)*p_(j)))，映回原序，
// 保留六位小数。p 相同按原序稳定打破平局。
function holmAdjust(pValues) {
  const m = pValues.length;
  const order = Array.from({ length: m }, (_, i) => i)
    .sort((a, b) => (pValues[a] - pValues[b]) || (a - b));
  const adjusted = new Array(m);
  let running = 0;
  for (let rank = 1; rank <= m; rank++) {
    const index = order[rank - 1];
    running = Math.max(running, (m - rank + 1) * pValues[index]);
    adjusted[index] = round6(Math.min(1, running));
  }
  return adjusted;
}

module.exports = {
  computeSummary,
  round6,
  welchTest,
  pairedTTest,
  pairedMeanInterval,
  tCriticalValue,
  welchMeanInterval,
  mannWhitneyUTwoSided,
  holmAdjust,
};
