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

module.exports = { computeSummary, round6 };
