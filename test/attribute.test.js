'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');
const {
  computeAttribution,
  parseRequestJson,
  holmAdjust,
  compareUtf8,
  InvalidAttributionInputError,
} = require('../lib/attribute');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'attribute', ...args], { encoding: 'utf8' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-attr-'));
}

function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function writeRaw(dir, name, text) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function sample(side, value, dimensions) {
  return { side, value, dimensions };
}

// 强回归组（候选中位数显著上移），每侧 6 个观测。
function strongShiftGroup(dimName, groupValue) {
  const out = [];
  for (const v of [98, 99, 100, 100, 101, 102]) {
    out.push(sample('baseline', v, { [dimName]: groupValue }));
  }
  for (const v of [126, 128, 130, 130, 132, 134]) {
    out.push(sample('candidate', v, { [dimName]: groupValue }));
  }
  return out;
}

// 无变化组，每侧 6 个观测。
function flatGroup(dimName, groupValue) {
  const out = [];
  for (const v of [97, 99, 100, 100, 101, 103]) {
    out.push(sample('baseline', v, { [dimName]: groupValue }));
  }
  for (const v of [98, 99, 100, 100, 102, 103]) {
    out.push(sample('candidate', v, { [dimName]: groupValue }));
  }
  return out;
}

function request(samples, extra = {}) {
  return {
    metric: 'latency_ns',
    comparison: 'cmp-1',
    samples,
    ...extra,
  };
}

// ---- 库级：holmAdjust ----

test('holmAdjust: 单调化校正并映回原序', () => {
  const entries = [
    { value: 'a', dimension: 'd', p: 0.01 },
    { value: 'b', dimension: 'd', p: 0.04 },
    { value: 'c', dimension: 'd', p: 0.03 },
  ];
  const q = holmAdjust(entries);
  assert.deepEqual(q.map((x) => Math.round(x * 1e6) / 1e6), [0.03, 0.04, 0.04]);
});

test('holmAdjust: 校正值随位次缩放并封顶 1', () => {
  // m=2：位次 2 的 0.9 -> min(1, 1*0.9)=0.9；位次 1 的 0.8 -> min(0.9, 2*0.8)=0.9
  const entries = [
    { value: 'a', dimension: 'd', p: 0.9 },
    { value: 'b', dimension: 'd', p: 0.8 },
  ];
  assert.deepEqual(holmAdjust(entries), [0.9, 0.9]);
});

test('holmAdjust: 大 p 值（p=1）保持 1', () => {
  const entries = [
    { value: 'a', dimension: 'd', p: 1 },
    { value: 'b', dimension: 'd', p: 1 },
  ];
  assert.deepEqual(holmAdjust(entries), [1, 1]);
});

// ---- 库级：UTF-8 字节序 ----

test('compareUtf8: 按 UTF-8 字节而非区域/码点排序', () => {
  // 'a'(61) < 'b'(62) < 'Ä'(c3 84) < '中'(e4 b8 ad)
  const values = ['中', 'Ä', 'b', 'a'];
  assert.deepEqual(values.slice().sort(compareUtf8), ['a', 'b', 'Ä', '中']);
});

// ---- 库级：主流程与输出结构 ----

