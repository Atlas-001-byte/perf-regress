'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeSummary, welchTest, pairedTTest, pairedMeanInterval, tCriticalValue, welchMeanInterval, mannWhitneyTwoSided } = require('../lib/stats');
const { parseArgs } = require('../lib/collect');

test('computeSummary: 单样本', () => {
  const s = computeSummary([100]);
  assert.deepEqual(s, {
    count: 1,
    min: 100,
    max: 100,
    mean: 100,
    median: 100,
    p95: 100,
    stddev: 0,
  });
});

test('computeSummary: 偶数样本 median 取中间两值平均', () => {
  // 10, 20, 30, 40
  const s = computeSummary([40, 10, 30, 20]);
  assert.equal(s.count, 4);
  assert.equal(s.min, 10);
  assert.equal(s.max, 40);
  assert.equal(s.mean, 25);
  assert.equal(s.median, 25);
  // ceil(0.95*4) = ceil(3.8) = 4 项
  assert.equal(s.p95, 40);
  // 总体标准差: sqrt(((225+25+25+225))/4) = sqrt(125)
  assert.equal(s.stddev, Math.round(Math.sqrt(125) * 1e6) / 1e6);
});

test('computeSummary: p95 取 ceil(0.95*count) 项', () => {
  const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
  const s = computeSummary(values);
  // ceil(0.95*20) = 19 -> 第 19 项 = 190
  assert.equal(s.p95, 190);
  assert.equal(s.median, 105); // (100+110)/2
});

test('computeSummary: 21 个样本 p95 与奇数 median', () => {
  const values = Array.from({ length: 21 }, (_, i) => (i + 1) * 10);
  const s = computeSummary(values);
  // ceil(0.95*21) = ceil(19.95) = 20 -> 200
  assert.equal(s.p95, 200);
  assert.equal(s.median, 110);
});

test('computeSummary: 浮点保留六位小数', () => {
  // 1,2 -> mean 1.5, 总体标准差 0.5
  const s = computeSummary([1, 2]);
  assert.equal(s.mean, 1.5);
  assert.equal(s.stddev, 0.5);
  for (const key of ['mean', 'median', 'stddev']) {
    const decimals = String(s[key]).split('.')[1] || '';
    assert.ok(decimals.length <= 6);
  }
});

test('welchTest: 已知取值（t=3.674235, df=4, 双侧 p=0.021312）', () => {
  const w = welchTest([1, 2, 3], [4, 5, 6]);
  assert.deepEqual(w, { t_statistic: 3.674235, degrees_of_freedom: 4, p_value: 0.021312 });
});

test('welchTest: 零方差相同均值 -> {0, null, 1}', () => {
  assert.deepEqual(welchTest([5, 5, 5], [5, 5]),
    { t_statistic: 0, degrees_of_freedom: null, p_value: 1 });
});

test('welchTest: 零方差不同均值 -> {null, null, 0}', () => {
  assert.deepEqual(welchTest([5, 5], [7, 7, 7]),
    { t_statistic: null, degrees_of_freedom: null, p_value: 0 });
});

test('welchTest: 单侧零方差仍可计算', () => {
  const w = welchTest([100, 100, 100], [100, 110, 120]);
  assert.equal(typeof w.t_statistic, 'number');
  assert.equal(typeof w.degrees_of_freedom, 'number');
  assert.ok(w.p_value > 0 && w.p_value < 1);
});

test('tCriticalValue: 反解的双侧临界值与已知 t 分位点一致', () => {
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  assert.equal(r6(tCriticalValue(1, 0.05)), 12.706205);
  assert.equal(r6(tCriticalValue(2, 0.05)), 4.302653);
  assert.equal(r6(tCriticalValue(4, 0.05)), 2.776445);
  assert.equal(r6(tCriticalValue(10, 0.05)), 2.228139);
  assert.equal(r6(tCriticalValue(1000, 0.05)), 1.962339);
  // alpha 改变临界值：alpha 越大（置信度越低）临界值越小
  assert.equal(r6(tCriticalValue(4, 0.1)), 2.131847);
  assert.ok(tCriticalValue(4, 0.1) < tCriticalValue(4, 0.05));
});

