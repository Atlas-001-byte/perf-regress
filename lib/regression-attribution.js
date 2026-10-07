'use strict';

// 回归分组归因：对一次已判定的比较，按分类维度（build/host/scenario 等）
// 独立归因，指出最值得继续排查的样本分组。
//
// 本模块为纯函数库：不执行命令、不读写文件（不新增任何落盘行为），
// 也不改变既有 compare/compare-suite/... 的任何阈值、字段与输出。
// 仅当调用方显式请求归因时才会运行这里的计算。

const { round6, mannWhitneyUTwoSided, holmAdjust } = require('./stats');

const MIN_SIDE_OBSERVATIONS = 3;
const SIGNIFICANCE = 0.05;
const PRIMARY_SHARE = 0.3;
const TIE_TOLERANCE = 1e-12;

class InvalidAttributionInputError extends TypeError {
  constructor(fieldPath, message) {
    super(`无效归因输入（${fieldPath}）: ${message}`);
    this.name = 'InvalidAttributionInputError';
    this.fieldPath = fieldPath;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteString(value) {
  return typeof value === 'string';
}

// 中位数；调用方保证 values 非空且均为有限数字。偶数个取中间两值平均。
function medianOf(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// UTF-8 字节序比较（稳定、与运行时 locale 无关）。
function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// 归一化单个样本的维度字段为按输入顺序排列的 [{ key, value }]。
// 接受两种写法：
//   - 对象映射：{ build: 'b1', host: 'h1' }（JSON 解析后键不可能重复）；
//   - 键值对数组：[{ key: 'build', value: 'b1' }, ...]，
//     同一样本内 key 重复即“重复维度键”错误。
// dimensions 缺省/null 表示该样本不携带任何维度。
function normalizeDimensions(dimensions, samplePath) {
  if (dimensions === undefined || dimensions === null) return [];
  if (Array.isArray(dimensions)) {
    const pairs = [];
    const seen = new Set();
    dimensions.forEach((item, j) => {
      const itemPath = `${samplePath}.dimensions[${j}]`;
      if (!isPlainObject(item)) {
        throw new InvalidAttributionInputError(itemPath, '维度项必须为对象');
      }
      const keyPath = `${itemPath}.key`;
      if (!isFiniteString(item.key) || item.key === '') {
        throw new InvalidAttributionInputError(keyPath, '维度键必须为非空有限字符串');
      }
      if (seen.has(item.key)) {
        throw new InvalidAttributionInputError(keyPath, `维度键重复: ${item.key}`);
      }
      if (!isFiniteString(item.value)) {
        throw new InvalidAttributionInputError(`${itemPath}.value`,
          '维度值必须为有限字符串');
      }
      seen.add(item.key);
      pairs.push({ key: item.key, value: item.value });
    });
    return pairs;
  }
  if (isPlainObject(dimensions)) {
    const pairs = [];
    for (const key of Object.keys(dimensions)) {
      if (key === '') {
        throw new InvalidAttributionInputError(`${samplePath}.dimensions`,
          '维度键不能为空字符串');
      }
      if (!isFiniteString(dimensions[key])) {
        throw new InvalidAttributionInputError(`${samplePath}.dimensions.${key}`,
          '维度值必须为有限字符串');
      }
      pairs.push({ key, value: dimensions[key] });
    }
    return pairs;
  }
  throw new InvalidAttributionInputError(`${samplePath}.dimensions`,
    'dimensions 必须为对象或键值对数组');
}

// 按输入顺序完整校验请求；任何不合口径处抛 InvalidAttributionInputError，
// 异常信息携带第一个按输入顺序出现的字段路径。
// 注意：部分维度值样本不足不属输入错误（在归因阶段标 insufficient_samples）。
// 返回归一化请求；不修改入参。
function validateRequest(request, comparisonRef) {
  if (!isPlainObject(request)) {
    throw new InvalidAttributionInputError('$', '请求必须为对象');
  }
  if (!isFiniteString(request.metric) || request.metric === '') {
    throw new InvalidAttributionInputError('metric', '缺少非空字符串 metric');
  }
  if (!isFiniteString(request.comparison) || request.comparison === '') {
    throw new InvalidAttributionInputError('comparison', '缺少非空字符串 comparison');
  }
  if (comparisonRef !== undefined && comparisonRef !== null) {
    if (isFiniteString(comparisonRef.metric)
      && comparisonRef.metric !== request.metric) {
      throw new InvalidAttributionInputError('metric',
        `metric 与原比较不一致: ${request.metric} != ${comparisonRef.metric}`);
    }
    const refId = comparisonRef.comparison ?? comparisonRef.id;
    if (isFiniteString(refId) && refId !== request.comparison) {
      throw new InvalidAttributionInputError('comparison',
        `comparison 与原比较不一致: ${request.comparison} != ${refId}`);
    }
  }
  if (!Array.isArray(request.samples)) {
    throw new InvalidAttributionInputError('samples', '缺少数组 samples');
  }

  const decision = isFiniteString(request.decision)
    ? request.decision
    : (comparisonRef && isFiniteString(comparisonRef.decision)
      ? comparisonRef.decision : null);

  const samples = [];
  let hasAnyDimension = false;
  request.samples.forEach((sample, i) => {
    const samplePath = `samples[${i}]`;
    if (!isPlainObject(sample)) {
      throw new InvalidAttributionInputError(samplePath, '样本必须为对象');
    }
    if (sample.side !== 'baseline' && sample.side !== 'candidate') {
      throw new InvalidAttributionInputError(`${samplePath}.side`,
        'side 必须为 "baseline" 或 "candidate"');
    }
    if (!Number.isFinite(sample.value)) {
      throw new InvalidAttributionInputError(`${samplePath}.value`,
        '样本 value 必须为有限数字');
    }
    const dims = normalizeDimensions(sample.dimensions, samplePath);
    if (dims.length > 0) hasAnyDimension = true;
    samples.push({ side: sample.side, value: sample.value, dims });
  });

  if (!hasAnyDimension) {
    throw new InvalidAttributionInputError('samples', '整个请求没有任何有效维度值');
  }

  return {
    metric: request.metric,
    comparison: request.comparison,
    decision,
    samples,
  };
}

// 收集维度名（首次出现顺序）与每个维度值两侧的观测值。
function collectGroups(normalized) {
  const dimensionOrder = [];
  const dimensions = new Map();

  for (const sample of normalized.samples) {
    for (const { key, value } of sample.dims) {
      let groups = dimensions.get(key);
      if (groups === undefined) {
        groups = new Map();
        dimensions.set(key, groups);
        dimensionOrder.push(key);
      }
      let group = groups.get(value);
      if (group === undefined) {
        group = { dimensionValue: value, baseline: [], candidate: [] };
        groups.set(value, group);
      }
      group[sample.side].push(sample.value);
    }
  }
  return { dimensionOrder, dimensions };
}

// 单个维度独立归因：纳入两侧均至少 3 个观测的维度值，组内 MWU 双侧 p、
// Holm 校正、贡献值排名与首要归因判定。
function attributeDimension(dimension, groups) {
  const sufficient = [];
  const insufficient = [];

  for (const group of groups.values()) {
    if (group.baseline.length >= MIN_SIDE_OBSERVATIONS
      && group.candidate.length >= MIN_SIDE_OBSERVATIONS) {
      sufficient.push(group);
    } else {
      insufficient.push(group);
    }
  }

  const entries = sufficient.map((group) => {
    const baselineCount = group.baseline.length;
    const candidateCount = group.candidate.length;
    const medianDiff = medianOf(group.candidate) - medianOf(group.baseline);
    const weight = baselineCount + candidateCount;
    const contribution = weight * medianDiff;
    const { p_value: rawPValue } = mannWhitneyUTwoSided(group.baseline, group.candidate);
    return {
      dimensionValue: group.dimensionValue,
      baselineCount,
      candidateCount,
      medianDiff,
      rawPValue,
      weight,
      contribution,
    };
  });

  // 同一维度内 Holm 校正（仅对有效维度值的原始 p 值），校正后保留六位小数，
  // 后续显著性门槛与输出均使用该报告值（与既有 decision 使用报告 p 值的口径一致）。
  const adjustedPValues = holmAdjust(entries.map((e) => e.rawPValue));
  entries.forEach((entry, i) => {
    entry.adjustedPValue = adjustedPValues[i];
  });

  // 首要归因门槛：贡献为正、校正后 p < 0.05、贡献不低于正贡献之和的 30%。
  const positiveSum = entries.reduce(
    (acc, e) => acc + (e.contribution > 0 ? e.contribution : 0), 0);
  const qualifying = entries.filter((e) => e.contribution > 0
    && e.adjustedPValue < SIGNIFICANCE
    && e.contribution >= PRIMARY_SHARE * positiveSum);

  let primaryEntries = [];
  if (qualifying.length > 0) {
    const maxContribution = Math.max(...qualifying.map((e) => e.contribution));
    // 最高项在 1e-12 精度内并列时全部保留，不擅自挑选。
    primaryEntries = qualifying
      .filter((e) => Math.abs(e.contribution - maxContribution) <= TIE_TOLERANCE)
      .sort((a, b) => compareUtf8(a.dimensionValue, b.dimensionValue));
  }
  const primaryValues = new Set(primaryEntries.map((e) => e.dimensionValue));

  const formatEntry = (entry) => ({
    dimension_value: entry.dimensionValue,
    evidence_status: primaryValues.has(entry.dimensionValue)
      ? 'primary_attribution' : 'not_primary',
    baseline_count: entry.baselineCount,
    candidate_count: entry.candidateCount,
    median_diff: round6(entry.medianDiff),
    p_value: round6(entry.rawPValue),
    adjusted_p_value: entry.adjustedPValue,
    weight: entry.weight,
    contribution: round6(entry.contribution),
  });

  // 排名明细：有效项按贡献降序（平手按维度值 UTF-8 字节序），
  // 样本不足项无贡献，统一排在其后并按维度值 UTF-8 字节序。
  const rankedEntries = entries
    .sort((a, b) => (b.contribution - a.contribution)
      || compareUtf8(a.dimensionValue, b.dimensionValue))
    .map(formatEntry);
  const skippedEntries = insufficient
    .sort((a, b) => compareUtf8(a.dimensionValue, b.dimensionValue))
    .map((group) => ({
      dimension_value: group.dimensionValue,
      evidence_status: 'insufficient_samples',
      baseline_count: group.baseline.length,
      candidate_count: group.candidate.length,
      median_diff: null,
      p_value: null,
      adjusted_p_value: null,
      weight: null,
      contribution: null,
    }));

  return {
    dimension,
    evidence_status: primaryEntries.length > 0
      ? 'primary_attribution' : 'insufficient_evidence',
    primary_attributions: primaryEntries.map(formatEntry),
    entries: rankedEntries.concat(skippedEntries),
  };
}

// 回归分组归因入口。
//
// request 结构：
//   { metric: string, comparison: string, decision?: string|null,
//     samples: [{ side: 'baseline'|'candidate', value: number,
//       dimensions?: { <维度名>: <维度值字符串> }
//                  | [{ key: <维度名>, value: <维度值字符串> }] }, ...] }
// decision 为待回显的原比较结论（可为 null）；也可经第二参
// comparisonRef.decision 提供（请求内优先），comparisonRef 的
// metric/comparison（或 id）若存在则用于一致性校验。decision 不参与
// 归因计算，也不在 InvalidAttributionInputError 的校验字段范围内。
//
// 输入不合口径抛 InvalidAttributionInputError（信息含第一个出错字段路径）；
// 无任何维度达标时 evidence_status 为 insufficient_evidence，不是异常。
// 返回结构对同一输入完全确定（顺序、数值、证据状态）。
function attributeRegression(request, comparisonRef) {
  const normalized = validateRequest(request, comparisonRef);
  const { dimensionOrder, dimensions } = collectGroups(normalized);

  const dimensionResults = dimensionOrder.map((dimension) =>
    attributeDimension(dimension, dimensions.get(dimension)));

  const hasPrimary = dimensionResults.some(
    (d) => d.evidence_status === 'primary_attribution');

  return {
    metric: normalized.metric,
    comparison: normalized.comparison,
    decision: normalized.decision,
    evidence_status: hasPrimary ? 'primary_attribution' : 'insufficient_evidence',
    dimensions: dimensionResults,
  };
}

module.exports = {
  attributeRegression,
  InvalidAttributionInputError,
  MIN_SIDE_OBSERVATIONS,
};
