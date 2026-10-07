'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'equivalence', ...args], { encoding: 'utf8' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-'));
}

// 以给定 duration_ns 列表构造一份 collect JSON 并写入临时文件。
function writeCollect(dir, name, durations, { command = 'true', unit = 'ns' } = {}) {
  const samples = durations.map((d, i) => ({
    index: i,
    started_at: '2026-01-01T00:00:00.000Z',
    duration_ns: d,
    exit_code: 0,
  }));
  const report = { command, runs: durations.length, warmup: 0, timeout_ms: 1000,
    unit, samples, summary: {}, errors: [] };
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(report));
  return p;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('等价：零方差且差值在边界内，两 p 均为 0 -> equivalent，结果含固定六项', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 100, 100]);
  const candidate = writeCollect(dir, 'cand.json', [101, 101, 101]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const result = readJson(out);
  assert.deepEqual(Object.keys(result),
    ['baseline_summary', 'candidate_summary', 'delta', 'margin', 'equivalence_test', 'decision']);

  assert.deepEqual(Object.keys(result.baseline_summary),
    ['count', 'min', 'max', 'mean', 'median', 'p95', 'stddev']);
  assert.equal(result.baseline_summary.mean, 100);
  assert.equal(result.candidate_summary.mean, 101);

  // delta 仅含 mean：ns、percent 与 1 - 2*alpha 的双侧区间（默认 level 0.9）
  assert.deepEqual(Object.keys(result.delta), ['mean']);
  assert.deepEqual(Object.keys(result.delta.mean), ['ns', 'percent', 'confidence_interval']);
  assert.equal(result.delta.mean.ns, 1);
  assert.equal(result.delta.mean.percent, 1);
  // 零方差区间退化为单点
  assert.deepEqual(result.delta.mean.confidence_interval, {
    level: 0.9, lower_ns: 1, upper_ns: 1, lower_percent: 1, upper_percent: 1,
  });

  // margin 为基线均值乘 margin-percent（默认 5）除以 100
  assert.deepEqual(result.margin, { ns: 5, percent: 5 });

  assert.deepEqual(Object.keys(result.equivalence_test), ['lower', 'upper', 'degrees_of_freedom']);
  assert.deepEqual(result.equivalence_test, {
    lower: { t_statistic: null, p_value: 0 },
    upper: { t_statistic: null, p_value: 0 },
    degrees_of_freedom: null,
  });

  assert.equal(result.decision, 'equivalent');
});

test('越界：差值高于正 margin -> above_margin；低于负 margin -> below_margin', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 100, 100]);

  const up = writeCollect(dir, 'up.json', [110, 110, 110]);
  const outUp = path.join(dir, 'up-out.json');
  const rUp = runCli(['--baseline', baseline, '--candidate', up, '--output', outUp]);
  assert.equal(rUp.status, 0, rUp.stderr);
  const resultUp = readJson(outUp);
  assert.deepEqual(resultUp.equivalence_test.lower, { t_statistic: null, p_value: 0 });
  assert.deepEqual(resultUp.equivalence_test.upper, { t_statistic: null, p_value: 1 });
  assert.equal(resultUp.decision, 'above_margin');

  const down = writeCollect(dir, 'down.json', [90, 90, 90]);
  const outDown = path.join(dir, 'down-out.json');
  const rDown = runCli(['--baseline', baseline, '--candidate', down, '--output', outDown]);
  assert.equal(rDown.status, 0, rDown.stderr);
  const resultDown = readJson(outDown);
  assert.deepEqual(resultDown.equivalence_test.lower, { t_statistic: null, p_value: 1 });
  assert.deepEqual(resultDown.equivalence_test.upper, { t_statistic: null, p_value: 0 });
  assert.equal(resultDown.decision, 'below_margin');
});

test('零方差且差值等于边界：对应检验 p 为 1，另一为 0', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 100, 100]);
  // diff = 5 恰等于 margin（默认 5%）：upper p 为 1，lower p 为 0
  const edge = writeCollect(dir, 'edge.json', [105, 105, 105]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', edge, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.deepEqual(result.equivalence_test.lower, { t_statistic: null, p_value: 0 });
  assert.deepEqual(result.equivalence_test.upper, { t_statistic: 0, p_value: 1 });
  // 1 - upper.p_value = 0 <= alpha -> above_margin
  assert.equal(result.decision, 'above_margin');
});

