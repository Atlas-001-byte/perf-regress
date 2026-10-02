'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'collect', ...args], { encoding: 'utf8' });
}

function withTempFile(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-'));
  return path.join(dir, prefix);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('成功采集：退出码 0，顶层字段与 samples/summary 正确', () => {
  const out = withTempFile('ok.json');
  const r = runCli(['--command', 'true', '--runs', '3', '--warmup', '1',
    '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const report = readJson(out);
  assert.deepEqual(Object.keys(report),
    ['command', 'runs', 'warmup', 'timeout_ms', 'unit', 'samples', 'summary', 'errors']);
  assert.equal(report.command, 'true');
  assert.equal(report.runs, 3);
  assert.equal(report.warmup, 1);
  assert.equal(report.timeout_ms, 5000);
  assert.equal(report.unit, 'ns');
  assert.equal(report.errors.length, 0);

  assert.equal(report.samples.length, 3);
  report.samples.forEach((s, i) => {
    assert.deepEqual(Object.keys(s), ['index', 'started_at', 'duration_ns', 'exit_code']);
    assert.equal(s.index, i);
    assert.match(s.started_at, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(Number.isSafeInteger(s.duration_ns), true);
    assert.ok(s.duration_ns >= 0);
    assert.equal(s.exit_code, 0);
  });

  assert.deepEqual(Object.keys(report.summary),
    ['count', 'min', 'max', 'mean', 'median', 'p95', 'stddev']);
  assert.equal(report.summary.count, 3);
  assert.equal(report.summary.count, report.samples.length);
});

test('warmup 缺省为 0', () => {
  const out = withTempFile('default-warmup.json');
  const r = runCli(['--command', 'true', '--runs', '1',
    '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readJson(out).warmup, 0);
});

test('measure nonzero_exit：退出码 3，仍写 JSON，该次被跳过', () => {
  const out = withTempFile('nonzero.json');
  const r = runCli(['--command', 'exit 7', '--runs', '2', '--warmup', '0',
    '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const report = readJson(out);
  assert.equal(report.samples.length, 0);
  assert.equal(report.summary.count, 0);
  assert.equal(report.errors.length, 2);
  assert.deepEqual(report.errors[0],
    { stage: 'measure', index: 0, reason: 'nonzero_exit', exit_code: 7 });
  assert.equal(report.errors[1].index, 1);
});

test('混合：成功与 nonzero 交错，samples 的 index 保留原始序号', () => {
  const out = withTempFile('mixed.json');
  // shell 状态无法直接拿到序号，用一个自增标记文件
  const marker = withTempFile('marker');
  fs.writeFileSync(marker, '0');
  const command = `n=$(cat ${marker}); echo $((n+1)) > ${marker}; [ "$n" = 0 ] && exit 5 || true`;
  const r = runCli(['--command', command, '--runs', '2',
    '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 3, r.stderr);
  const report = readJson(out);
  assert.equal(report.samples.length, 1);
  assert.equal(report.samples[0].index, 1);
  assert.deepEqual(report.errors[0],
    { stage: 'measure', index: 0, reason: 'nonzero_exit', exit_code: 5 });
});

test('measure timeout：reason=timeout，退出码 3', () => {
  const out = withTempFile('timeout.json');
  const start = Date.now();
  const r = runCli(['--command', 'sleep 5', '--runs', '1',
    '--timeout-ms', '200', '--output', out]);
  const elapsed = Date.now() - start;
  assert.equal(r.status, 3, r.stderr);
  assert.ok(elapsed < 2000, `超时未及时生效: ${elapsed}ms`);

  const report = readJson(out);
  assert.equal(report.samples.length, 0);
  assert.deepEqual(report.errors[0],
    { stage: 'measure', index: 0, reason: 'timeout', exit_code: null });
}, 30000);

test('warmup 失败但 measure 场景：command 恒失败时 warmup+measure 均记录', () => {
  const out = withTempFile('warmup-errors.json');
  const r = runCli(['--command', 'exit 3', '--runs', '1', '--warmup', '2',
    '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 3, r.stderr);
  const report = readJson(out);
  assert.equal(report.errors.length, 3);
  assert.deepEqual(report.errors.filter((e) => e.stage === 'warmup').map((e) => e.index), [0, 1]);
  assert.deepEqual(report.errors.filter((e) => e.stage === 'measure').map((e) => e.index), [0]);
  assert.ok(report.errors.every((e) => e.reason === 'nonzero_exit' && e.exit_code === 3));
});

test('参数错误：runs < 1 -> 退出码 2 且不创建 output', () => {
  const out = withTempFile('bad-runs.json');
  const r = runCli(['--command', 'true', '--runs', '0',
    '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.existsSync(out), false);
});

test('参数错误：warmup < 0', () => {
  const out = withTempFile('bad-warmup.json');
  const r = runCli(['--command', 'true', '--runs', '1', '--warmup', '-1',
    '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.existsSync(out), false);
});

test('参数错误：timeout-ms < 1、空 command、空 output、非整数、未知参数、缺少必填', () => {
  const out = withTempFile('bad.json');
  const cases = [
    ['--command', 'true', '--runs', '1', '--timeout-ms', '0', '--output', out],
    ['--command', '', '--runs', '1', '--timeout-ms', '5000', '--output', out],
    ['--runs', '1', '--timeout-ms', '5000', '--output', out],
    ['--command', 'true', '--runs', '1', '--timeout-ms', '5000', '--output', ''],
    ['--command', 'true', '--runs', 'abc', '--timeout-ms', '5000', '--output', out],
    ['--command', 'true', '--runs', '1', '--timeout-ms', '5000', '--output', out, '--bogus'],
    ['--command', 'true', '--timeout-ms', '5000', '--output', out],
    ['--command', 'true', '--runs', '1', '--timeout-ms', '5000'],
  ];
  for (const args of cases) {
    const r = runCli(args);
    assert.equal(r.status, 2, `应退出码2: ${JSON.stringify(args)} / ${r.stderr}`);
  }
  assert.equal(fs.existsSync(out), false);
});

test('参数错误时不改写已存在的 output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-'));
  const out = path.join(dir, 'existing.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const r = runCli(['--command', 'true', '--runs', '0',
    '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('进程无法启动（命令不存在，shell 127）：退出码 2，不写 output，按 nonzero_exit 而非 timeout', () => {
  const out = withTempFile('no-proc.json');
  const r = runCli(['--command', 'this_command_does_not_exist_xyz_9182', '--runs', '2',
    '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(fs.existsSync(out), false);
  assert.match(r.stderr, /nonzero_exit/);
  assert.doesNotMatch(r.stderr, /timeout/);
});

test('进程无法启动时不改写已存在的 output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-'));
  const out = path.join(dir, 'existing.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const r = runCli(['--command', 'this_command_does_not_exist_xyz_9182', '--runs', '1',
    '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('output 写入失败：退出码 4', () => {
  const out = path.join(withTempFile('no-such-dir'), 'nested', 'result.json');
  const r = runCli(['--command', 'true', '--runs', '1',
    '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});

test('measure 全部失败时 summary 各字段为 null 且 count 为 0', () => {
  const out = withTempFile('empty-summary.json');
  const r = runCli(['--command', 'exit 1', '--runs', '1',
    '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 3);
  const report = readJson(out);
  assert.deepEqual(report.summary,
    { count: 0, min: null, max: null, mean: null, median: null, p95: null, stddev: null });
});
