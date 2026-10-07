'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  attributeRegression,
  InvalidAttributionInputError,
  MIN_SIDE_OBSERVATIONS,
} = require('../lib/regression-attribution');

// 构造 n 个围绕 center、完全落在 [lo, hi] 内的观测。
function around(center, n, spread = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(center + ((i % (2 * spread + 1)) - spread));
  }
  return out;
}

// 按组拼出样本：groups 为 [{ value, side, dims }...] 更底层的直接构造。
function sample(side, value, dimensions) {
  return { side, value, dimensions };
}

// 为某维度值追加两侧样本（对象映射写法）。
function groupSamples(dimension, dimValue, baselineValues, candidateValues) {
  const out = [];
  for (const value of baselineValues) {
    out.push(sample('baseline', value, { [dimension]: dimValue }));
  }
  for (const value of candidateValues) {
    out.push(sample('candidate', value, { [dimension]: dimValue }));
  }
  return out;
}

const REGRESSION_REQUEST = {
  metric: 'duration_ns',
  comparison: 'cmp-1',
  decision: 'regression',
};

test('基本归因：显著正贡献维度值标 primary_attribution，结果保留原比较结论', () => {
  // b1 完全分离 n=m=5：原始 p=2/C(10,5)=0.007937，单维度两个有效值 Holm 后
  // 0.015873 < 0.05；medianDiff=100，weight=10，contribution=1000。
  // b2 两侧几乎相同：无正贡献。
  const samples = [
    ...groupSamples('build', 'b1', around(100, 5), around(200, 5)),
    ...groupSamples('build', 'b2', around(100, 5), around(100, 5)),
  ];
  const result = attributeRegression({ ...REGRESSION_REQUEST, samples });

  assert.equal(result.metric, 'duration_ns');
  assert.equal(result.comparison, 'cmp-1');
  assert.equal(result.decision, 'regression'); // 原比较结论保留
  assert.equal(result.evidence_status, 'primary_attribution');
  assert.equal(result.dimensions.length, 1);

  const dim = result.dimensions[0];
  assert.equal(dim.dimension, 'build');
  assert.equal(dim.evidence_status, 'primary_attribution');
  assert.deepEqual(dim.entries.map((e) => e.dimension_value), ['b1', 'b2']);

  const b1 = dim.entries[0];
  assert.deepEqual(Object.keys(b1), [
    'dimension_value', 'evidence_status', 'baseline_count', 'candidate_count',
    'median_diff', 'p_value', 'adjusted_p_value', 'weight', 'contribution',
  ]);
  assert.equal(b1.dimension_value, 'b1');
  assert.equal(b1.evidence_status, 'primary_attribution');
  assert.equal(b1.baseline_count, 5);
  assert.equal(b1.candidate_count, 5);
  assert.equal(b1.median_diff, 100);
  assert.equal(b1.weight, 10);
  assert.equal(b1.contribution, 1000);
  assert.ok(Math.abs(b1.p_value - 2 / 252) < 1e-6);
  assert.ok(b1.adjusted_p_value < 0.05);
  assert.ok(b1.adjusted_p_value >= b1.p_value - 1e-9);

  const b2 = dim.entries[1];
  assert.equal(b2.evidence_status, 'not_primary');
  assert.equal(b2.contribution, 0);

  assert.deepEqual(dim.primary_attributions.map((e) => e.dimension_value), ['b1']);
});

test('无显著正贡献：所有维度 evidence_status 为 insufficient_evidence（非异常）', () => {
  // scenario 两个有效值两侧均高度重叠 -> MWU 不显著。
  const samples = [
    ...groupSamples('scenario', 's1', around(100, 5), around(100, 5)),
    ...groupSamples('scenario', 's2', around(100, 5), around(101, 5)),
  ];
  const result = attributeRegression({ ...REGRESSION_REQUEST, samples });
  assert.equal(result.evidence_status, 'insufficient_evidence');
  const dim = result.dimensions[0];
  assert.equal(dim.evidence_status, 'insufficient_evidence');
  assert.equal(dim.primary_attributions.length, 0);
  assert.ok(dim.entries.every((e) => e.evidence_status === 'not_primary'));
});