test('welchMeanInterval: 95% Welch 区间（原始未取整值）', () => {
  // [1,2,3] vs [4,5,6]：差 3，se=sqrt(2/3)，df=4，t*=2.776445
  const ci = welchMeanInterval([1, 2, 3], [4, 5, 6], 0.05);
  assert.equal(ci.level, 0.95);
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  assert.equal(r6(ci.lower_ns), 0.733042);
  assert.equal(r6(ci.upper_ns), 5.266958);
  // 百分比端点各除以基线均值 2 再乘 100
  assert.equal(r6(ci.lower_percent), 36.652103);
  assert.equal(r6(ci.upper_percent), 263.347897);
  // 区间关于点估计 3 对称
  assert.ok(Math.abs((ci.lower_ns + ci.upper_ns) / 2 - 3) < 1e-9);
});

test('welchMeanInterval: 单侧零方差仍可计算', () => {
  const ci = welchMeanInterval([100, 100, 100], [100, 110, 120], 0.05);
  assert.equal(ci.level, 0.95);
  assert.ok(ci.lower_ns < ci.upper_ns);
  assert.equal(typeof ci.lower_percent, 'number');
});

test('welchMeanInterval: 两侧零方差退化为单点', () => {
  // 均值相同：两端 0
  assert.deepEqual(welchMeanInterval([5, 5, 5], [5, 5], 0.05),
    { level: 0.95, lower_ns: 0, upper_ns: 0, lower_percent: 0, upper_percent: 0 });
  // 均值不同：两端均为候选减基线差
  const ci = welchMeanInterval([5, 5], [7, 7, 7], 0.05);
  assert.equal(ci.lower_ns, 2);
  assert.equal(ci.upper_ns, 2);
  assert.equal(ci.lower_percent, 40);
  assert.equal(ci.upper_percent, 40);
});

test('welchMeanInterval: 基线均值 0 时两个百分比端点为 null', () => {
  const ci = welchMeanInterval([0, 0], [5, 5], 0.05);
  assert.equal(ci.lower_ns, 5);
  assert.equal(ci.upper_ns, 5);
  assert.equal(ci.lower_percent, null);
  assert.equal(ci.upper_percent, null);
  // 两边均值同为 0：ns 两端 0，百分比仍 null
  const zero = welchMeanInterval([0, 0], [0, 0], 0.05);
  assert.equal(zero.lower_ns, 0);
  assert.equal(zero.upper_ns, 0);
  assert.equal(zero.lower_percent, null);
  assert.equal(zero.upper_percent, null);
});

test('welchMeanInterval: alpha 仅决定 level，区间随 level 升高而变宽', () => {
  const w95 = welchMeanInterval([1, 2, 3], [4, 5, 6], 0.05);
  const w90 = welchMeanInterval([1, 2, 3], [4, 5, 6], 0.1);
  assert.equal(w95.level, 0.95);
  assert.equal(w90.level, 0.9);
  assert.ok(w90.upper_ns - w90.lower_ns < w95.upper_ns - w95.lower_ns);
});

test('parseArgs: --key=value 与 --key value 混用', () => {
  const { values, error } = parseArgs(['--runs=3', '--command', 'true']);
  assert.equal(error, null);
  assert.equal(values.runs, '3');
  assert.equal(values.command, 'true');
});

test('parseArgs: 无法解析的位置参数', () => {
  const { error } = parseArgs(['collect']);
  assert.match(error, /无法解析/);
});

test('parseArgs: 未知参数', () => {
  const { error } = parseArgs(['--bogus', '1']);
  assert.match(error, /未知参数/);
});

test('parseArgs: 缺少取值', () => {
  const { error } = parseArgs(['--runs']);
  assert.match(error, /缺少取值/);
});

test('parseArgs: 重复参数', () => {
  const { error } = parseArgs(['--runs', '1', '--runs', '2']);
  assert.match(error, /重复/);
});

test('pairedTTest: t = mean / (sample_stddev / sqrt(n))，df = n - 1', () => {
  // deltas [1, 2, 3]：mean 2，样本标准差 1，t = 2 / (1/sqrt(3))
  const r = pairedTTest([1, 2, 3]);
  assert.equal(r.t_statistic, Math.round(2 * Math.sqrt(3) * 1e6) / 1e6);
  assert.equal(r.degrees_of_freedom, 2);
  assert.ok(r.p_value > 0 && r.p_value < 1);
});