test('不显著也不等价：高噪声小差值 -> inconclusive', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 110, 90, 105, 95, 120, 80]);
  const candidate = writeCollect(dir, 'cand.json', [101, 109, 91, 104, 96, 119, 81]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.decision, 'inconclusive');
  assert.ok(result.equivalence_test.lower.p_value > 0.05
    || result.equivalence_test.upper.p_value > 0.05);
});

test('非零方差：t 统计量、自由度与单侧 p 值按 Welch 口径计算', () => {
  const dir = tempDir();
  // baseline [1,2,3] 均值 2；candidate [4,5,6] 均值 5；diff 3；
  // se = sqrt(1/3+1/3)，df = 4；margin = 2 * 250% = 5；
  // lower t = (3+5)/se = 9.797959，右尾 p = 0.000304；
  // upper t = (3-5)/se = -2.44949，左尾 p = 0.035242。
  const baseline = writeCollect(dir, 'base.json', [1, 2, 3]);
  const candidate = writeCollect(dir, 'cand.json', [4, 5, 6]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate,
    '--output', out, '--margin-percent', '250']);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.deepEqual(result.margin, { ns: 5, percent: 250 });
  assert.deepEqual(result.equivalence_test, {
    lower: { t_statistic: 9.797959, p_value: 0.000304 },
    upper: { t_statistic: -2.44949, p_value: 0.035242 },
    degrees_of_freedom: 4,
  });
  assert.equal(result.decision, 'equivalent');
});

test('confidence_interval：level 为 1 - 2*alpha，随 alpha 变化', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [1, 2, 3]);
  const candidate = writeCollect(dir, 'cand.json', [4, 5, 6]);
  const run = (alpha) => {
    const out = path.join(dir, `a-${alpha}.json`);
    const rr = runCli(['--baseline', baseline, '--candidate', candidate,
      '--output', out, '--alpha', String(alpha)]);
    assert.equal(rr.status, 0, rr.stderr);
    return readJson(out);
  };
  const r90 = run(0.05);
  const r80 = run(0.1);
  assert.equal(r90.delta.mean.confidence_interval.level, 0.9);
  assert.equal(r80.delta.mean.confidence_interval.level, 0.8);
  // 区间关于点估计对称（Welch 区间），alpha 越大区间越窄
  const width = (ci) => ci.upper_ns - ci.lower_ns;
  assert.ok(width(r80.delta.mean.confidence_interval) < width(r90.delta.mean.confidence_interval));
  // 点估计与检验不受 alpha 影响
  assert.equal(r90.delta.mean.ns, r80.delta.mean.ns);
  assert.deepEqual(r90.equivalence_test, r80.equivalence_test);
});

test('alpha 影响判定：同一输入在不同 alpha 下结论可变', () => {
  const dir = tempDir();
  // upper p ≈ 0.035：alpha 0.01 时两 p 不都 <= alpha -> inconclusive
  const baseline = writeCollect(dir, 'base.json', [1, 2, 3]);
  const candidate = writeCollect(dir, 'cand.json', [4, 5, 6]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate,
    '--output', out, '--margin-percent', '250', '--alpha', '0.01']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readJson(out).decision, 'inconclusive');
});

test('margin-percent 收窄边界可改变判定', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 100, 100]);
  const candidate = writeCollect(dir, 'cand.json', [101, 101, 101]);
  // margin 0.5%（0.5ns）：diff 1ns 越出上界 -> above_margin
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate,
    '--output', out, '--margin-percent', '0.5']);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.deepEqual(result.margin, { ns: 0.5, percent: 0.5 });
  assert.equal(result.decision, 'above_margin');
});

test('exit_code 非 0 的样本被忽略', () => {
  const dir = tempDir();
  const mk = (name, durations) => {
    const samples = durations.map(([d, code], i) => ({
      index: i, started_at: '2026-01-01T00:00:00.000Z', duration_ns: d, exit_code: code,
    }));
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify({ command: 'true', unit: 'ns', samples }));
    return p;
  };
  const baseline = mk('base.json', [[100, 0], [100, 0], [9999, 1], [100, 0]]);
  const candidate = mk('cand.json', [[101, 0], [101, 0], [5, 7], [101, 0]]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.baseline_summary.count, 3);
  assert.equal(result.candidate_summary.count, 3);
  assert.equal(result.decision, 'equivalent');
});