test('单一显著回归维度值 -> primary_attribution', () => {
  const result = computeAttribution(
    request([...strongShiftGroup('host', 'h1'), ...flatGroup('host', 'h2')]),
  );
  assert.equal(result.metric, 'latency_ns');
  assert.equal(result.comparison, 'cmp-1');
  assert.equal(result.decision, 'regression');
  assert.deepEqual(Object.keys(result),
    ['metric', 'comparison', 'baseline_summary', 'candidate_summary',
      'welch', 'decision', 'attribution']);
  assert.equal(result.attribution.evidence_status, 'primary_attribution');
  assert.equal(result.attribution.dimensions.length, 1);

  const dim = result.attribution.dimensions[0];
  assert.deepEqual(Object.keys(dim),
    ['dimension', 'positive_contribution_sum', 'primary_candidates', 'rankings']);
  assert.equal(dim.dimension, 'host');
  assert.equal(dim.primary_candidates.length, 1);
  assert.equal(dim.primary_candidates[0], 'h1');

  const r1 = dim.rankings[0];
  assert.deepEqual(Object.keys(r1),
    ['value', 'baseline_count', 'candidate_count', 'median_diff',
      'weight', 'contribution', 'adjusted_p_value', 'evidence']);
  assert.equal(r1.value, 'h1');
  assert.equal(r1.baseline_count, 6);
  assert.equal(r1.candidate_count, 6);
  assert.equal(r1.weight, 12);
  assert.equal(r1.median_diff, 30);
  assert.equal(r1.contribution, 360);
  assert.ok(r1.adjusted_p_value < 0.05);
  assert.equal(r1.evidence, 'primary');

  const r2 = dim.rankings[1];
  assert.equal(r2.value, 'h2');
  assert.ok(r2.contribution <= 0);
  assert.equal(r2.evidence, 'ranked');

  assert.equal(result.attribution.primary_attributions.length, 1);
  assert.deepEqual(result.attribution.primary_attributions[0], {
    dimension: 'host',
    value: 'h1',
    median_diff: 30,
    weight: 12,
    contribution: 360,
    adjusted_p_value: r1.adjusted_p_value,
  });
});

test('贡献降序：多个正贡献维度值按贡献从大到小排列', () => {
  // g1: 中位数差 40；g2: 中位数差 20；g3: 平坦。每侧各 3 个观测。
  const samples = [];
  for (const v of [90, 100, 110]) samples.push(sample('baseline', v, { host: 'g1' }));
  for (const v of [120, 140, 160]) samples.push(sample('candidate', v, { host: 'g1' }));
  for (const v of [90, 100, 110]) samples.push(sample('baseline', v, { host: 'g2' }));
  for (const v of [100, 120, 140]) samples.push(sample('candidate', v, { host: 'g2' }));
  samples.push(...flatGroup('host', 'g3'));
  const result = computeAttribution(request(samples));
  const dim = result.attribution.dimensions[0];
  const values = dim.rankings
    .filter((r) => r.evidence !== 'insufficient_samples')
    .map((r) => r.value);
  assert.deepEqual(values, ['g1', 'g2', 'g3']);
  const g1 = dim.rankings.find((r) => r.value === 'g1');
  assert.equal(g1.contribution, 240); // 40 * 6
  const g2 = dim.rankings.find((r) => r.value === 'g2');
  assert.equal(g2.contribution, 120); // 20 * 6
});

test('贡献相同按维度值 UTF-8 字节序，最高并列 -> 多项 primary', () => {
  // 两个维度值强回归幅度相同，贡献严格相等。
  const samples = [
    ...strongShiftGroup('host', 'b'),
    ...strongShiftGroup('host', 'a'),
    ...strongShiftGroup('host', 'Ä'),
  ];
  const result = computeAttribution(request(samples));
  const dim = result.attribution.dimensions[0];
  // 三者贡献相同（360），均通过三门且与最高并列 -> 全部 primary，
  // 排名与 primary_candidates 都按 UTF-8 字节序：a < b < Ä
  assert.deepEqual(dim.rankings.map((r) => r.value), ['a', 'b', 'Ä']);
  assert.ok(dim.rankings.every((r) => r.evidence === 'primary'));
  assert.deepEqual(dim.primary_candidates, ['a', 'b', 'Ä']);
  assert.deepEqual(result.attribution.primary_attributions.map((p) => p.value),
    ['a', 'b', 'Ä']);
});

test('跨维度最高贡献并列 -> 并列项都列为首要归因，按维度值字节序', () => {
  const samples = [
    ...strongShiftGroup('host', 'z'),
    ...strongShiftGroup('build', 'z'),
  ];
  const result = computeAttribution(request(samples));
  const names = result.attribution.dimensions.map((d) => d.dimension);
  assert.deepEqual(names, ['build', 'host']);
  assert.equal(result.attribution.evidence_status, 'primary_attribution');
  assert.equal(result.attribution.primary_attributions.length, 2);
  // 维度值相同（'z'），按维度名 UTF-8 字节序
  assert.deepEqual(result.attribution.primary_attributions.map((p) => p.dimension),
    ['build', 'host']);
});

