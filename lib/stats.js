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
// 无第三方依赖。优先按秩和分布精确计算：合并排序后按相等值分 tie 组取平均秩，
// 以动态规划枚举 A 侧（baseline）从各 tie 组中选取 k 个的组合数，得到 A 侧
// 秩和 R（等价于 U = R - n1(n1+1)/2）的分布，双侧 p 取
// min(1, 2·min(P(U <= U_obs), P(U >= U_obs)))：两倍较小尾概率（精确置换分布
// 下 Mann-Whitney 双侧检验的通用约定）。
//
// DP 状态数随样本量三次方增长，因此按工作量自适应：转换数在预算内（小样本，
// 或大样本但并列很多导致秩空间被压缩）时给精确值；超出预算或计数溢出时回退到
// tie 校正正态近似（含连续性校正）：
//   z = (|U - n1*n2/2| - 0.5) / sigma，sigma^2 含 Σ(t^3-t) tie 修正，
//   双侧 p = erfc(z / sqrt(2))。
//
// 精确计数用 Number：恒为非负计数的线性累加（无抵消），比值相对误差约
// O(n·eps)；仅当计数超过安全范围（MW_EXACT_COUNT_MAX）时才回退，避免大组合数
// 下整数舍入放大。

const MW_EXACT_TRANSITION_BUDGET = 100_000;
const MW_EXACT_COUNT_MAX = 1e15;

// 互补误差函数 erfc(x)，Abramowitz-Stegun 7.1.26（相对误差 < 1.5e-7）。
// 仅用于大样本正态近似尾概率。
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const tau = t * Math.exp(
    -z * z - 1.26551223
      + t * (1.00002368
        + t * (0.37409196
          + t * (0.09678418
            + t * (-0.18628806
              + t * (0.27886807
                + t * (-1.13520398
                  + t * (1.48851587
                    + t * (-0.82215223
                      + t * 0.17087277)))))))),
  );
  return x >= 0 ? tau : 2 - tau;
}

// 组合数 C(n, k)（Number）。仅在小 n 上调用，调用方另做溢出检查。
function binomialCount(n, k) {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let num = 1;
  let den = 1;
  for (let i = 0; i < kk; i++) {
    num *= n - i;
    den *= i + 1;
  }
  return num / den;
}

// 返回双侧 p 值（内部原始值，未取整）。baseline/candidate 均为数值数组，
// 可含并列；调用方保证两侧均至少 1 个观测。
function mannWhitneyTwoSided(baseline, candidate) {
  const n1 = baseline.length;
  const n2 = candidate.length;
  const n = n1 + n2;

  // 合并排序并按相等值分 tie 组：{ size, avgRank, aObserved }。
  const merged = [];
  for (const v of baseline) merged.push({ v, side: 1 });
  for (const v of candidate) merged.push({ v, side: 2 });
  merged.sort((a, b) => a.v - b.v);
  const tieGroups = [];
  for (let i = 0; i < merged.length;) {
    let j = i;
    while (j < merged.length && merged[j].v === merged[i].v) j++;
    const size = j - i;
    // 该 tie 组占据秩 i+1 .. j（1-based）
    const avgRank = ((i + 1) + j) / 2;
    let a = 0;
    for (let k = i; k < j; k++) {
      if (merged[k].side === 1) a++;
    }
    tieGroups.push({ size, avgRank, aObserved: a });
    i = j;
  }

  // 观测到的 A 侧秩和与 U
  let rObserved = 0;
  for (const g of tieGroups) rObserved += g.aObserved * g.avgRank;
  const uObserved = rObserved - (n1 * (n1 + 1)) / 2;

  // 自适应精确 DP：layers 按已选 A 侧个数分层 Map(chosen -> Map(秩和 -> 计数))，
  // 最终只统计 chosen === n1 的配置。转换数超预算或计数超安全范围则放弃精确解。
  let layers = new Map([[0, new Map([[0, 1]])]]);
  let transitions = 0;
  let exactUsable = true;
  let aborted = false;

  outer:
  for (const g of tieGroups) {
    const next = new Map();
    for (const [chosen, sums] of layers) {
      for (const [sum, cnt] of sums) {
        for (let k = 0; k <= g.size; k++) {
          const newChosen = chosen + k;
          if (newChosen > n1) break;
          let layer = next.get(newChosen);
          if (!layer) {
            layer = new Map();
            next.set(newChosen, layer);
          }
          const ways = cnt * binomialCount(g.size, k);
          if (!Number.isFinite(ways) || ways > MW_EXACT_COUNT_MAX) {
            exactUsable = false;
            break outer;
          }
          const key = sum + k * g.avgRank;
          const mergedCount = (layer.get(key) || 0) + ways;
          if (mergedCount > MW_EXACT_COUNT_MAX) {
            exactUsable = false;
            break outer;
          }
          layer.set(key, mergedCount);
          transitions++;
          if (transitions > MW_EXACT_TRANSITION_BUDGET) {
            aborted = true;
            break outer;
          }
        }
      }
    }
    layers = next;
  }

  if (exactUsable && !aborted) {
    const valid = layers.get(n1);
    if (valid) {
      let total = 0;
      let lowerOrEqual = 0;
      let greaterOrEqual = 0;
      for (const [sum, cnt] of valid) {
        total += cnt;
        if (sum <= rObserved) lowerOrEqual += cnt;
        if (sum >= rObserved) greaterOrEqual += cnt;
      }
      if (total > 0) {
        const p = 2 * Math.min(lowerOrEqual / total, greaterOrEqual / total);
        return p > 1 ? 1 : p;
      }
    }
    return 1;
  }

  // tie 校正正态近似。
  const meanU = (n1 * n2) / 2;
  let tieTerm = 0;
  for (const g of tieGroups) {
    tieTerm += g.size ** 3 - g.size;
  }
  const variance = (n1 * n2 / 12) * ((n + 1) - tieTerm / (n * (n - 1)));
  if (variance <= 0) {
    return uObserved === meanU ? 1 : 0;
  }
  let z = (Math.abs(uObserved - meanU) - 0.5) / Math.sqrt(variance);
  if (z < 0) z = 0;
  const p = erfc(z / Math.SQRT2);
  return p > 1 ? 1 : p;
}

module.exports = {
  computeSummary,
  round6,
  welchTest,
  pairedTTest,
  pairedMeanInterval,
  tCriticalValue,
  welchMeanInterval,
  mannWhitneyTwoSided,
};
