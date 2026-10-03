'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { welchTTest, tDistTwoTailedP } = require('../lib/stats');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'compare', ...args], { encoding: 'utf8' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-cmp-'));
}

// 生成一份 collect JSON 夹具；summary 故意写空，验证 compare 自行重算
function writeCollect(dir, name, { command = 'true', durations = [1, 2], unit = 'ns', samples } = {}) {
  const doc = {
    command,
    runs: durations.length,
    warmup: 0,
    timeout_ms: 1000,
    unit,
    samples: samples || durations.map((d, i) => ({
      index: i,
      started_at: '2026-01-01T00:00:00.000Z',
      duration_ns: d,
      exit_code: 0,
    })),
    summary: { count: 0, min: null, max: null, mean: null, median: null, p95: null, stddev: null },
    errors: [],
  };
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(doc));
  return p;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const BASE_DURATIONS = [1000, 1010, 990, 1000, 1020, 980, 1005, 995];
const CAND_DURATIONS = BASE_DURATIONS.map((d) => d + 200);

test('显著回归：结构、delta、welch、decision、attribution 正确', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', { durations: BASE_DURATIONS });
  const candidate = writeCollect(dir, 'cand.json', { durations: CAND_DURATIONS });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const report = readJson(out);
  assert.deepEqual(Object.keys(report),
    ['baseline_summary', 'candidate_summary', 'delta', 'welch', 'decision', 'attribution']);

  // 按七项口径重算（夹具 summary 为空对象，不采信）
  assert.deepEqual(Object.keys(report.baseline_summary),
    ['count', 'min', 'max', 'mean', 'median', 'p95', 'stddev']);
  assert.equal(report.baseline_summary.count, 8);
  assert.equal(report.baseline_summary.mean, 1000);
  assert.equal(report.baseline_summary.median, 1000);
  assert.equal(report.baseline_summary.p95, 1020);
  assert.equal(report.candidate_summary.mean, 1200);

  assert.deepEqual(report.delta.mean, { ns: 200, percent: 20 });
  assert.deepEqual(report.delta.median, { ns: 200, percent: 20 });
  assert.equal(report.delta.p95.ns, 200);
  assert.equal(report.delta.p95.percent, 19.607843); // round6((200/1020)*100)
  assert.deepEqual(report.delta.stddev, { ns: 0, percent: 0 });

  assert.deepEqual(Object.keys(report.welch),
    ['t_statistic', 'degrees_of_freedom', 'p_value']);
  assert.ok(report.welch.t_statistic > 0);
  assert.ok(report.welch.p_value <= 0.05);

  assert.equal(report.decision, 'regression');

  assert.deepEqual(Object.keys(report.attribution), [
    'central_tendency_percent', 'tail_latency_percent', 'variability_percent', 'dominant_factor',
  ]);
  assert.equal(report.attribution.central_tendency_percent, 20);
  assert.equal(report.attribution.tail_latency_percent, report.delta.p95.percent);
  assert.equal(report.attribution.variability_percent, 0);
  assert.equal(report.attribution.dominant_factor, 'central_tendency_percent');
});

test('显著改进：候选更快 -> improvement', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', { durations: CAND_DURATIONS });
  const candidate = writeCollect(dir, 'cand.json', { durations: BASE_DURATIONS });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.equal(report.decision, 'improvement');
  assert.equal(report.delta.mean.percent, -16.666667); // round6((-200/1200)*100)
  assert.ok(report.welch.t_statistic < 0);
  // 三项百分比均非正 -> 无主导因素
  assert.equal(report.attribution.dominant_factor, 'none');
});

test('不显著：分布重叠 -> not_significant', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', { durations: [100, 102, 98, 101, 99] });
  const candidate = writeCollect(dir, 'cand.json', { durations: [101, 103, 99, 102, 100] });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.ok(report.welch.p_value > 0.05);
  assert.equal(report.decision, 'not_significant');
});

test('显著但未达阈值 -> no_material_change；调低阈值 -> regression', () => {
  const dir = tempDir();
  // 均值 +2%，方差极小 -> 显著但 < 默认 5%
  const baseline = writeCollect(dir, 'base.json', { durations: [1000, 1001, 999, 1000, 1001] });
  const candidate = writeCollect(dir, 'cand.json', { durations: [1020, 1021, 1019, 1020, 1021] });
  const out1 = path.join(dir, 'out1.json');
  const r1 = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out1]);
  assert.equal(r1.status, 0, r1.stderr);
  const report1 = readJson(out1);
  assert.ok(report1.welch.p_value <= 0.05);
  assert.ok(report1.delta.mean.percent > 0 && report1.delta.mean.percent < 5);
  assert.equal(report1.decision, 'no_material_change');

  const out2 = path.join(dir, 'out2.json');
  const r2 = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out2,
    '--min-change-percent', '1']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readJson(out2).decision, 'regression');
});