test('样本不足的维度值标 insufficient_samples，不阻断其他维度值', () => {
  // h1 充分且显著；h2 候选侧仅 2 个观测 -> 跳过并标 insufficient_samples。
  const samples = [
    ...groupSamples('host', 'h1', around(100, 5), around(200, 5)),
    ...groupSamples('host', 'h2', around(100, 5), [100, 102]),
  ];
  const result = attributeRegression({ ...REGRESSION_REQUEST, samples });
  const dim = result.dimensions[0];
  assert.equal(dim.evidence_status, 'primary_attribution');
  const [h1, h2] = dim.entries;
  assert.equal(h1.dimension_value, 'h1');
  assert.equal(h1.evidence_status, 'primary_attribution');
  // Holm 仅对一个有效值：校正后即原始 p
  assert.ok(Math.abs(h1.adjusted_p_value - 2 / 252) < 1e-6);

  assert.equal(h2.dimension_value, 'h2');
  assert.equal(h2.evidence_status, 'insufficient_samples');
  assert.equal(h2.baseline_count, 5);
  assert.equal(h2.candidate_count, 2);
  assert.equal(h2.median_diff, null);
  assert.equal(h2.p_value, null);
  assert.equal(h2.adjusted_p_value, null);
  assert.equal(h2.weight, null);
  assert.equal(h2.contribution, null);
});

test('某维度所有值样本都不足时该维度仍输出，证据状态 insufficient_evidence', () => {
  const samples = [
    ...groupSamples('host', 'h1', [1, 2], around(200, 5)),
    ...groupSamples('host', 'h2', around(100, 5), [1]),
  ];
  const result = attributeRegression({ ...REGRESSION_REQUEST, samples });
  assert.equal(result.evidence_status, 'insufficient_evidence');
  const dim = result.dimensions[0];
  assert.equal(dim.entries.length, 2);
  assert.ok(dim.entries.every((e) => e.evidence_status === 'insufficient_samples'));
  assert.equal(dim.primary_attributions.length, 0);
});

test('30% 占比门槛：四个等正贡献值各占 25%，无一成为首要归因', () => {
  // 四个值各 n=m=5 完全分离、中位数差同为 100；Holm 同 p 校正后 0.031746 仍
  // 显著，但每个贡献仅占正贡献之和的 25% (< 30%)。
  const samples = [];
  for (const g of ['g1', 'g2', 'g3', 'g4']) {
    samples.push(...groupSamples('build', g, around(100, 5), around(200, 5)));
  }
  const result = attributeRegression({ ...REGRESSION_REQUEST, samples });
  const dim = result.dimensions[0];
  assert.equal(dim.evidence_status, 'insufficient_evidence');
  assert.ok(dim.entries.every((e) => e.evidence_status === 'not_primary'));
  assert.equal(dim.primary_attributions.length, 0);
});

test('最高贡献在 1e-12 内并列：全部列为首要归因候选，按维度值 UTF-8 字节序', () => {
  // "b10" 的 UTF-8 字节序在 "b2" 之前（'1' < '2'），两值贡献完全相等。
  const samples = [
    ...groupSamples('build', 'b2', around(100, 5), around(200, 5)),
    ...groupSamples('build', 'b10', around(100, 5), around(200, 5)),
  ];
  const result = attributeRegression({ ...REGRESSION_REQUEST, samples });
  const dim = result.dimensions[0];
  assert.equal(dim.evidence_status, 'primary_attribution');
  // 明细按贡献降序、平手按 UTF-8 字节序
  assert.deepEqual(dim.entries.map((e) => e.dimension_value), ['b10', 'b2']);
  assert.ok(dim.entries.every((e) => e.evidence_status === 'primary_attribution'));
  assert.deepEqual(dim.primary_attributions.map((e) => e.dimension_value), ['b10', 'b2']);
});