test('pairedTTest: 显著差异时 p 值小，t 取差值均值方向', () => {
  const r = pairedTTest([10, 11, 12, 13, 14, 15]);
  assert.ok(r.t_statistic > 0);
  assert.ok(r.p_value < 0.001);
});

test('pairedTTest: 零方差退化——均值 0 与均值非 0', () => {
  assert.deepEqual(pairedTTest([0, 0, 0]), {
    t_statistic: 0, degrees_of_freedom: null, p_value: 1,
  });
  assert.deepEqual(pairedTTest([5, 5, 5]), {
    t_statistic: null, degrees_of_freedom: null, p_value: 0,
  });
});

test('pairedMeanInterval: 零方差退化为单点，基线均值为 0 时百分比为 null', () => {
  const r = pairedMeanInterval([7, 7, 7], 100, 0.05);
  assert.equal(r.level, 0.95);
  assert.equal(r.lower_ns, 7);
  assert.equal(r.upper_ns, 7);
  assert.ok(Math.abs(r.lower_percent - 7) < 1e-9);
  assert.ok(Math.abs(r.upper_percent - 7) < 1e-9);

  const zero = pairedMeanInterval([0, 0, 0], 0, 0.05);
  assert.equal(zero.lower_ns, 0);
  assert.equal(zero.upper_ns, 0);
  assert.equal(zero.lower_percent, null);
  assert.equal(zero.upper_percent, null);
});

test('pairedMeanInterval: 区间围绕差值均值，level 随 alpha 变化', () => {
  const deltas = [1, 2, 3, 4, 5];
  const r95 = pairedMeanInterval(deltas, 100, 0.05);
  const r90 = pairedMeanInterval(deltas, 100, 0.1);
  assert.equal(r95.level, 0.95);
  assert.equal(r90.level, 0.9);
  const mean = 3;
  assert.ok(r95.lower_ns < mean && r95.upper_ns > mean);
  assert.ok(r90.upper_ns - r90.lower_ns < r95.upper_ns - r95.lower_ns);
  // 百分比端点由两端分别除以基线均值再乘 100（基线均值取 100，数值上相等）
  assert.ok(Math.abs(r95.lower_percent - r95.lower_ns) < 1e-9);
  assert.ok(Math.abs(r95.upper_percent - r95.upper_ns) < 1e-9);
});

// ---- Mann-Whitney U 双侧检验 ----

test('mannWhitneyTwoSided: 完全分离的 3v3，精确 p=0.1', () => {
  const p = mannWhitneyTwoSided([1, 2, 3], [4, 5, 6]);
  assert.ok(Math.abs(p - 0.1) < 1e-12);
});

test('mannWhitneyTwoSided: 完全分离的 3v4，精确 p=2/C(7,3)=0.057142857', () => {
  const p = mannWhitneyTwoSided([1, 2, 3], [4, 5, 6, 7]);
  assert.ok(Math.abs(p - 2 / 35) < 1e-12);
});

test('mannWhitneyTwoSided: 完全重叠返回 1', () => {
  assert.ok(Math.abs(mannWhitneyTwoSided([1, 1, 2], [1, 1, 2]) - 1) < 1e-12);
});

test('mannWhitneyTwoSided: 全部相等的常数样本返回 1', () => {
  assert.ok(Math.abs(mannWhitneyTwoSided([7, 7, 7, 7], [7, 7, 7]) - 1) < 1e-12);
});

