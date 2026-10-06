'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'ab-paired', ...args], { encoding: 'utf8' });
}

function withTempFile(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-ab-paired-'));
  return path.join(dir, prefix);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const SIDE_KEYS = ['command', 'runs', 'warmup', 'timeout_ms', 'unit', 'samples', 'summary', 'errors'];
const PAIRED_KEYS = ['pairs', 'summary', 't_test', 'confidence_interval', 'decision', 'attribution'];

test('成功：退出码 0，顶层字段与两侧 collect 口径正确，paired 完整', () => {
  const out = withTempFile('ok.json');
  const r = runCli(['--baseline-command', 'true', '--candidate-command', 'true',
    '--runs', '3', '--warmup', '1', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const report = readJson(out);
  assert.deepEqual(Object.keys(report), ['baseline', 'candidate', 'paired']);

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
  }

  const { paired } = report;
  assert.deepEqual(Object.keys(paired), PAIRED_KEYS);

  assert.equal(paired.pairs.length, 3);
  paired.pairs.forEach((p, i) => {
    assert.deepEqual(Object.keys(p),
      ['index', 'baseline_duration_ns', 'candidate_duration_ns', 'delta_ns']);
    assert.equal(p.index, i);
    assert.equal(Number.isSafeInteger(p.baseline_duration_ns), true);
    assert.equal(Number.isSafeInteger(p.candidate_duration_ns), true);
    assert.equal(p.delta_ns, p.candidate_duration_ns - p.baseline_duration_ns);
  });

  assert.deepEqual(Object.keys(paired.summary), ['count', 'mean', 'median', 'p95', 'stddev']);
  assert.equal(paired.summary.count, 3);
  const deltas = paired.pairs.map((p) => p.delta_ns);
  const mean = deltas.reduce((a, b) => a + b, 0) / 3;
  assert.equal(paired.summary.mean, Math.round(mean * 1e6) / 1e6);

  assert.deepEqual(Object.keys(paired.t_test),
    ['t_statistic', 'degrees_of_freedom', 'p_value']);
  assert.equal(paired.t_test.degrees_of_freedom, 2);

  assert.deepEqual(Object.keys(paired.confidence_interval),
    ['level', 'lower_ns', 'upper_ns', 'lower_percent', 'upper_percent']);
  assert.equal(paired.confidence_interval.level, 0.95);
  assert.ok(paired.confidence_interval.lower_ns <= paired.confidence_interval.upper_ns);

  assert.ok(['regression', 'improvement', 'no_material_change', 'not_significant']
    .includes(paired.decision));

  assert.deepEqual(Object.keys(paired.attribution), [
    'central_tendency_percent',
    'tail_latency_percent',
    'variability_percent',
    'dominant_factor',
  ]);
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

test('单侧某轮失败：该轮不成对，完整 pairs >= 2 时仍写统计，退出码 3', () => {
  const out = withTempFile('partial.json');
  const marker = withTempFile('marker');
  fs.writeFileSync(marker, '0');
  // 候选第 2 次执行（measure index 1）失败，其余成功
  const candidate = `n=$(cat ${marker}); echo $((n+1)) > ${marker}; [ "$n" = 1 ] && exit 7 || true`;
  const r = runCli(['--baseline-command', 'true', '--candidate-command', candidate,
    '--runs', '3', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const report = readJson(out);
  assert.equal(report.baseline.samples.length, 3);
  assert.equal(report.candidate.samples.length, 2);
  assert.deepEqual(report.candidate.errors,
    [{ stage: 'measure', index: 1, reason: 'nonzero_exit', exit_code: 7 }]);

  const { paired } = report;
  assert.deepEqual(paired.pairs.map((p) => p.index), [0, 2]);
  assert.equal(paired.summary.count, 2);
  assert.notEqual(paired.t_test, null);
  assert.equal(paired.t_test.degrees_of_freedom, 1);
  assert.notEqual(paired.confidence_interval, null);
  assert.notEqual(paired.decision, null);
});

test('候选全部失败：pairs 为 0，t_test/confidence_interval/decision 为 null，退出码 3', () => {
  const out = withTempFile('nopairs.json');
  const r = runCli(['--baseline-command', 'true', '--candidate-command', 'exit 7',
    '--runs', '2', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const report = readJson(out);
  const { paired } = report;
  assert.deepEqual(paired.pairs, []);
  assert.deepEqual(paired.summary, {
    count: 0, mean: null, median: null, p95: null, stddev: null,
  });
  assert.equal(paired.t_test, null);
  assert.equal(paired.confidence_interval, null);
  assert.equal(paired.decision, null);
  assert.deepEqual(paired.attribution, {
    central_tendency_percent: null,
    tail_latency_percent: null,
    variability_percent: null,
    dominant_factor: 'none',
  });
});

test('仅一对完整：summary.count 为 1，t_test/confidence_interval/decision 为 null，退出码 3', () => {
  const out = withTempFile('onepair.json');
  const marker = withTempFile('marker');
  fs.writeFileSync(marker, '0');
  // 候选第 2 次执行（measure index 1）失败，仅 index 0 成对
  const candidate = `n=$(cat ${marker}); echo $((n+1)) > ${marker}; [ "$n" = 1 ] && exit 7 || true`;
  const r = runCli(['--baseline-command', 'true', '--candidate-command', candidate,
    '--runs', '2', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const { paired } = readJson(out);
  assert.deepEqual(paired.pairs.map((p) => p.index), [0]);
  assert.equal(paired.summary.count, 1);
  assert.equal(paired.summary.mean, paired.pairs[0].delta_ns);
  assert.equal(paired.t_test, null);
  assert.equal(paired.confidence_interval, null);
  assert.equal(paired.decision, null);
  // 有一对完整样本：attribution 仍按 compare 口径给出
  assert.notEqual(paired.attribution, null);
  assert.equal(typeof paired.attribution.dominant_factor, 'string');
});

test('--key=value 写法与可选参数 --alpha/--min-change-percent', () => {
  const out = withTempFile('eq.json');
  const r = runCli(['--baseline-command=true', '--candidate-command=true',
    '--runs=2', '--warmup=0', '--timeout-ms=5000', `--output=${out}`,
    '--alpha=0.1', '--min-change-percent=10']);
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.equal(report.baseline.warmup, 0);
  assert.equal(report.paired.confidence_interval.level, 0.9);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-ab-paired-'));
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
