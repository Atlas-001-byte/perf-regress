'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeSummary, welchTest, tCriticalValue, welchMeanInterval } = require('../lib/stats');
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