test('输入无效：退出码 2，stderr 一条原因，不创建 output', () => {
  const dir = tempDir();
  const good = writeCollect(dir, 'good.json', [100, 100, 100]);
  const out = path.join(dir, 'out.json');

  const zeros = writeCollect(dir, 'zeros.json', [0, 0, 0]);
  const badUnit = path.join(dir, 'bad-unit.json');
  fs.writeFileSync(badUnit, JSON.stringify({ command: 'true', unit: 'ms', samples: [] }));
  const badCommand = writeCollect(dir, 'bad-command.json', [100, 100], { command: 'false' });
  const tooFew = writeCollect(dir, 'too-few.json', [100]);
  const badDuration = path.join(dir, 'bad-duration.json');
  fs.writeFileSync(badDuration, JSON.stringify({ command: 'true', unit: 'ns',
    samples: [
      { index: 0, duration_ns: -5, exit_code: 0 },
      { index: 1, duration_ns: 1.5, exit_code: 0 },
    ] }));
  const notJson = path.join(dir, 'not-json.json');
  fs.writeFileSync(notJson, 'not json{');

  const cases = [
    ['--candidate', good, '--output', out], // 缺 --baseline
    ['--baseline', good, '--output', out], // 缺 --candidate
    ['--baseline', good, '--candidate', good], // 缺 --output
    ['--baseline', path.join(dir, 'missing.json'), '--candidate', good, '--output', out],
    ['--baseline', notJson, '--candidate', good, '--output', out],
    ['--baseline', badUnit, '--candidate', good, '--output', out],
    ['--baseline', good, '--candidate', badCommand, '--output', out],
    ['--baseline', tooFew, '--candidate', good, '--output', out],
    ['--baseline', badDuration, '--candidate', good, '--output', out],
    ['--baseline', zeros, '--candidate', good, '--output', out], // 基线均值非正
    ['--baseline', good, '--candidate', good, '--output', out, '--alpha', '0'],
    ['--baseline', good, '--candidate', good, '--output', out, '--alpha', '1'],
    ['--baseline', good, '--candidate', good, '--output', out, '--alpha', 'abc'],
    ['--baseline', good, '--candidate', good, '--output', out, '--margin-percent', '0'],
    ['--baseline', good, '--candidate', good, '--output', out, '--margin-percent', '-1'],
    ['--baseline', good, '--candidate', good, '--output', out, '--margin-percent', 'abc'],
    ['--baseline', good, '--candidate', good, '--output', out, '--bogus', '1'],
  ];
  for (const args of cases) {
    const r = runCli(args);
    assert.equal(r.status, 2, `应退出码2: ${JSON.stringify(args)}`);
    assert.equal(r.stderr.trim().split('\n').length, 1, `stderr 应仅一条: ${r.stderr}`);
    assert.equal(fs.existsSync(out), false, `不应创建 output: ${JSON.stringify(args)}`);
  }
});

test('输入无效时不改写已存在的 output', () => {
  const dir = tempDir();
  const good = writeCollect(dir, 'good.json', [100, 100, 100]);
  const zeros = writeCollect(dir, 'zeros.json', [0, 0, 0]);
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const r = runCli(['--baseline', zeros, '--candidate', good, '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('output 写入失败：退出码 4', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 100, 100]);
  const candidate = writeCollect(dir, 'cand.json', [101, 101, 101]);
  const out = path.join(dir, 'no-such-dir', 'nested', 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});

test('summary 按 collect 七项口径重算，不采用输入文件中的 summary', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [10, 20, 30, 40]);
  const candidate = writeCollect(dir, 'cand.json', [10, 20, 30, 40]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.baseline_summary.mean, 25);
  assert.equal(result.baseline_summary.median, 25);
  assert.equal(result.baseline_summary.p95, 40);
  assert.equal(result.baseline_summary.stddev, Math.round(Math.sqrt(125) * 1e6) / 1e6);
});

test('相同输入与参数产出确定一致的 JSON', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [1, 2, 3]);
  const candidate = writeCollect(dir, 'cand.json', [4, 5, 6]);
  const o1 = path.join(dir, 'o1.json');
  const o2 = path.join(dir, 'o2.json');
  for (const o of [o1, o2]) {
    const rr = runCli(['--baseline', baseline, '--candidate', candidate,
      '--output', o, '--margin-percent', '250']);
    assert.equal(rr.status, 0, rr.stderr);
  }
  assert.equal(fs.readFileSync(o1, 'utf8'), fs.readFileSync(o2, 'utf8'));
});
