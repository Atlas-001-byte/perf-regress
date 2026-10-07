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

test('等价：差值在界内且两个单侧检验显著 -> equivalent，结果含固定六项', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 102, 98, 101, 99]);
  const candidate = writeCollect(dir, 'cand.json', [101, 103, 99, 102, 100]);
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

  // delta 仅含 mean：ns、percent 与 1 - 2*alpha 的双侧区间
  assert.deepEqual(Object.keys(result.delta), ['mean']);
  assert.deepEqual(Object.keys(result.delta.mean), ['ns', 'percent', 'confidence_interval']);
  assert.equal(result.delta.mean.ns, 1);
  assert.equal(result.delta.mean.percent, 1);
  assert.deepEqual(result.delta.mean.confidence_interval, {
    level: 0.9,
    lower_ns: -0.859548,
    upper_ns: 2.859548,
    lower_percent: -0.859548,
    upper_percent: 2.859548,
  });

  // margin = 基线均值 * margin-percent / 100
  assert.deepEqual(result.margin, { ns: 5, percent: 5 });

  // se = sqrt(2.5/5 + 2.5/5) = 1，df = 8；
  // lower: t = (1+5)/1 = 6 取右尾；upper: t = (1-5)/1 = -4 取左尾
  assert.deepEqual(Object.keys(result.equivalence_test), ['lower', 'upper']);
  assert.deepEqual(result.equivalence_test.lower,
    { t_statistic: 6, degrees_of_freedom: 8, p_value: 0.000162 });
  assert.deepEqual(result.equivalence_test.upper,
    { t_statistic: -4, degrees_of_freedom: 8, p_value: 0.001975 });

  assert.equal(result.decision, 'equivalent');
});

test('差值显著高于正 margin -> above_margin', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 102, 98, 101, 99]);
  const candidate = writeCollect(dir, 'cand.json', [120, 122, 118, 121, 119]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.equivalence_test.lower.p_value, 0);
  assert.equal(result.equivalence_test.upper.p_value, 1);
  assert.equal(result.decision, 'above_margin');
});

test('差值显著低于负 margin -> below_margin', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 102, 98, 101, 99]);
  const candidate = writeCollect(dir, 'cand.json', [80, 82, 78, 81, 79]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.equivalence_test.lower.p_value, 1);
  assert.equal(result.equivalence_test.upper.p_value, 0);
  assert.equal(result.decision, 'below_margin');
});

test('差值在界内但单侧检验不显著 -> inconclusive（不显著不等于等价）', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 110, 90, 105, 95, 120, 80]);
  const candidate = writeCollect(dir, 'cand.json', [103, 113, 93, 108, 98, 123, 83]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.ok(result.equivalence_test.lower.p_value > 0.05);
  assert.ok(result.equivalence_test.upper.p_value > 0.05);
  assert.equal(result.decision, 'inconclusive');
});

test('零方差界内：两 p_value 为 0 -> equivalent', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 100, 100]);
  const candidate = writeCollect(dir, 'cand.json', [101, 101, 101]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.deepEqual(result.equivalence_test.lower,
    { t_statistic: null, degrees_of_freedom: null, p_value: 0 });
  assert.deepEqual(result.equivalence_test.upper,
    { t_statistic: null, degrees_of_freedom: null, p_value: 0 });
  assert.equal(result.decision, 'equivalent');
});

test('零方差等于边界：对应侧 p_value 为 1', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 100, 100]);

  // 差值恰为 +margin（5）：upper 的 p 为 1 -> above_margin
  const cUp = writeCollect(dir, 'c-up.json', [105, 105, 105]);
  const oUp = path.join(dir, 'up.json');
  let r = runCli(['--baseline', baseline, '--candidate', cUp, '--output', oUp]);
  assert.equal(r.status, 0, r.stderr);
  let result = readJson(oUp);
  assert.deepEqual(result.equivalence_test.upper,
    { t_statistic: 0, degrees_of_freedom: null, p_value: 1 });
  assert.equal(result.equivalence_test.lower.p_value, 0);
  assert.equal(result.decision, 'above_margin');

  // 差值恰为 -margin：lower 的 p 为 1 -> below_margin
  const cLo = writeCollect(dir, 'c-lo.json', [95, 95, 95]);
  const oLo = path.join(dir, 'lo.json');
  r = runCli(['--baseline', baseline, '--candidate', cLo, '--output', oLo]);
  assert.equal(r.status, 0, r.stderr);
  result = readJson(oLo);
  assert.deepEqual(result.equivalence_test.lower,
    { t_statistic: 0, degrees_of_freedom: null, p_value: 1 });
  assert.equal(result.equivalence_test.upper.p_value, 0);
  assert.equal(result.decision, 'below_margin');
});

test('零方差越界：p_value 取 0 或 1', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 100, 100]);

  const cUp = writeCollect(dir, 'c-up.json', [110, 110, 110]);
  const oUp = path.join(dir, 'up.json');
  let r = runCli(['--baseline', baseline, '--candidate', cUp, '--output', oUp]);
  assert.equal(r.status, 0, r.stderr);
  let result = readJson(oUp);
  assert.deepEqual(result.equivalence_test.lower,
    { t_statistic: null, degrees_of_freedom: null, p_value: 0 });
  assert.deepEqual(result.equivalence_test.upper,
    { t_statistic: null, degrees_of_freedom: null, p_value: 1 });
  assert.equal(result.decision, 'above_margin');

  const cLo = writeCollect(dir, 'c-lo.json', [90, 90, 90]);
  const oLo = path.join(dir, 'lo.json');
  r = runCli(['--baseline', baseline, '--candidate', cLo, '--output', oLo]);
  assert.equal(r.status, 0, r.stderr);
  result = readJson(oLo);
  assert.deepEqual(result.equivalence_test.lower,
    { t_statistic: null, degrees_of_freedom: null, p_value: 1 });
  assert.deepEqual(result.equivalence_test.upper,
    { t_statistic: null, degrees_of_freedom: null, p_value: 0 });
  assert.equal(result.decision, 'below_margin');
});

