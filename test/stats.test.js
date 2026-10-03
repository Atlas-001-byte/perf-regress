'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeSummary, welchTest } = require('../lib/stats');
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