test('30% 份额门：正贡献占比不足 30% 的显著项不得为首要归因', () => {
  // big 贡献 360；small 贡献 120（差 20 × 6），正贡献和 480，small 占 25%。
  const samples = [];
  samples.push(...strongShiftGroup('host', 'big'));
  for (const v of [90, 100, 110]) samples.push(sample('baseline', v, { host: 'small' }));
  for (const v of [100, 120, 140]) samples.push(sample('candidate', v, { host: 'small' }));
  const result = computeAttribution(request(samples));
  const dim = result.attribution.dimensions[0];
  const big = dim.rankings.find((r) => r.value === 'big');
  const small = dim.rankings.find((r) => r.value === 'small');
  assert.equal(big.evidence, 'primary');
  assert.equal(small.evidence, 'ranked');
  assert.deepEqual(dim.primary_candidates, ['big']);
});

test('1e-12 精度内并列：微小差（<=1e-12）视为并列', () => {
  // 5v5 完全分离时原始双侧精确 p=2/C(10,5)≈0.00794，维度内 Holm（m=2）
  // 校正后 ≈0.0159 仍 < 0.05。两组中位数差相差 1e-14（贡献差 1e-13）。
  const samples = [];
  for (const v of [70, 80, 90, 100, 110]) samples.push(sample('baseline', v, { host: 'a' }));
  for (const v of [120, 130, 140, 150, 160]) samples.push(sample('candidate', v, { host: 'a' }));
  const eps = 1e-14;
  for (const v of [70, 80, 90, 100, 110]) samples.push(sample('baseline', v, { host: 'b' }));
  for (const v of [120 + eps, 130 + eps, 140 + eps, 150 + eps, 160 + eps]) {
    samples.push(sample('candidate', v, { host: 'b' }));
  }
  const result = computeAttribution(request(samples));
  assert.equal(result.attribution.evidence_status, 'primary_attribution');
  assert.deepEqual(result.attribution.primary_attributions.map((p) => p.value),
    ['a', 'b']);
});

test('超过 1e-12 的贡献差不视为并列：只取最高项', () => {
  const samples = [];
  for (const v of [70, 80, 90, 100, 110]) samples.push(sample('baseline', v, { host: 'a' }));
  for (const v of [120, 130, 140, 150, 160]) samples.push(sample('candidate', v, { host: 'a' }));
  const eps = 1e-10;
  for (const v of [70, 80, 90, 100, 110]) samples.push(sample('baseline', v, { host: 'b' }));
  for (const v of [120 + eps, 130 + eps, 140 + eps, 150 + eps, 160 + eps]) {
    samples.push(sample('candidate', v, { host: 'b' }));
  }
  const result = computeAttribution(request(samples));
  assert.deepEqual(result.attribution.primary_attributions.map((p) => p.value), ['b']);
});

test('跨维度均合格但贡献非最高 -> evidence 为 eligible，只有全局最高为 primary', () => {
  // host/h1 贡献 360；build/b1 完全分离、贡献 240，各自维度内份额 100%。
  const samples = [
    ...strongShiftGroup('host', 'h1'),
  ];
  for (const v of [95, 99, 100, 100, 101, 105]) {
    samples.push(sample('baseline', v, { build: 'b1' }));
  }
  for (const v of [115, 119, 120, 120, 121, 125]) {
    samples.push(sample('candidate', v, { build: 'b1' }));
  }
  const result = computeAttribution(request(samples));
  assert.equal(result.attribution.evidence_status, 'primary_attribution');
  const hostRow = result.attribution.dimensions
    .find((d) => d.dimension === 'host').rankings[0];
  const buildRow = result.attribution.dimensions
    .find((d) => d.dimension === 'build').rankings[0];
  assert.equal(hostRow.evidence, 'primary');
  assert.equal(buildRow.evidence, 'eligible');
  assert.deepEqual(result.attribution.primary_attributions.map((p) => [p.dimension, p.value]),
    [['host', 'h1']]);
});

