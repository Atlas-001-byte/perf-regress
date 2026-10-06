'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'compare', ...args], { encoding: 'utf8' });
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

test('回归：显著增加达到阈值 -> regression，结果含固定六项', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 102, 98, 101, 99]);
  const candidate = writeCollect(dir, 'cand.json', [120, 122, 118, 121, 119]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const result = readJson(out);
  assert.deepEqual(Object.keys(result),
    ['baseline_summary', 'candidate_summary', 'delta', 'welch', 'decision', 'attribution']);

  assert.deepEqual(Object.keys(result.baseline_summary),
    ['count', 'min', 'max', 'mean', 'median', 'p95', 'stddev']);
  assert.equal(result.baseline_summary.count, 5);
  assert.equal(result.baseline_summary.mean, 100);
  assert.equal(result.candidate_summary.mean, 120);

  assert.deepEqual(Object.keys(result.delta), ['mean', 'median', 'p95', 'stddev']);
  assert.deepEqual(Object.keys(result.delta.mean), ['ns', 'percent', 'confidence_interval']);
  assert.equal(result.delta.mean.ns, 20);
  assert.equal(result.delta.mean.percent, 20);
  // 95% 双侧 Welch 区间：diff=20，SE=1，df=8，t(0.975,8)=2.306004
  assert.deepEqual(result.delta.mean.confidence_interval, {
    level: 0.95,
    lower_ns: 17.693996,
    upper_ns: 22.306004,
    lower_percent: 17.693996,
    upper_percent: 22.306004,
  });
  assert.equal(result.delta.median.ns, 20);

  assert.deepEqual(Object.keys(result.welch),
    ['t_statistic', 'degrees_of_freedom', 'p_value']);
  assert.ok(result.welch.p_value <= 0.05);

  assert.equal(result.decision, 'regression');

  assert.deepEqual(Object.keys(result.attribution),
    ['central_tendency_percent', 'tail_latency_percent', 'variability_percent', 'dominant_factor']);
  assert.equal(result.attribution.central_tendency_percent, 20);
  assert.equal(result.attribution.dominant_factor, 'central_tendency');
});

test('改进：显著减少达到阈值 -> improvement，无正向归因 -> none', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [120, 122, 118, 121, 119]);
  const candidate = writeCollect(dir, 'cand.json', [100, 102, 98, 101, 99]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.decision, 'improvement');
  assert.ok(result.delta.mean.percent < 0);
  assert.equal(result.attribution.dominant_factor, 'none');
});

test('不显著 -> not_significant', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 110, 90, 105, 95, 120, 80]);
  const candidate = writeCollect(dir, 'cand.json', [101, 109, 91, 104, 96, 119, 81]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.decision, 'not_significant');
  assert.ok(result.welch.p_value > 0.05);
});

test('显著但未达阈值 -> no_material_change（零方差不同均值退化情形）', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 100, 100]);
  const candidate = writeCollect(dir, 'cand.json', [101, 101, 101]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  // 两边方差均为 0 且均值不同：t/df 为 null，p 为 0
  assert.deepEqual(result.welch, { t_statistic: null, degrees_of_freedom: null, p_value: 0 });
  assert.equal(result.delta.mean.percent, 1);
  assert.equal(result.decision, 'no_material_change');
});

test('零方差相同均值：t=0、df=null、p=1 -> not_significant', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [50, 50, 50]);
  const candidate = writeCollect(dir, 'cand.json', [50, 50]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.deepEqual(result.welch, { t_statistic: 0, degrees_of_freedom: null, p_value: 1 });
  assert.equal(result.decision, 'not_significant');
});

test('基线为 0：候选同为 0 时百分比为 0，候选非 0 时百分比为 null', () => {
  const dir = tempDir();
  const b0 = writeCollect(dir, 'b0.json', [0, 0, 0]);
  const c0 = writeCollect(dir, 'c0.json', [0, 0]);
  const out0 = path.join(dir, 'out0.json');
  const r0 = runCli(['--baseline', b0, '--candidate', c0, '--output', out0]);
  assert.equal(r0.status, 0, r0.stderr);
  assert.equal(readJson(out0).delta.mean.percent, 0);

  const c5 = writeCollect(dir, 'c5.json', [5, 5, 5]);
  const out1 = path.join(dir, 'out1.json');
  const r1 = runCli(['--baseline', b0, '--candidate', c5, '--output', out1]);
  assert.equal(r1.status, 0, r1.stderr);
  const result = readJson(out1);
  assert.equal(result.delta.mean.percent, null);
  assert.equal(result.delta.mean.ns, 5);
  // 百分比 null 视为达到阈值的增加
  assert.equal(result.decision, 'regression');
});