test('--margin-percent 与 --alpha 可调：margin 与区间 level 随之变化', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 102, 98, 101, 99]);
  const candidate = writeCollect(dir, 'cand.json', [101, 103, 99, 102, 100]);

  const out1 = path.join(dir, 'out1.json');
  const r1 = runCli(['--baseline', baseline, '--candidate', candidate,
    '--output', out1, '--margin-percent', '2']);
  assert.equal(r1.status, 0, r1.stderr);
  const result1 = readJson(out1);
  assert.deepEqual(result1.margin, { ns: 2, percent: 2 });
  // 差值 1 在 ±2 界内，但 upper 检验（t=-1）不显著 -> inconclusive
  assert.deepEqual(result1.equivalence_test.lower,
    { t_statistic: 3, degrees_of_freedom: 8, p_value: 0.008536 });
  assert.deepEqual(result1.equivalence_test.upper,
    { t_statistic: -1, degrees_of_freedom: 8, p_value: 0.173297 });
  assert.equal(result1.decision, 'inconclusive');

  // margin 1%：差值 1 恰在边界，有方差时 t 为 0、p 为 0.5 -> inconclusive
  const out2 = path.join(dir, 'out2.json');
  const r2 = runCli(['--baseline', baseline, '--candidate', candidate,
    '--output', out2, '--margin-percent=1']);
  assert.equal(r2.status, 0, r2.stderr);
  const result2 = readJson(out2);
  assert.deepEqual(result2.margin, { ns: 1, percent: 1 });
  assert.deepEqual(result2.equivalence_test.lower,
    { t_statistic: 2, degrees_of_freedom: 8, p_value: 0.040258 });
  assert.deepEqual(result2.equivalence_test.upper,
    { t_statistic: 0, degrees_of_freedom: 8, p_value: 0.5 });
  assert.equal(result2.decision, 'inconclusive');

  // alpha 只改变区间 level 与判定阈值：--alpha 0.1 -> level 0.8
  const out3 = path.join(dir, 'out3.json');
  const r3 = runCli(['--baseline', baseline, '--candidate', candidate,
    '--output', out3, '--alpha', '0.1']);
  assert.equal(r3.status, 0, r3.stderr);
  const result3 = readJson(out3);
  assert.equal(result3.delta.mean.confidence_interval.level, 0.8);
  assert.equal(result3.decision, 'equivalent');
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
  const baseline = mk('base.json', [[100, 0], [102, 0], [9999, 1], [98, 0]]);
  const candidate = mk('cand.json', [[100, 0], [102, 0], [98, 0], [5, 7]]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.baseline_summary.count, 3);
  assert.equal(result.candidate_summary.count, 3);
  assert.equal(result.baseline_summary.max, 102);
  assert.equal(result.decision, 'equivalent');
});

test('输入无效：退出码 2，stderr 一条原因，不创建 output', () => {
  const dir = tempDir();
  const good = writeCollect(dir, 'good.json', [1, 2, 3]);
  const out = path.join(dir, 'out.json');

  const badUnit = path.join(dir, 'bad-unit.json');
  fs.writeFileSync(badUnit, JSON.stringify({ command: 'true', unit: 'ms', samples: [] }));
  const badCommand = writeCollect(dir, 'bad-command.json', [1, 2, 3], { command: 'false' });
  const tooFew = writeCollect(dir, 'too-few.json', [1]);
  const zeroMean = writeCollect(dir, 'zero-mean.json', [0, 0, 0]);
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
    ['--baseline', zeroMean, '--candidate', good, '--output', out], // 基线均值非正
    ['--baseline', good, '--candidate', good, '--output', out, '--margin-percent', '0'],
    ['--baseline', good, '--candidate', good, '--output', out, '--margin-percent', '-1'],
    ['--baseline', good, '--candidate', good, '--output', out, '--margin-percent', 'abc'],
    ['--baseline', good, '--candidate', good, '--output', out, '--alpha', '0'],
    ['--baseline', good, '--candidate', good, '--output', out, '--alpha', '1'],
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
  const good = writeCollect(dir, 'good.json', [1, 2, 3]);
  const zeroMean = writeCollect(dir, 'zero-mean.json', [0, 0, 0]);
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const r = runCli(['--baseline', zeroMean, '--candidate', good, '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('output 写入失败：退出码 4', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [1, 2, 3]);
  const candidate = writeCollect(dir, 'cand.json', [1, 2, 3]);
  const out = path.join(dir, 'no-such-dir', 'nested', 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});

test('相同输入产出确定一致的 JSON', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 102, 98, 101, 99]);
  const candidate = writeCollect(dir, 'cand.json', [101, 103, 99, 102, 100]);
  const o1 = path.join(dir, 'o1.json');
  const o2 = path.join(dir, 'o2.json');
  for (const o of [o1, o2]) {
    const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', o]);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(fs.readFileSync(o1, 'utf8'), fs.readFileSync(o2, 'utf8'));
});