test('多维度独立归因：维度按首次出现顺序排列，整体证据状态取任一命中', () => {
  const samples = [
    ...groupSamples('build', 'b1', around(100, 5), around(200, 5)),
    ...groupSamples('scenario', 's1', around(100, 5), around(100, 5)),
  ];
  const result = attributeRegression({ ...REGRESSION_REQUEST, samples });
  assert.deepEqual(result.dimensions.map((d) => d.dimension), ['build', 'scenario']);
  assert.equal(result.evidence_status, 'primary_attribution');
  assert.equal(result.dimensions[0].evidence_status, 'primary_attribution');
  assert.equal(result.dimensions[1].evidence_status, 'insufficient_evidence');
});

test('样本可携带多个维度；某样本不携带某维度时不计入该维度', () => {
  const samples = [
    sample('baseline', 100, { build: 'b1', host: 'h1' }),
    ...groupSamples('build', 'b1', around(100, 4), around(200, 5)).slice(1),
    // host 仅在第一个样本出现一次 -> host 全部 insufficient_samples
  ];
  const result = attributeRegression({ ...REGRESSION_REQUEST, samples });
  assert.deepEqual(result.dimensions.map((d) => d.dimension), ['build', 'host']);
  const host = result.dimensions.find((d) => d.dimension === 'host');
  assert.equal(host.entries[0].evidence_status, 'insufficient_samples');
});

test('dimensions 键值对数组写法等价可用', () => {
  const samples = [];
  for (const v of around(100, 5)) {
    samples.push({ side: 'baseline', value: v,
      dimensions: [{ key: 'build', value: 'b1' }] });
  }
  for (const v of around(200, 5)) {
    samples.push({ side: 'candidate', value: v,
      dimensions: [{ key: 'build', value: 'b1' }] });
  }
  const result = attributeRegression({ ...REGRESSION_REQUEST, samples });
  assert.equal(result.dimensions[0].entries[0].evidence_status, 'primary_attribution');
});

test('decision 可由 comparisonRef 提供，且 metric/comparison 一致性受校验', () => {
  const samples = groupSamples('build', 'b1', around(100, 5), around(200, 5));
  const req = { metric: 'duration_ns', comparison: 'cmp-9', samples };
  const result = attributeRegression(req, {
    metric: 'duration_ns', comparison: 'cmp-9', decision: 'regression',
  });
  assert.equal(result.decision, 'regression');

  assert.throws(
    () => attributeRegression(req, { metric: 'other', comparison: 'cmp-9' }),
    (err) => err instanceof InvalidAttributionInputError && err.fieldPath === 'metric');
  assert.throws(
    () => attributeRegression(req, { metric: 'duration_ns', comparison: 'other' }),
    (err) => err instanceof InvalidAttributionInputError
      && err.fieldPath === 'comparison');
});