test('阈值与 alpha 可调：--min-change-percent、--alpha', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 100, 100]);
  const candidate = writeCollect(dir, 'cand.json', [103, 103, 103]);

  const out1 = path.join(dir, 'out1.json');
  const r1 = runCli(['--baseline', baseline, '--candidate', candidate,
    '--output', out1, '--min-change-percent', '2']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(readJson(out1).decision, 'regression'); // 3% >= 2%

  const out2 = path.join(dir, 'out2.json');
  const r2 = runCli(['--baseline', baseline, '--candidate', candidate,
    '--output', out2, '--min-change-percent=4']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readJson(out2).decision, 'no_material_change'); // 3% < 4%

  // alpha 生效：同一对样本 p≈0.066，默认 0.05 不显著，--alpha 0.5 显著
  const b2 = writeCollect(dir, 'b2.json', [100, 102, 98, 101, 99, 100, 103, 97]);
  const c2 = writeCollect(dir, 'c2.json', [102, 104, 100, 103, 101, 102, 105, 99]);
  const out3 = path.join(dir, 'out3.json');
  const r3 = runCli(['--baseline', b2, '--candidate', c2, '--output', out3]);
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(readJson(out3).decision, 'not_significant');

  const out4 = path.join(dir, 'out4.json');
  const r4 = runCli(['--baseline', b2, '--candidate', c2,
    '--output', out4, '--alpha', '0.5']);
  assert.equal(r4.status, 0, r4.stderr);
  const result4 = readJson(out4);
  assert.ok(result4.welch.p_value <= 0.5);
  // 2% 未达默认 5% 阈值
  assert.equal(result4.decision, 'no_material_change');
});

test('归因平手按 central_tendency > tail_latency > variability 顺序', () => {
  const dir = tempDir();
  // 候选各项均为基线两倍 -> mean/p95/stddev 百分比同为 100
  const baseline = writeCollect(dir, 'base.json', [50, 100, 150]);
  const candidate = writeCollect(dir, 'cand.json', [100, 200, 300]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.attribution.central_tendency_percent, 100);
  assert.equal(result.attribution.tail_latency_percent, 100);
  assert.equal(result.attribution.variability_percent, 100);
  assert.equal(result.attribution.dominant_factor, 'central_tendency');
});

test('归因取最大正向项：tail_latency 最大时 dominant_factor 为 tail_latency', () => {
  const dir = tempDir();
  // 基线 stddev 较大而 p95 低；候选尾部两项拉高 p95：
  // mean +35%，p95 +233.33%，stddev +160.96% -> tail_latency 最大
  const baseline = writeCollect(dir, 'base.json',
    [...Array(10).fill(50), ...Array(10).fill(150)]);
  const candidate = writeCollect(dir, 'cand.json',
    [...Array(10).fill(50), ...Array(8).fill(150), 500, 500]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.attribution.central_tendency_percent, 35);
  assert.ok(result.attribution.tail_latency_percent > result.attribution.variability_percent);
  assert.equal(result.attribution.dominant_factor, 'tail_latency');
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
});

test('输入无效：退出码 2，stderr 一条原因，不创建 output', () => {
  const dir = tempDir();
  const good = writeCollect(dir, 'good.json', [1, 2, 3]);
  const out = path.join(dir, 'out.json');

  const badUnit = path.join(dir, 'bad-unit.json');
  fs.writeFileSync(badUnit, JSON.stringify({ command: 'true', unit: 'ms', samples: [] }));
  const badCommand = writeCollect(dir, 'bad-command.json', [1, 2, 3], { command: 'false' });
  const tooFew = writeCollect(dir, 'too-few.json', [1]);
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
    ['--baseline', good, '--candidate', good, '--output', out, '--alpha', '0'],
    ['--baseline', good, '--candidate', good, '--output', out, '--alpha', '1'],
    ['--baseline', good, '--candidate', good, '--output', out, '--alpha', 'abc'],
    ['--baseline', good, '--candidate', good, '--output', out, '--min-change-percent', '-1'],
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
  const tooFew = writeCollect(dir, 'too-few.json', [1]);
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const r = runCli(['--baseline', tooFew, '--candidate', good, '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('output 写入失败：退出码 4', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [1, 2, 3]);
  const candidate = writeCollect(dir, 'cand.json', [4, 5, 6]);
  const out = path.join(dir, 'no-such-dir', 'nested', 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});

test('summary 按 collect 七项口径重算，不采用输入文件中的 summary', () => {
  const dir = tempDir();
  // 输入文件 summary 故意写错，结果应以重算为准
  const baseline = writeCollect(dir, 'base.json', [10, 20, 30, 40]);
  const candidate = writeCollect(dir, 'cand.json', [20, 40, 60, 80]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.baseline_summary.mean, 25);
  assert.equal(result.baseline_summary.median, 25);
  assert.equal(result.baseline_summary.p95, 40);
  assert.equal(result.baseline_summary.stddev, Math.round(Math.sqrt(125) * 1e6) / 1e6);
});

test('confidence_interval：level 随 alpha 变化，p 值与 decision 不受影响', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 102, 98, 101, 99]);
  const candidate = writeCollect(dir, 'cand.json', [120, 122, 118, 121, 119]);

  const out1 = path.join(dir, 'out1.json');
  const r1 = runCli(['--baseline', baseline, '--candidate', candidate, '--output', out1]);
  assert.equal(r1.status, 0, r1.stderr);
  const out2 = path.join(dir, 'out2.json');
  const r2 = runCli(['--baseline', baseline, '--candidate', candidate,
    '--output', out2, '--alpha', '0.01']);
  assert.equal(r2.status, 0, r2.stderr);

  const result1 = readJson(out1);
  const result2 = readJson(out2);
  const ci1 = result1.delta.mean.confidence_interval;
  const ci2 = result2.delta.mean.confidence_interval;
  assert.equal(ci1.level, 0.95);
  assert.equal(ci2.level, 0.99);
  // 更宽的区间：99% 区间严格包含 95% 区间
  assert.ok(ci2.lower_ns < ci1.lower_ns);
  assert.ok(ci2.upper_ns > ci1.upper_ns);
  // alpha 只影响区间 level 与宽度，不改变 p 值与 decision
  assert.equal(result2.welch.p_value, result1.welch.p_value);
  assert.equal(result2.decision, result1.decision);
  // 除置信区间外其余字段完全一致
  delete result1.delta.mean.confidence_interval;
  delete result2.delta.mean.confidence_interval;
  assert.deepEqual(result2, result1);
});

