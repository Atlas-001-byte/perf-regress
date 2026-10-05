'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'ab-suite', ...args], { encoding: 'utf8' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-ab-suite-'));
}

function writeManifest(dir, cases) {
  const p = path.join(dir, 'manifest.json');
  fs.writeFileSync(p, JSON.stringify({ cases }));
  return p;
}

function writeRawManifest(dir, text) {
  const p = path.join(dir, 'manifest.json');
  fs.writeFileSync(p, text);
  return p;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const CASE_KEYS = ['name', 'baseline', 'candidate', 'comparison', 'adjusted_p_value', 'decision'];
const SIDE_KEYS = ['command', 'runs', 'warmup', 'timeout_ms', 'unit', 'samples', 'summary', 'errors'];
const COMPARISON_KEYS = ['baseline_summary', 'candidate_summary', 'delta', 'welch', 'decision', 'attribution'];

const OK_CASE = (name, extra = {}) => ({
  name,
  baseline_command: 'true',
  candidate_command: 'true',
  runs: 2,
  warmup: 1,
  timeout_ms: 5000,
  ...extra,
});

test('成功：退出码 0，顶层与 case 结构正确，cases 按 manifest 顺序', () => {
  const dir = tempDir();
  const out = path.join(dir, 'ok.json');
  const manifest = writeManifest(dir, [
    OK_CASE('alpha'),
    OK_CASE('beta', { runs: 3, warmup: 0 }),
  ]);
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const report = readJson(out);
  assert.deepEqual(Object.keys(report), ['cases', 'suite_summary', 'suite_attribution']);
  assert.deepEqual(report.cases.map((c) => c.name), ['alpha', 'beta']);

  for (const c of report.cases) {
    assert.deepEqual(Object.keys(c), CASE_KEYS);
    for (const sideName of ['baseline', 'candidate']) {
      const side = c[sideName];
      assert.deepEqual(Object.keys(side), SIDE_KEYS);
      assert.equal(side.command, 'true');
      assert.equal(side.unit, 'ns');
      assert.equal(side.errors.length, 0);
      assert.equal(side.samples.length, side.runs);
      assert.equal(side.summary.count, side.runs);
    }
    assert.deepEqual(Object.keys(c.comparison), COMPARISON_KEYS);
    assert.equal(typeof c.adjusted_p_value, 'number');
    assert.ok(['regression', 'improvement', 'no_material_change', 'not_significant']
      .includes(c.decision));
  }

  assert.deepEqual(Object.keys(report.suite_summary),
    ['total', 'comparable', 'incomplete', 'suite_decision']);
  assert.equal(report.suite_summary.total, 2);
  assert.equal(report.suite_summary.comparable, 2);
  assert.equal(report.suite_summary.incomplete, 0);
  assert.ok(['regression', 'improvement', 'no_material_change', 'not_significant']
    .includes(report.suite_summary.suite_decision));

  assert.deepEqual(Object.keys(report.suite_attribution), [
    'central_tendency_percent', 'tail_latency_percent', 'variability_percent', 'dominant_factor',
  ]);
});

test('交错顺序：case 内先两侧预热再测量，每轮先 baseline 后 candidate；case 间串行', () => {
  const dir = tempDir();
  const out = path.join(dir, 'order.json');
  const log = path.join(dir, 'order.log');
  const manifest = writeManifest(dir, [
    OK_CASE('one', {
      baseline_command: `echo 1b >> ${log}`,
      candidate_command: `echo 1c >> ${log}`,
      runs: 2,
      warmup: 1,
    }),
    OK_CASE('two', {
      baseline_command: `echo 2b >> ${log}`,
      candidate_command: `echo 2c >> ${log}`,
      runs: 2,
      warmup: 1,
    }),
  ]);
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const order = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(order, ['1b', '1c', '1b', '1c', '1b', '1c', '2b', '2c', '2b', '2c', '2b', '2c']);
});

test('--key=value 写法与可选参数 --alpha/--min-change-percent', () => {
  const dir = tempDir();
  const out = path.join(dir, 'eq.json');
  const manifest = writeManifest(dir, [OK_CASE('alpha')]);
  const r = runCli([`--manifest=${manifest}`, `--output=${out}`,
    '--alpha=0.1', '--min-change-percent=10']);
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.equal(report.cases.length, 1);
  assert.notEqual(report.cases[0].comparison, null);
});

test('measure 错误：退出码 3，仍写完整 JSON；该 case comparison 为 null，adjusted_p_value/decision 为 null', () => {
  const dir = tempDir();
  const out = path.join(dir, 'me.json');
  const manifest = writeManifest(dir, [
    OK_CASE('good'),
    OK_CASE('bad', { candidate_command: 'exit 7', warmup: 0 }),
  ]);
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const report = readJson(out);
  const [good, bad] = report.cases;
  assert.notEqual(good.comparison, null);
  assert.equal(typeof good.adjusted_p_value, 'number');
  assert.notEqual(good.decision, null);

  assert.equal(bad.candidate.samples.length, 0);
  assert.deepEqual(bad.candidate.errors, [
    { stage: 'measure', index: 0, reason: 'nonzero_exit', exit_code: 7 },
    { stage: 'measure', index: 1, reason: 'nonzero_exit', exit_code: 7 },
  ]);
  assert.equal(bad.comparison, null);
  assert.equal(bad.adjusted_p_value, null);
  assert.equal(bad.decision, null);

  assert.equal(report.suite_summary.total, 2);
  assert.equal(report.suite_summary.comparable, 1);
  assert.equal(report.suite_summary.incomplete, 1);
  assert.notEqual(report.suite_summary.suite_decision, 'incomplete');
});

test('全部 case 均不可比较：suite_decision 为 incomplete，suite_attribution 全 null', () => {
  const dir = tempDir();
  const out = path.join(dir, 'all-bad.json');
  const manifest = writeManifest(dir, [
    OK_CASE('a', { candidate_command: 'exit 3' }),
    OK_CASE('b', { baseline_command: 'exit 4' }),
  ]);
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const report = readJson(out);
  assert.equal(report.suite_summary.comparable, 0);
  assert.equal(report.suite_summary.incomplete, 2);
  assert.equal(report.suite_summary.suite_decision, 'incomplete');
  // 沿用 compare-suite 口径：null 按正无穷参与 dominant_factor 比较
  assert.deepEqual(report.suite_attribution, {
    central_tendency_percent: null,
    tail_latency_percent: null,
    variability_percent: null,
    dominant_factor: 'central_tendency',
  });
  for (const c of report.cases) {
    assert.equal(c.comparison, null);
    assert.equal(c.adjusted_p_value, null);
    assert.equal(c.decision, null);
  }
});

test('仅 warmup 出错：记录到 errors，退出码仍为 0', () => {
  const dir = tempDir();
  const out = path.join(dir, 'warmup.json');
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, '0');
  const command = (tag) => {
    const m = `${marker}-${tag}`;
    return `n=$(cat ${m} 2>/dev/null || echo 0); echo $((n+1)) > ${m}; [ "$n" = 0 ] && exit 5 || true`;
  };
  const manifest = writeManifest(dir, [
    OK_CASE('alpha', { baseline_command: command('b'), candidate_command: command('c') }),
  ]);
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const report = readJson(out);
  const c = report.cases[0];
  for (const sideName of ['baseline', 'candidate']) {
    assert.deepEqual(c[sideName].errors,
      [{ stage: 'warmup', index: 0, reason: 'nonzero_exit', exit_code: 5 }]);
    assert.equal(c[sideName].samples.length, 2);
  }
  assert.notEqual(c.comparison, null);
});