test('未达显著或无正贡献 -> insufficient_evidence（非异常）', () => {
  const result = computeAttribution(request(flatGroup('host', 'h1')));
  assert.equal(result.attribution.evidence_status, 'insufficient_evidence');
  assert.deepEqual(result.attribution.primary_attributions, []);
  // 平坦组 p 值较大且贡献非正：参与排名但不显著
  const row = result.attribution.dimensions[0].rankings[0];
  assert.equal(row.evidence, 'ranked');
  assert.ok(row.adjusted_p_value > 0.05);
  assert.ok(row.contribution <= 0);
});

test('整体为改进时结论照常保留，归因证据不足', () => {
  const samples = [];
  for (const v of [126, 128, 130, 130, 132, 134]) {
    samples.push(sample('baseline', v, { host: 'h1' }));
  }
  for (const v of [98, 99, 100, 100, 101, 102]) {
    samples.push(sample('candidate', v, { host: 'h1' }));
  }
  const result = computeAttribution(request(samples));
  assert.equal(result.decision, 'improvement');
  assert.equal(result.attribution.evidence_status, 'insufficient_evidence');
});

// ---- 样本不足口径 ----

test('任一侧不足 3 个观测 -> insufficient_samples，不阻断其他维度值', () => {
  const samples = [];
  samples.push(...strongShiftGroup('host', 'ok'));
  // rare：基线 2、候选 4
  samples.push(sample('baseline', 100, { host: 'rare' }));
  samples.push(sample('baseline', 101, { host: 'rare' }));
  for (const v of [100, 101, 102, 103]) {
    samples.push(sample('candidate', v, { host: 'rare' }));
  }
  const result = computeAttribution(request(samples));
  const dim = result.attribution.dimensions[0];
  const ok = dim.rankings.find((r) => r.value === 'ok');
  const rare = dim.rankings.find((r) => r.value === 'rare');
  assert.equal(ok.evidence, 'primary');
  assert.equal(rare.evidence, 'insufficient_samples');
  assert.equal(rare.baseline_count, 2);
  assert.equal(rare.candidate_count, 4);
  assert.equal(rare.median_diff, null);
  assert.equal(rare.weight, null);
  assert.equal(rare.contribution, null);
  assert.equal(rare.adjusted_p_value, null);
  // insufficient_samples 行排在有效行之后
  assert.equal(dim.rankings[dim.rankings.length - 1].value, 'rare');
});

test('维度内全部维度值样本不足时该维度仍输出（全为 insufficient_samples）', () => {
  const samples = [];
  samples.push(...strongShiftGroup('host', 'h1'));
  // scenario 维度每侧只有 2 个
  for (const v of [100, 101]) samples.push(sample('baseline', v, { scenario: 's1' }));
  for (const v of [140, 141]) samples.push(sample('candidate', v, { scenario: 's1' }));
  const result = computeAttribution(request(samples));
  const scenario = result.attribution.dimensions.find((d) => d.dimension === 'scenario');
  assert.equal(scenario.rankings.length, 1);
  assert.equal(scenario.rankings[0].evidence, 'insufficient_samples');
  assert.equal(result.attribution.evidence_status, 'primary_attribution');
});

// ---- 输入校验：首个字段路径 ----

test('缺少 metric -> InvalidAttributionInputError，路径为 metric', () => {
  assert.throws(
    () => computeAttribution({ comparison: 'c', samples: [] }),
    (err) => err instanceof InvalidAttributionInputError && err.path === 'metric',
  );
});

test('缺少 comparison -> 路径为 comparison', () => {
  assert.throws(
    () => computeAttribution({ metric: 'm', samples: [] }),
    (err) => err.path === 'comparison',
  );
});