test('--alpha 控制显著性判定', () => {
  const dir = tempDir();
  // p ≈ 2e-4：默认 alpha=0.05 显著，alpha=1e-6 不显著
  const baseline = writeCollect(dir, 'base.json', { durations: [100, 105, 95, 100, 105, 95] });
  const candidate = writeCollect(dir, 'cand.json', { durations: [115, 120, 110, 115, 120, 110] });
  const out1 = path.join(dir, 'out1.json');
  const r1 = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out1]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(readJson(out1).decision, 'regression');

  const out2 = path.join(dir, 'out2.json');
  const r2 = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out2,
    '--alpha=0.000001']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readJson(out2).decision, 'not_significant');
});

test('两边方差均为 0：均值相同 -> t=0, df=null, p=1', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', { durations: [100, 100, 100] });
  const candidate = writeCollect(dir, 'cand.json', { durations: [100, 100] });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.deepEqual(report.welch, { t_statistic: 0, degrees_of_freedom: null, p_value: 1 });
  assert.equal(report.decision, 'not_significant');
});

test('两边方差均为 0：均值不同 -> t=null, df=null, p=0', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', { durations: [100, 100] });
  const candidate = writeCollect(dir, 'cand.json', { durations: [200, 200, 200] });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.deepEqual(report.welch, { t_statistic: null, degrees_of_freedom: null, p_value: 0 });
  assert.equal(report.decision, 'regression');
  assert.equal(report.delta.mean.percent, 100);
});

test('基线为 0 的百分比：候选同为 0 记 0，仅基线 0 记 null', () => {
  const dir = tempDir();
  const zeroA = writeCollect(dir, 'zero-a.json', { durations: [0, 0] });
  const zeroB = writeCollect(dir, 'zero-b.json', { durations: [0, 0, 0] });
  const out1 = path.join(dir, 'out1.json');
  const r1 = runCli(['--baseline', zeroA, '--candidate', zeroB, '--output', out1]);
  assert.equal(r1.status, 0, r1.stderr);
  const report1 = readJson(out1);
  assert.deepEqual(report1.delta.mean, { ns: 0, percent: 0 });
  assert.equal(report1.decision, 'not_significant');

  const pos = writeCollect(dir, 'pos.json', { durations: [10, 10] });
  const out2 = path.join(dir, 'out2.json');
  const r2 = runCli(['--baseline', zeroA, '--candidate', pos, '--output', out2]);
  assert.equal(r2.status, 0, r2.stderr);
  const report2 = readJson(out2);
  assert.equal(report2.delta.mean.percent, null);
  assert.equal(report2.delta.p95.percent, null);
  // 基线 0、候选显著更大 -> regression
  assert.equal(report2.decision, 'regression');
  // 三项百分比为 null 或 0 -> 无主导因素
  assert.equal(report2.attribution.dominant_factor, 'none');
});

test('attribution：stddev 变化主导 -> variability_percent', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', { durations: [1000, 1010, 990, 1000] });
  const candidate = writeCollect(dir, 'cand.json', { durations: [1000, 1200, 800, 1000] });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.equal(report.attribution.central_tendency_percent, 0);
  assert.ok(report.attribution.variability_percent > report.attribution.tail_latency_percent);
  assert.equal(report.attribution.dominant_factor, 'variability_percent');
});

test('仅使用 exit_code 为 0 的样本；非零退出样本的非法 duration_ns 被忽略', () => {
  const dir = tempDir();
  const samples = [
    { index: 0, started_at: '2026-01-01T00:00:00.000Z', duration_ns: -5, exit_code: 1 },
    { index: 1, started_at: '2026-01-01T00:00:00.000Z', duration_ns: 100, exit_code: 0 },
    { index: 2, started_at: '2026-01-01T00:00:00.000Z', duration_ns: 120, exit_code: 0 },
  ];
  const baseline = writeCollect(dir, 'base.json', { samples });
  const candidate = writeCollect(dir, 'cand.json', { durations: [100, 120] });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.equal(report.baseline_summary.count, 2);
  assert.equal(report.baseline_summary.mean, 110);
});

