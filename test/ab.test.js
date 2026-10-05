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

test('成功：退出码 0，顶层字段与两侧 collect 口径正确，comparison 完整', () => {
  const out = withTempFile('ok.json');
  const r = runCli(['--baseline-command', 'true', '--candidate-command', 'true',
    '--runs', '3', '--warmup', '1', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const report = readJson(out);
  assert.deepEqual(Object.keys(report), ['baseline', 'candidate', 'comparison']);

  for (const sideName of ['baseline', 'candidate']) {
    const side = report[sideName];
    assert.deepEqual(Object.keys(side), SIDE_KEYS);
    assert.equal(side.command, 'true');
    assert.equal(side.runs, 3);
    assert.equal(side.warmup, 1);
    assert.equal(side.timeout_ms, 5000);
    assert.equal(side.unit, 'ns');
    assert.equal(side.errors.length, 0);
    assert.equal(side.samples.length, 3);
    side.samples.forEach((s, i) => {
      assert.deepEqual(Object.keys(s), ['index', 'started_at', 'duration_ns', 'exit_code']);
      assert.equal(s.index, i);
      assert.equal(s.exit_code, 0);
      assert.equal(Number.isSafeInteger(s.duration_ns), true);
    });
    assert.equal(side.summary.count, 3);
  }

  assert.deepEqual(Object.keys(report.comparison), COMPARISON_KEYS);
  assert.equal(report.comparison.baseline_summary.count, 3);
  assert.equal(report.comparison.candidate_summary.count, 3);
  assert.ok(['regression', 'improvement', 'no_material_change', 'not_significant']
    .includes(report.comparison.decision));
});

test('交错顺序：先全部预热再测量，每轮先 baseline 后 candidate', () => {
  const out = withTempFile('order.json');
  const log = withTempFile('order.log');
  const r = runCli([
    '--baseline-command', `echo b >> ${log}`,
    '--candidate-command', `echo c >> ${log}`,
    '--runs', '2', '--warmup', '2', '--timeout-ms', '5000', '--output', out,
  ]);
  assert.equal(r.status, 0, r.stderr);
  const order = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(order, ['b', 'c', 'b', 'c', 'b', 'c', 'b', 'c']);
});

test('--key=value 写法与可选参数 --alpha/--min-change-percent', () => {
  const out = withTempFile('eq.json');
  const r = runCli(['--baseline-command=true', '--candidate-command=true',
    '--runs=2', '--warmup=0', '--timeout-ms=5000', `--output=${out}`,
    '--alpha=0.1', '--min-change-percent=10']);
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.equal(report.baseline.warmup, 0);
  assert.notEqual(report.comparison, null);
});

test('measure nonzero_exit：退出码 3，仍写 JSON，该次被跳过，另一侧不受影响', () => {
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
  // 候选侧有效样本不足 2：comparison 为 null
  assert.equal(report.comparison, null);
});

test('单侧 measure timeout：记录后跳过，不影响另一侧，退出码 3', () => {
  const out = withTempFile('timeout.json');
  const start = Date.now();
  const r = runCli(['--baseline-command', 'true', '--candidate-command', 'sleep 5',
    '--runs', '2', '--timeout-ms', '200', '--output', out]);
  const elapsed = Date.now() - start;
  assert.equal(r.status, 3, r.stderr);
  assert.ok(elapsed < 4000, `超时未及时生效: ${elapsed}ms`);

  const report = readJson(out);
  assert.equal(report.baseline.samples.length, 2);
  assert.equal(report.candidate.samples.length, 0);
  assert.deepEqual(report.candidate.errors.map((e) => e.reason), ['timeout', 'timeout']);
  assert.ok(report.candidate.errors.every((e) => e.stage === 'measure' && e.exit_code === null));
  assert.equal(report.comparison, null);
}, 30000);

test('仅 warmup 出错：记录到 errors，退出码仍为 0，comparison 正常', () => {
  const out = withTempFile('warmup-errors.json');
  const marker = withTempFile('marker');
  fs.writeFileSync(marker, '0');
  // 每侧首次执行（即各自的 warmup）失败，后续 measure 成功
  const command = (tag) => {
    const m = `${marker}-${tag}`;
    return `n=$(cat ${m} 2>/dev/null || echo 0); echo $((n+1)) > ${m}; [ "$n" = 0 ] && exit 5 || true`;
  };
  const r = runCli(['--baseline-command', command('b'), '--candidate-command', command('c'),
    '--runs', '2', '--warmup', '1', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const report = readJson(out);
  for (const sideName of ['baseline', 'candidate']) {
    assert.deepEqual(report[sideName].errors,
      [{ stage: 'warmup', index: 0, reason: 'nonzero_exit', exit_code: 5 }]);
    assert.equal(report[sideName].samples.length, 2);
  }
  assert.notEqual(report.comparison, null);
});

test('参数错误：runs < 2、缺必填、空命令、未知参数、非法 alpha，均退出码 2 且不创建 output', () => {
  const out = withTempFile('bad.json');
  const cases = [
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '1',
      '--timeout-ms', '5000', '--output', out],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '0',
      '--timeout-ms', '5000', '--output', out],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', 'abc',
      '--timeout-ms', '5000', '--output', out],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2',
      '--timeout-ms', '0', '--output', out],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2',
      '--warmup', '-1', '--timeout-ms', '5000', '--output', out],
    ['--baseline-command', '', '--candidate-command', 'true', '--runs', '2',
      '--timeout-ms', '5000', '--output', out],
    ['--baseline-command', 'true', '--runs', '2', '--timeout-ms', '5000', '--output', out],
    ['--candidate-command', 'true', '--runs', '2', '--timeout-ms', '5000', '--output', out],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2',
      '--timeout-ms', '5000'],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2',
      '--timeout-ms', '5000', '--output', out, '--bogus'],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2',
      '--timeout-ms', '5000', '--output', out, '--alpha', '1'],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2',
      '--timeout-ms', '5000', '--output', out, '--min-change-percent', '-1'],
    ['--baseline-command', 'true', '--candidate-command', 'true', '--runs', '2',
      '--timeout-ms', '5000', '--output', out, '--runs', '3'],
  ];
  for (const args of cases) {
    const r = runCli(args);
    assert.equal(r.status, 2, `应退出码2: ${JSON.stringify(args)} / ${r.stderr}`);
    assert.ok(r.stderr.length > 0, 'stderr 应给出原因');
  }
  assert.equal(fs.existsSync(out), false);
});

test('参数错误与启动失败时不改写已存在的 output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-ab-'));
  const out = path.join(dir, 'existing.json');
  fs.writeFileSync(out, 'KEEP-ME');

  const r1 = runCli(['--baseline-command', 'true', '--candidate-command', 'true',
    '--runs', '1', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r1.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');

  const r2 = runCli(['--baseline-command', 'this_command_does_not_exist_xyz_9182',
    '--candidate-command', 'true', '--runs', '2', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r2.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('进程无法启动（shell 127）：退出码 2，不写 output，按 nonzero_exit 而非 timeout', () => {
  const out = withTempFile('no-proc.json');
  const r = runCli(['--baseline-command', 'true',
    '--candidate-command', 'this_command_does_not_exist_xyz_9182',
    '--runs', '2', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(fs.existsSync(out), false);
  assert.match(r.stderr, /nonzero_exit/);
  assert.doesNotMatch(r.stderr, /timeout/);
});

test('output 写入失败：退出码 4', () => {
  const out = path.join(withTempFile('no-such-dir'), 'nested', 'result.json');
  const r = runCli(['--baseline-command', 'true', '--candidate-command', 'true',
    '--runs', '2', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});
