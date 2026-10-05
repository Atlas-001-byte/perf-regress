'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'ab', ...args], { encoding: 'utf8' });
}

function withTempFile(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-ab-'));
  return path.join(dir, prefix);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const SIDE_KEYS = ['command', 'runs', 'warmup', 'timeout_ms', 'unit', 'samples', 'summary', 'errors'];
const COMPARISON_KEYS = ['baseline_summary', 'candidate_summary', 'delta', 'welch', 'decision', 'attribution'];

test('成功采集：退出码 0，baseline/candidate/comparison 结构正确', () => {
  const out = withTempFile('ok.json');
  const r = runCli(['--baseline-command', 'true', '--candidate-command', 'true',
    '--runs', '3', '--warmup', '1', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const report = readJson(out);
  assert.deepEqual(Object.keys(report), ['baseline', 'candidate', 'comparison']);

  for (const [side, command] of [['baseline', 'true'], ['candidate', 'true']]) {
    const s = report[side];
    assert.deepEqual(Object.keys(s), SIDE_KEYS);
    assert.equal(s.command, command);
    assert.equal(s.runs, 3);
    assert.equal(s.warmup, 1);
    assert.equal(s.timeout_ms, 5000);
    assert.equal(s.unit, 'ns');
    assert.equal(s.errors.length, 0);
    assert.equal(s.samples.length, 3);
    s.samples.forEach((sample, i) => {
      assert.deepEqual(Object.keys(sample), ['index', 'started_at', 'duration_ns', 'exit_code']);
      assert.equal(sample.index, i);
      assert.equal(Number.isSafeInteger(sample.duration_ns), true);
      assert.equal(sample.exit_code, 0);
    });
    assert.equal(s.summary.count, 3);
  }

  assert.deepEqual(Object.keys(report.comparison), COMPARISON_KEYS);
  assert.equal(report.comparison.baseline_summary.count, 3);
  assert.equal(report.comparison.candidate_summary.count, 3);
  assert.ok(['regression', 'improvement', 'no_material_change', 'not_significant']
    .includes(report.comparison.decision));
});

test('交错顺序：全部预热后再测量，每轮先 baseline 后 candidate，全程串行', () => {
  const out = withTempFile('order.json');
  const log = withTempFile('order.log');
  fs.writeFileSync(log, '');
  const r = runCli(['--baseline-command', `echo B >> ${log}`,
    '--candidate-command', `echo C >> ${log}`,
    '--runs', '2', '--warmup', '2', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const order = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(order, ['B', 'C', 'B', 'C', 'B', 'C', 'B', 'C']);
});

test('--key=value 形式与缺省 warmup/alpha/min-change-percent', () => {
  const out = withTempFile('eq.json');
  const r = runCli(['--baseline-command=true', '--candidate-command=true',
    '--runs=2', '--timeout-ms=5000', `--output=${out}`]);
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.equal(report.baseline.warmup, 0);
  assert.equal(report.candidate.warmup, 0);
  assert.notEqual(report.comparison, null);
});

test('显著回归：candidate 明显更慢时 decision 为 regression', () => {
  const out = withTempFile('regression.json');
  const r = runCli(['--baseline-command', 'true', '--candidate-command', 'sleep 0.05',
    '--runs', '3', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.equal(report.comparison.decision, 'regression');
  assert.ok(report.comparison.delta.mean.percent >= 5);
}, 30000);

test('measure nonzero_exit：该侧跳过该次后继续，退出码 3，另一侧不受影响', () => {
  const out = withTempFile('nonzero.json');
  const r = runCli(['--baseline-command', 'true', '--candidate-command', 'exit 7',
    '--runs', '2', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const report = readJson(out);
  assert.equal(report.baseline.samples.length, 2);
  assert.equal(report.baseline.errors.length, 0);
  assert.equal(report.candidate.samples.length, 0);
  assert.equal(report.candidate.summary.count, 0);
  assert.deepEqual(report.candidate.errors, [
    { stage: 'measure', index: 0, reason: 'nonzero_exit', exit_code: 7 },
    { stage: 'measure', index: 1, reason: 'nonzero_exit', exit_code: 7 },
  ]);
  // 候选侧有效样本不足 2，comparison 为 null
  assert.equal(report.comparison, null);
});

test('warmup nonzero_exit 只记录不影响退出码；errors 的 index 在本侧从 0 计数', () => {
  const out = withTempFile('warmup-errors.json');
  const marker = withTempFile('marker');
  fs.writeFileSync(marker, '0');
  // 候选侧：第一次（warmup）失败，之后成功
  const candidate = `n=$(cat ${marker}); echo $((n+1)) > ${marker}; [ "$n" = 0 ] && exit 5 || true`;
  const r = runCli(['--baseline-command', 'true', '--candidate-command', candidate,
    '--runs', '2', '--warmup', '1', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const report = readJson(out);
  assert.deepEqual(report.candidate.errors,
    [{ stage: 'warmup', index: 0, reason: 'nonzero_exit', exit_code: 5 }]);
  assert.equal(report.candidate.samples.length, 2);
  assert.notEqual(report.comparison, null);
});

test('单侧 timeout 不影响另一侧及后续轮次，退出码 3', () => {
  const out = withTempFile('timeout.json');
  const marker = withTempFile('marker');
  fs.writeFileSync(marker, '0');
  // 候选侧：第一轮超时，第二轮快速成功
  const candidate = `n=$(cat ${marker}); echo $((n+1)) > ${marker}; [ "$n" = 0 ] && sleep 5 || true`;
  const r = runCli(['--baseline-command', 'true', '--candidate-command', candidate,
    '--runs', '2', '--timeout-ms', '300', '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const report = readJson(out);
  assert.equal(report.baseline.samples.length, 2);
  assert.deepEqual(report.candidate.errors,
    [{ stage: 'measure', index: 0, reason: 'timeout', exit_code: null }]);
  // 超时后轮次继续：候选侧仍有一个有效样本
  assert.equal(report.candidate.samples.length, 1);
  assert.equal(report.candidate.samples[0].index, 1);
  // 候选侧有效样本不足 2
  assert.equal(report.comparison, null);
}, 30000);

test('参数错误：runs < 2 -> 退出码 2 且不创建 output', () => {
  const out = withTempFile('bad-runs.json');
  const r = runCli(['--baseline-command', 'true', '--candidate-command', 'true',
    '--runs', '1', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /runs/);
  assert.equal(fs.existsSync(out), false);
});

test('参数错误：空命令、缺必填、越界数值、未知参数均退出 2 且不创建 output', () => {
  const out = withTempFile('bad.json');
  const cases = [
    ['--baseline-command', '', '--candidate-command', 'true', '--runs', '2', '--timeout-ms', '5000', '--output', out],
    ['--baseline-command', 'true', '--candidate-command', '', '--runs', '2', '--timeout-ms', '5000', '--output', out],
    ['--candidate-command', 'true', '--runs', '2', '--timeout-ms', '5000', '--output', out],
    ['--baseline-command', 'true', '--runs', '2', '--timeout-ms', '5000', '--output', out],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2', '--timeout-ms', '5000'],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2', '--timeout-ms', '5000', '--output', ''],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '0', '--timeout-ms', '5000', '--output', out],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', 'abc', '--timeout-ms', '5000', '--output', out],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2', '--warmup', '-1', '--timeout-ms', '5000', '--output', out],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2', '--timeout-ms', '0', '--output', out],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2', '--timeout-ms', '5000', '--output', out, '--alpha', '1'],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2', '--timeout-ms', '5000', '--output', out, '--alpha', '0'],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2', '--timeout-ms', '5000', '--output', out, '--min-change-percent', '-1'],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2', '--timeout-ms', '5000', '--output', out, '--bogus'],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2', '--timeout-ms', '5000', '--output', out, '--runs', '3'],
  ];
  for (const args of cases) {
    const r = runCli(args);
    assert.equal(r.status, 2, `应退出码2: ${JSON.stringify(args)} / ${r.stderr}`);
    assert.ok(r.stderr.length > 0, 'stderr 应输出原因');
  }
  assert.equal(fs.existsSync(out), false);
});

test('参数错误时不改写已存在的 output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-ab-'));
  const out = path.join(dir, 'existing.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const r = runCli(['--baseline-command', 'true', '--candidate-command', 'true',
    '--runs', '1', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('进程无法启动（shell 127）：退出码 2，不写 output，按 nonzero_exit 而非 timeout', () => {
  const out = withTempFile('no-proc.json');
  const r = runCli(['--baseline-command', 'this_command_does_not_exist_xyz_9182',
    '--candidate-command', 'true', '--runs', '2', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(fs.existsSync(out), false);
  assert.match(r.stderr, /nonzero_exit/);
  assert.doesNotMatch(r.stderr, /timeout/);
});

test('候选侧进程无法启动同样致命：退出码 2 且不改写已存在 output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-ab-'));
  const out = path.join(dir, 'existing.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const r = runCli(['--baseline-command', 'true',
    '--candidate-command', 'this_command_does_not_exist_xyz_9182',
    '--runs', '2', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('output 写入失败：退出码 4', () => {
  const out = path.join(withTempFile('no-such-dir'), 'nested', 'result.json');
  const r = runCli(['--baseline-command', 'true', '--candidate-command', 'true',
    '--runs', '2', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});