test('输入无效：退出码 2，stderr 单行原因，不创建 output', () => {
  const dir = tempDir();
  const good = writeCollect(dir, 'good.json', { durations: [1, 2] });
  const out = path.join(dir, 'out.json');

  const badUnit = writeCollect(dir, 'bad-unit.json', { unit: 'ms' });
  const badCommand = writeCollect(dir, 'bad-command.json', { command: 'false' });
  const tooFew = writeCollect(dir, 'too-few.json', { durations: [1] });
  const negative = writeCollect(dir, 'negative.json', { durations: [1, -2] });
  const nonInteger = writeCollect(dir, 'non-integer.json', { durations: [1, 2.5] });
  const notJson = path.join(dir, 'not-json.json');
  fs.writeFileSync(notJson, '{oops');
  const missing = path.join(dir, 'missing.json');

  const cases = [
    ['--baseline', missing, '--candidate', good, '--output', out],
    ['--baseline', good, '--candidate', missing, '--output', out],
    ['--baseline', notJson, '--candidate', good, '--output', out],
    ['--baseline', badUnit, '--candidate', good, '--output', out],
    ['--baseline', good, '--candidate', badUnit, '--output', out],
    ['--baseline', badCommand, '--candidate', good, '--output', out],
    ['--baseline', tooFew, '--candidate', good, '--output', out],
    ['--baseline', negative, '--candidate', good, '--output', out],
    ['--baseline', nonInteger, '--candidate', good, '--output', out],
    ['--baseline', good, '--candidate', good, '--output', out, '--alpha', '0'],
    ['--baseline', good, '--candidate', good, '--output', out, '--alpha', '1'],
    ['--baseline', good, '--candidate', good, '--output', out, '--alpha', 'abc'],
    ['--baseline', good, '--candidate', good, '--output', out, '--min-change-percent', '-1'],
    ['--baseline', good, '--candidate', good, '--output', out, '--bogus'],
    ['--baseline', good, '--candidate', good],
    ['--baseline', good, '--output', out],
    ['--candidate', good, '--output', out],
  ];
  for (const args of cases) {
    const r = runCli(args);
    assert.equal(r.status, 2, `应退出码2: ${JSON.stringify(args)}`);
    assert.equal(fs.existsSync(out), false, `不应创建 output: ${JSON.stringify(args)}`);
    const lines = r.stderr.trim().split('\n');
    assert.equal(lines.length, 1, `stderr 应为单行: ${JSON.stringify(args)} -> ${r.stderr}`);
    assert.match(lines[0], /^perf-regress: /);
  }
});

test('输入无效时不改写已存在的 output', () => {
  const dir = tempDir();
  const good = writeCollect(dir, 'good.json', { durations: [1, 2] });
  const tooFew = writeCollect(dir, 'too-few.json', { durations: [1] });
  const out = path.join(dir, 'existing.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const r = runCli(['--baseline', tooFew, '--candidate', good, '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('output 写入失败：退出码 4', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', { durations: [1, 2] });
  const candidate = writeCollect(dir, 'cand.json', { durations: [1, 2] });
  const out = path.join(dir, 'no-such-dir', 'nested', 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});

test('边界参数合法：--min-change-percent 0、--alpha 接近 0/1', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', { durations: [1, 2] });
  const candidate = writeCollect(dir, 'cand.json', { durations: [1, 2] });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out,
    '--min-change-percent', '0', '--alpha', '0.999999']);
  assert.equal(r.status, 0, r.stderr);
});

test('welchTTest: 双方差为 0 的退化情形', () => {
  assert.deepEqual(welchTTest([5, 5], [5, 5, 5]),
    { t_statistic: 0, degrees_of_freedom: null, p_value: 1 });
  assert.deepEqual(welchTTest([5, 5], [6, 6]),
    { t_statistic: null, degrees_of_freedom: null, p_value: 0 });
});

test('tDistTwoTailedP: 已知临界值', () => {
  // df=1 即 Cauchy 分布，t=1 时双侧 p = 0.5
  assert.ok(Math.abs(tDistTwoTailedP(1, 1) - 0.5) < 1e-9);
  // t 分布 df=10 的双侧 0.05 临界值约为 2.22814
  assert.ok(Math.abs(tDistTwoTailedP(2.22814, 10) - 0.05) < 1e-4);
  assert.equal(tDistTwoTailedP(0, 10), 1);
});