test('metric 与样本同时有问题时先报 metric（顶层标识优先）', () => {
  const bad = request([sample('baseline', 1, { host: 'a' })]);
  delete bad.metric;
  assert.throws(() => computeAttribution(bad), (err) => err.path === 'metric');
});

test('samples 不是数组 -> 路径 samples', () => {
  assert.throws(
    () => computeAttribution({ metric: 'm', comparison: 'c' }),
    (err) => err.path === 'samples',
  );
});

test('缺 side / 非法 side -> samples[i].side', () => {
  assert.throws(
    () => computeAttribution(request([
      sample('candidate', 1, { host: 'a' }), sample('candidate', 1, { host: 'a' }),
      { value: 12, dimensions: { host: 'b' } },
    ])),
    (err) => err.path === 'samples[2].side',
  );
  assert.throws(
    () => computeAttribution(request([
      { side: 'left', value: 1, dimensions: {} },
    ])),
    (err) => err.path === 'samples[0].side',
  );
});

test('样本值缺失或非有限数字 -> samples[i].value', () => {
  for (const bad of [undefined, '100', NaN, Infinity, -Infinity, true, null]) {
    const samples = [
      sample('baseline', 100, { host: 'a' }),
      sample('candidate', 100, { host: 'a' }),
      { side: 'baseline', dimensions: { host: 'b' }, value: bad },
    ];
    if (bad === undefined) delete samples[2].value;
    assert.throws(
      () => computeAttribution(request(samples)),
      (err) => err.path === 'samples[2].value',
      `bad value: ${String(bad)}`,
    );
  }
});

test('同一样本 side 与 value 同时非法时先报 side', () => {
  assert.throws(
    () => computeAttribution(request([{ side: 'x', value: 'y' }])),
    (err) => err.path === 'samples[0].side',
  );
});

test('多个样本有问题时报下标最小者', () => {
  assert.throws(
    () => computeAttribution(request([
      sample('baseline', 1, { host: 'a' }),
      sample('candidate', 2, { host: 'a' }),
      sample('baseline', 3, { host: 'a' }),
      { side: 'candidate', value: 'no' },
    ])),
    (err) => err.path === 'samples[3].value',
  );
});

test('维度值非字符串 -> 该字段路径', () => {
  assert.throws(
    () => computeAttribution(request([
      sample('baseline', 100, { host: 123 }),
      sample('candidate', 100, { host: 123 }),
    ])),
    (err) => err.path === 'samples[0].dimensions.host',
  );
});

test('dimensions 不是对象 -> samples[i].dimensions', () => {
  assert.throws(
    () => computeAttribution(request([
      { side: 'baseline', value: 1, dimensions: ['host', 'a'] },
    ])),
    (err) => err.path === 'samples[0].dimensions',
  );
});

test('整个请求没有任何有效维度值 -> InvalidAttributionInputError(samples)', () => {
  const samples = [
    sample('baseline', 100),
    sample('baseline', 101),
    sample('candidate', 120),
    sample('candidate', 121),
  ];
  assert.throws(
    () => computeAttribution(request(samples)),
    (err) => err instanceof InvalidAttributionInputError && err.path === 'samples',
  );
});

test('每侧不足 2 个样本 -> InvalidAttributionInputError', () => {
  assert.throws(
    () => computeAttribution(request([
      sample('baseline', 100, { host: 'a' }),
      sample('candidate', 120, { host: 'a' }),
      sample('candidate', 121, { host: 'a' }),
    ])),
    (err) => err instanceof InvalidAttributionInputError,
  );
});

test('重复维度键（JSON 原文重复键）-> 报具体字段路径', () => {
  const text = JSON.stringify(request([
    sample('baseline', 100, { host: 'a' }),
    sample('candidate', 120, { host: 'a' }),
  ])).replace('"host":"a"', '"host":"a","host":"b"');
  const { value, duplicatePath } = parseRequestJson(text);
  assert.equal(duplicatePath, 'samples[0].dimensions.host');
  assert.throws(
    () => computeAttribution(value, duplicatePath),
    (err) => err instanceof InvalidAttributionInputError
      && err.path === 'samples[0].dimensions.host',
  );
});