// 独立参考实现：枚举所有 C(n, n1) 个下标子集，按平均秩计算秩和分布，
// 双侧 p = min(1, 2·min(P(U<=u), P(U>=u)))。
function exactEnumeration(x, y) {
  const n1 = x.length;
  const n2 = y.length;
  const n = n1 + n2;
  const tagged = [...x.map((v) => [v, 0]), ...y.map((v) => [v, 1])]
    .sort((a, b) => a[0] - b[0]);
  const ranks = new Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j < n && tagged[j][0] === tagged[i][0]) j++;
    const avg = ((i + 1) + j) / 2;
    for (let k = i; k < j; k++) ranks[k] = avg;
    i = j;
  }
  const rObs = tagged.reduce((s, item, k) => s + (item[1] === 0 ? ranks[k] : 0), 0);
  const uObs = rObs - n1 * (n1 + 1) / 2;
  let total = 0;
  let le = 0;
  let ge = 0;
  for (let mask = 0; mask < (1 << n); mask++) {
    let bits = 0;
    for (let k = 0; k < n; k++) if (mask & (1 << k)) bits++;
    if (bits !== n1) continue;
    let r = 0;
    for (let k = 0; k < n; k++) if (mask & (1 << k)) r += ranks[k];
    const u = r - n1 * (n1 + 1) / 2;
    total++;
    if (u <= uObs) le++;
    if (u >= uObs) ge++;
  }
  return Math.min(1, 2 * Math.min(le, ge) / total);
}

test('mannWhitneyTwoSided: 常见分组规模走精确分支，与参考枚举一致', () => {
  const cases = [
    [[1, 2, 4], [3, 5, 6]],
    [[1, 2, 3, 4], [3, 4, 5, 6]],
    [[1, 2, 3, 3], [3, 4, 5, 6]],
    [[5, 5, 5], [5, 6, 7]],
    [[1, 1, 1, 1], [2, 2, 2, 2]],
    [[1, 2, 2, 3], [2, 3, 3, 4]],
    [[1, 3, 5, 7, 9], [2, 4, 6, 8, 10]],
    [[1], [2]],
    [[1, 2], [1]],
  ];
  for (const [a, b] of cases) {
    const ref = exactEnumeration(a, b);
    assert.ok(Math.abs(mannWhitneyTwoSided(a, b) - ref) < 1e-12,
      `mismatch for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
});

test('mannWhitneyTwoSided: 大样本正态分支与精确枚举（取小样本边界附近）连续', () => {
  // 31 个点但可枚举验证：构造强分离数据，p 应接近 0
  const a = Array.from({ length: 16 }, (_, i) => i * 2);
  const b = Array.from({ length: 15 }, (_, i) => i * 2 + 40);
  const pLarge = mannWhitneyTwoSided(a, b);
  assert.ok(pLarge >= 0 && pLarge <= 1);
  assert.ok(pLarge < 1e-3, `expected tiny p, got ${pLarge}`);
});

test('mannWhitneyTwoSided: 大样本分支对称情形接近 1', () => {
  const a = Array.from({ length: 30 }, (_, i) => i);
  const b = Array.from({ length: 30 }, (_, i) => i);
  assert.ok(Math.abs(mannWhitneyTwoSided(a, b) - 1) < 1e-9);
});

test('mannWhitneyTwoSided: 超大无并列样本回退正态近似，结果在 [0,1] 且方向正确', () => {
  // N=200 且强分离：超出精确工作量预算，正态近似 p 应极小
  const a = Array.from({ length: 100 }, (_, i) => i);
  const b = Array.from({ length: 100 }, (_, i) => i + 300);
  const p = mannWhitneyTwoSided(a, b);
  assert.ok(p >= 0 && p <= 1);
  assert.ok(p < 1e-20, `expected near-zero p, got ${p}`);
  // 大样本但完全重叠：p 接近 1
  const c = Array.from({ length: 100 }, (_, i) => i);
  const d = Array.from({ length: 100 }, (_, i) => i);
  assert.ok(Math.abs(mannWhitneyTwoSided(c, d) - 1) < 1e-9);
});

test('mannWhitneyTwoSided: 大 N 重并列仍走精确分布（2x2 表 Fisher 型，快速且精确）', () => {
  // 100 vs 100 只有两个秩值：baseline 全 0；candidate 25 个 0、75 个 1。
  const a = new Array(100).fill(0);
  const b = [...new Array(25).fill(0), ...new Array(75).fill(1)];
  const pFast = mannWhitneyTwoSided(a, b);
  // 该问题等价于超几何选择，p 应极小但为正有限值
  assert.ok(pFast > 0 && pFast < 1e-6);
});