test('confidence_interval：相同输入与 alpha 产生确定一致的 JSON', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 102, 98, 101, 99, 103, 97]);
  const candidate = writeCollect(dir, 'cand.json', [110, 112, 108, 111, 109, 113, 107]);
  const out1 = path.join(dir, 'out1.json');
  const out2 = path.join(dir, 'out2.json');
  const args = ['--baseline', baseline, '--candidate', candidate, '--alpha', '0.1'];
  assert.equal(runCli([...args, '--output', out1]).status, 0);
  assert.equal(runCli([...args, '--output', out2]).status, 0);
  assert.equal(fs.readFileSync(out1, 'utf8'), fs.readFileSync(out2, 'utf8'));
  assert.equal(readJson(out1).delta.mean.confidence_interval.level, 0.9);
});

test('confidence_interval：零方差退化情形', () => {
  const dir = tempDir();
  // 均值相同：区间两端均为 0
  const b1 = writeCollect(dir, 'b1.json', [50, 50, 50]);
  const c1 = writeCollect(dir, 'c1.json', [50, 50]);
  const out1 = path.join(dir, 'out1.json');
  assert.equal(runCli(['--baseline', b1, '--candidate', c1, '--output', out1]).status, 0);
  assert.deepEqual(readJson(out1).delta.mean.confidence_interval, {
    level: 0.95,
    lower_ns: 0,
    upper_ns: 0,
    lower_percent: 0,
    upper_percent: 0,
  });

  // 均值不同：两端均为候选减基线均值
  const c2 = writeCollect(dir, 'c2.json', [53, 53, 53]);
  const out2 = path.join(dir, 'out2.json');
  assert.equal(runCli(['--baseline', b1, '--candidate', c2, '--output', out2]).status, 0);
  assert.deepEqual(readJson(out2).delta.mean.confidence_interval, {
    level: 0.95,
    lower_ns: 3,
    upper_ns: 3,
    lower_percent: 6,
    upper_percent: 6,
  });
});

test('confidence_interval：基线均值为 0 时百分比端点为 null', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [0, 0, 0]);
  const candidate = writeCollect(dir, 'cand.json', [5, 5, 5]);
  const out = path.join(dir, 'out.json');
  assert.equal(runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]).status, 0);
  assert.deepEqual(readJson(out).delta.mean.confidence_interval, {
    level: 0.95,
    lower_ns: 5,
    upper_ns: 5,
    lower_percent: null,
    upper_percent: null,
  });
});

test('confidence_interval：仅 delta.mean 携带，median/p95/stddev 不新增字段', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [100, 102, 98, 101, 99]);
  const candidate = writeCollect(dir, 'cand.json', [120, 122, 118, 121, 119]);
  const out = path.join(dir, 'out.json');
  assert.equal(runCli(['--baseline', baseline, '--candidate', candidate, '--output', out]).status, 0);
  const result = readJson(out);
  for (const key of ['median', 'p95', 'stddev']) {
    assert.deepEqual(Object.keys(result.delta[key]), ['ns', 'percent']);
  }
});