test('manifest 校验失败：退出码 2，stderr 给出原因，不创建或改写 output', () => {
  const dir = tempDir();
  const out = path.join(dir, 'bad.json');
  fs.writeFileSync(out, 'KEEP-ME');

  const good = OK_CASE('ok');
  const invalidManifests = [
    writeRawManifest(dir, 'not json'),
    writeRawManifest(dir, '[]'),
    writeRawManifest(dir, '{}'),
    writeRawManifest(dir, JSON.stringify({ cases: [] })),
    writeRawManifest(dir, JSON.stringify({ cases: [null] })),
    writeRawManifest(dir, JSON.stringify({ cases: [{ ...good, name: '' }] })),
    writeRawManifest(dir, JSON.stringify({ cases: [{ ...good, name: 1 }] })),
    writeRawManifest(dir, JSON.stringify({ cases: [good, good] })),
    writeRawManifest(dir, JSON.stringify({ cases: [{ ...good, baseline_command: '' }] })),
    writeRawManifest(dir, JSON.stringify({ cases: [{ ...good, candidate_command: 3 }] })),
    writeRawManifest(dir, JSON.stringify({ cases: [{ ...good, runs: 1 }] })),
    writeRawManifest(dir, JSON.stringify({ cases: [{ ...good, runs: 2.5 }] })),
    writeRawManifest(dir, JSON.stringify({ cases: [{ ...good, warmup: -1 }] })),
    writeRawManifest(dir, JSON.stringify({ cases: [{ ...good, timeout_ms: 0 }] })),
    writeRawManifest(dir, JSON.stringify({ cases: [{ name: 'x', baseline_command: 'true', candidate_command: 'true' }] })),
    path.join(dir, 'missing.json'),
  ];
  for (const manifest of invalidManifests) {
    const r = runCli(['--manifest', manifest, '--output', out]);
    assert.equal(r.status, 2, `应退出码2: ${manifest} / ${r.stderr}`);
    assert.ok(r.stderr.length > 0, 'stderr 应给出原因');
    assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
  }
});