test('同一输入多次调用得到完全相同的归因顺序、数值与证据状态', () => {
  const samples = [
    ...groupSamples('build', 'b2', around(100, 5), around(200, 5)),
    ...groupSamples('build', 'b10', around(100, 5), around(200, 5)),
    ...groupSamples('host', 'h1', around(100, 5), around(100, 5)),
    ...groupSamples('host', 'h2', around(100, 5), [1, 2]),
  ];
  const r1 = attributeRegression({ ...REGRESSION_REQUEST, samples });
  const r2 = attributeRegression({ ...REGRESSION_REQUEST, samples });
  assert.deepEqual(r1, r2);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

test('MIN_SIDE_OBSERVATIONS 常量为 3', () => {
  assert.equal(MIN_SIDE_OBSERVATIONS, 3);
});

// ---- 输入校验 ----

function expectInvalid(request, expectedPath, comparisonRef) {
  try {
    attributeRegression(request, comparisonRef);
    assert.fail('应抛出 InvalidAttributionInputError');
  } catch (err) {
    assert.ok(err instanceof InvalidAttributionInputError, `应为 InvalidAttributionInputError: ${err}`);
    assert.equal(err.fieldPath, expectedPath, `错误信息: ${err.message}`);
  }
}

test('缺少 metric / comparison 抛错；decision 缺省时回显为 null（不抛错）', () => {
  const samples = groupSamples('build', 'b1', around(100, 5), around(200, 5));
  expectInvalid({ comparison: 'c', decision: 'regression', samples }, 'metric');
  expectInvalid({ metric: 'm', decision: 'regression', samples }, 'comparison');

  const noDecision = attributeRegression({ metric: 'm', comparison: 'c', samples });
  assert.equal(noDecision.decision, null);
  assert.equal(noDecision.evidence_status, 'primary_attribution');
});

test('缺少 side / value 抛错并指向第一个出错字段', () => {
  expectInvalid({
    ...REGRESSION_REQUEST,
    samples: [{ value: 1, dimensions: { build: 'b1' } }],
  }, 'samples[0].side');
  expectInvalid({
    ...REGRESSION_REQUEST,
    samples: [{ side: 'baseline', dimensions: { build: 'b1' } }],
  }, 'samples[0].value');
});

test('样本 value 为非有限数字（NaN/Infinity/字符串）抛错', () => {
  const dims = { build: 'b1' };
  expectInvalid({
    ...REGRESSION_REQUEST,
    samples: [sample('baseline', NaN, dims)],
  }, 'samples[0].value');
  expectInvalid({
    ...REGRESSION_REQUEST,
    samples: [sample('candidate', Infinity, dims)],
  }, 'samples[0].value');
  expectInvalid({
    ...REGRESSION_REQUEST,
    samples: [sample('candidate', '100', dims)],
  }, 'samples[0].value');
});

test('重复维度键（键值对数组写法）抛错并指向重复键路径', () => {
  expectInvalid({
    ...REGRESSION_REQUEST,
    samples: [{
      side: 'baseline', value: 1,
      dimensions: [
        { key: 'build', value: 'b1' },
        { key: 'build', value: 'b2' },
      ],
    }],
  }, 'samples[0].dimensions[1].key');
});

test('维度值不是有限字符串抛错', () => {
  expectInvalid({
    ...REGRESSION_REQUEST,
    samples: [sample('baseline', 1, { build: 1 })],
  }, 'samples[0].dimensions.build');
  expectInvalid({
    ...REGRESSION_REQUEST,
    samples: [{ side: 'baseline', value: 1,
      dimensions: [{ key: 'build', value: null }] }],
  }, 'samples[0].dimensions[0].value');
});

test('整个请求没有任何有效维度值时抛错（samples 路径）', () => {
  expectInvalid({
    ...REGRESSION_REQUEST,
    samples: [
      sample('baseline', 1),
      sample('candidate', 2, null),
    ],
  }, 'samples');
});

test('samples 不是数组 / 顶层不是对象 / 样本不是对象', () => {
  expectInvalid({ ...REGRESSION_REQUEST, samples: {} }, 'samples');
  expectInvalid(null, '$');
  expectInvalid({ ...REGRESSION_REQUEST, samples: [null] }, 'samples[0]');
});

test('side 取值非法抛错', () => {
  expectInvalid({
    ...REGRESSION_REQUEST,
    samples: [sample('other', 1, { build: 'b1' })],
  }, 'samples[0].side');
});

test('错误按输入顺序报告第一个字段（metric 早于 samples）', () => {
  expectInvalid({
    comparison: 'c', decision: 'regression',
    samples: [sample('bad', NaN)],
  }, 'metric');
});