test('重复维度键位于后面的样本时报告该样本路径', () => {
  const text = '{"metric":"m","comparison":"c","samples":['
    + '{"side":"baseline","value":100,"dimensions":{"host":"a"}},'
    + '{"side":"baseline","value":101,"dimensions":{"host":"a"}},'
    + '{"side":"candidate","value":120,"dimensions":{"host":"a"}},'
    + '{"side":"candidate","value":121,"dimensions":{"host":"a","host":"b"}}]}';
  const { value, duplicatePath } = parseRequestJson(text);
  assert.equal(duplicatePath, 'samples[3].dimensions.host');
  assert.throws(
    () => computeAttribution(value, duplicatePath),
    (err) => err.path === 'samples[3].dimensions.host',
  );
});

test('非 dimensions 位置的重复 JSON 键不判为重复维度键', () => {
  // side 重复不是维度键重复，按 JSON 后值生效处理，不因此抛错
  const text = '{"metric":"m","comparison":"c","samples":['
    + '{"side":"candidate","side":"baseline","value":100,"dimensions":{"host":"a"}},'
    + '{"side":"baseline","value":101,"dimensions":{"host":"a"}},'
    + '{"side":"candidate","value":120,"dimensions":{"host":"a"}},'
    + '{"side":"candidate","value":121,"dimensions":{"host":"a"}}]}';
  const { value, duplicatePath } = parseRequestJson(text);
  assert.equal(duplicatePath, null);
  const result = computeAttribution(value, duplicatePath);
  assert.equal(result.baseline_summary.count, 2);
  assert.equal(result.candidate_summary.count, 2);
});

test('异常信息以字段路径开头', () => {
  try {
    computeAttribution(request([{ side: 'baseline' }]));
    assert.fail('应抛错');
  } catch (err) {
    assert.ok(err.message.startsWith('samples[0].value:'));
  }
});

// ---- 稳定性 ----

test('同一输入多次调用：顺序、数值、证据状态完全一致', () => {
  const samples = [
    ...strongShiftGroup('zzz', 'x'),
    ...strongShiftGroup('aaa', 'y'),
    ...flatGroup('zzz', 'w'),
    ...flatGroup('aaa', 'v'),
  ];
  const r1 = computeAttribution(request(samples));
  const r2 = computeAttribution(request(samples.slice().reverse()));
  assert.deepEqual(r1, r2);
});

// ---- 原比较结论口径与 compare 一致 ----