test('参数错误：缺必填、未知参数、非法 alpha，均退出码 2 且不创建 output', () => {
  const dir = tempDir();
  const out = path.join(dir, 'args.json');
  const manifest = writeManifest(dir, [OK_CASE('alpha')]);
  const cases = [
    ['--output', out],
    ['--manifest', manifest],
    ['--manifest', '', '--output', out],
    ['--manifest', manifest, '--output', out, '--bogus'],
    ['--manifest', manifest, '--output', out, '--alpha', '1'],
    ['--manifest', manifest, '--output', out, '--alpha', '0'],
    ['--manifest', manifest, '--output', out, '--min-change-percent', '-1'],
    ['--manifest', manifest, '--output', out, '--manifest', manifest],
  ];
  for (const args of cases) {
    const r = runCli(args);
    assert.equal(r.status, 2, `应退出码2: ${JSON.stringify(args)} / ${r.stderr}`);
    assert.ok(r.stderr.length > 0, 'stderr 应给出原因');
  }
  assert.equal(fs.existsSync(out), false);
});

test('未知字段被忽略', () => {
  const dir = tempDir();
  const out = path.join(dir, 'unknown.json');
  const manifest = writeRawManifest(dir, JSON.stringify({
    cases: [{ ...OK_CASE('alpha'), extra: 'ignored', nested: { x: 1 } }],
    other: true,
  }));
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.equal(report.cases[0].name, 'alpha');
});

test('进程无法启动（shell 127）：退出码 2，不写 output，按 nonzero_exit 报告', () => {
  const dir = tempDir();
  const out = path.join(dir, 'no-proc.json');
  const manifest = writeManifest(dir, [
    OK_CASE('alpha'),
    OK_CASE('beta', { candidate_command: 'this_command_does_not_exist_xyz_9182' }),
  ]);
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(fs.existsSync(out), false);
  assert.match(r.stderr, /nonzero_exit/);
  assert.doesNotMatch(r.stderr, /timeout/);
});

test('output 写入失败：退出码 4', () => {
  const dir = tempDir();
  const out = path.join(dir, 'no-such-dir', 'nested', 'result.json');
  const manifest = writeManifest(dir, [OK_CASE('alpha')]);
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});

test('BH 校正与 suite_decision 优先级：regression 优先于 improvement', () => {
  const dir = tempDir();
  const out = path.join(dir, 'bh.json');
  // 通过不同 sleep 制造稳定差异：case slow 候选明显更慢（regression），
  // case fast 候选明显更快（improvement）。
  const slow = {
    name: 'slow',
    baseline_command: 'true',
    candidate_command: 'sleep 0.05',
    runs: 3,
    warmup: 0,
    timeout_ms: 5000,
  };
  const fast = {
    name: 'fast',
    baseline_command: 'sleep 0.05',
    candidate_command: 'true',
    runs: 3,
    warmup: 0,
    timeout_ms: 5000,
  };
  const manifest = writeManifest(dir, [slow, fast]);
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const report = readJson(out);
  const [slowCase, fastCase] = report.cases;
  assert.equal(slowCase.decision, 'regression');
  assert.equal(fastCase.decision, 'improvement');
  assert.equal(report.suite_summary.suite_decision, 'regression');
  // BH 校正后的 p 值不小于任一原始 p 值
  assert.ok(slowCase.adjusted_p_value >= slowCase.comparison.welch.p_value - 1e-9);
  assert.ok(fastCase.adjusted_p_value >= fastCase.comparison.welch.p_value - 1e-9);
});