test('重算的 welch/decision/summary 与 compare 子命令口径一致', () => {
  const samples = [
    ...strongShiftGroup('host', 'h1'),
    ...flatGroup('host', 'h2'),
  ];
  const result = computeAttribution(request(samples));
  const baseline = samples.filter((s) => s.side === 'baseline').map((s) => s.value);
  const candidate = samples.filter((s) => s.side === 'candidate').map((s) => s.value);

  const dir = tempDir();
  const toCollect = (durations) => ({
    command: 'true', runs: durations.length, warmup: 0, timeout_ms: 1000,
    unit: 'ns',
    samples: durations.map((d, i) => ({
      index: i, started_at: '2026-01-01T00:00:00.000Z',
      duration_ns: d, exit_code: 0,
    })),
    summary: {}, errors: [],
  });
  const bp = writeJson(dir, 'b.json', toCollect(baseline));
  const cp = writeJson(dir, 'c.json', toCollect(candidate));
  const op = path.join(dir, 'cmp.json');
  const r = spawnSync(process.execPath,
    [BIN, 'compare', '--baseline', bp, '--candidate', cp, '--output', op],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const cmp = readJson(op);
  assert.deepEqual(result.baseline_summary, cmp.baseline_summary);
  assert.deepEqual(result.candidate_summary, cmp.candidate_summary);
  assert.deepEqual(result.welch, cmp.welch);
  assert.equal(result.decision, cmp.decision);
});

test('alpha / min_change_percent 只影响重算结论判定，缺省与 compare 默认一致', () => {
  const samples = [...strongShiftGroup('host', 'h1')];
  const withOpts = computeAttribution(
    request(samples, { alpha: 0.01, min_change_percent: 50 }),
  );
  // 强回归（约 30%）在 50% 阈值下不再是 regression
  assert.equal(withOpts.decision, 'no_material_change');
  // 但归因证据不受阈值影响，仍可基于自身三门规则给出首要归因
  assert.equal(withOpts.attribution.evidence_status, 'primary_attribution');
  assert.throws(
    () => computeAttribution(request(samples, { alpha: 0 })),
    (err) => err.path === 'alpha',
  );
  assert.throws(
    () => computeAttribution(request(samples, { min_change_percent: -1 })),
    (err) => err.path === 'min_change_percent',
  );
});

// ---- CLI 端到端 ----

test('CLI: 成功写出归因结果，退出码 0', () => {
  const dir = tempDir();
  const rp = writeJson(dir, 'req.json',
    request([...strongShiftGroup('host', 'h1'), ...flatGroup('host', 'h2')]));
  const op = path.join(dir, 'out.json');
  const r = runCli(['--request', rp, '--output', op]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(op);
  assert.equal(result.decision, 'regression');
  assert.equal(result.attribution.evidence_status, 'primary_attribution');
});

test('CLI: --key=value 写法同样可用', () => {
  const dir = tempDir();
  const rp = writeJson(dir, 'req.json',
    request([...strongShiftGroup('host', 'h1'), ...flatGroup('host', 'h2')]));
  const op = path.join(dir, 'out.json');
  const r = runCli([`--request=${rp}`, `--output=${op}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readJson(op).attribution.evidence_status, 'primary_attribution');
});

test('CLI: 非法输入退出码 2，stderr 含字段路径，且不创建 output', () => {
  const dir = tempDir();
  const rp = writeJson(dir, 'req.json', { metric: 'm', samples: [] });
  const op = path.join(dir, 'out.json');
  const r = runCli(['--request', rp, '--output', op]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('comparison'));
  assert.equal(fs.existsSync(op), false);
});

test('CLI: 重复维度键退出码 2 且报具体路径，不创建 output', () => {
  const dir = tempDir();
  const text = JSON.stringify(request([
    sample('baseline', 100, { host: 'a' }),
    sample('baseline', 101, { host: 'a' }),
    sample('candidate', 120, { host: 'a' }),
    sample('candidate', 121, { host: 'a' }),
  ])).replace('"host":"a"', '"host":"a","host":"b"');
  const rp = writeRaw(dir, 'req.json', text);
  const op = path.join(dir, 'out.json');
  const r = runCli(['--request', rp, '--output', op]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('samples[0].dimensions.host'), r.stderr);
  assert.equal(fs.existsSync(op), false);
});

test('CLI: 非法 JSON 退出码 2', () => {
  const dir = tempDir();
  const rp = writeRaw(dir, 'req.json', '{ not json');
  const op = path.join(dir, 'out.json');
  const r = runCli(['--request', rp, '--output', op]);
  assert.equal(r.status, 2);
  assert.equal(fs.existsSync(op), false);
});

test('CLI: 缺少必填参数退出码 2', () => {
  const r = runCli(['--request', 'whatever.json']);
  assert.equal(r.status, 2);
});

test('CLI: 结果可复现（两次输出逐字节一致）', () => {
  const dir = tempDir();
  const rp = writeJson(dir, 'req.json',
    request([
      ...strongShiftGroup('host', 'h2'),
      ...strongShiftGroup('host', 'h1'),
      ...flatGroup('build', 'b2'),
      ...flatGroup('build', 'b1'),
    ]));
  const o1 = path.join(dir, 'out1.json');
  const o2 = path.join(dir, 'out2.json');
  const r1 = runCli(['--request', rp, '--output', o1]);
  const r2 = runCli(['--request', rp, '--output', o2]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(fs.readFileSync(o1, 'utf8'), fs.readFileSync(o2, 'utf8'));
});
