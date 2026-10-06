'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');
const { buildPairs, buildPairedResult } = require('../lib/ab-paired');
const { tCriticalValue } = require('../lib/stats');

const r6 = (v) => Math.round(v * 1e6) / 1e6;

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
const DECISIONS = ['regression', 'improvement', 'no_material_change', 'not_significant'];

test('成功：退出码 0，顶层 baseline/candidate/paired 字段完整，配对统计齐全', () => {
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

  const paired = report.paired;
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
  for (const key of ['mean', 'median', 'p95', 'stddev']) {
    assert.equal(typeof paired.summary[key], 'number', `summary.${key} 应为数值`);
  }

  // delta 为两侧真实耗时之差，t/区间数值随执行波动，这里只校验结构与类型
  assert.deepEqual(Object.keys(paired.t_test),
    ['t_statistic', 'degrees_of_freedom', 'p_value']);
  assert.equal(typeof paired.t_test.t_statistic, 'number');
  assert.equal(paired.t_test.degrees_of_freedom, 2);
  assert.ok(paired.t_test.p_value >= 0 && paired.t_test.p_value <= 1);
  const ci = paired.confidence_interval;
  assert.deepEqual(Object.keys(ci),
    ['level', 'lower_ns', 'upper_ns', 'lower_percent', 'upper_percent']);
  assert.equal(ci.level, 0.95);
  assert.ok(ci.lower_ns <= ci.upper_ns);
  assert.ok(DECISIONS.includes(paired.decision));
  assert.deepEqual(Object.keys(paired.attribution),
    ['central_tendency_percent', 'tail_latency_percent',
      'variability_percent', 'dominant_factor']);
});

test('纯函数：buildPairs 按 index 内连接，delta 为候选减基线，按 index 升序', () => {
  const baseline = { samples: [
    { index: 0, duration_ns: 100 },
    { index: 2, duration_ns: 300 },
    { index: 1, duration_ns: 200 },
  ] };
  const candidate = { samples: [
    { index: 1, duration_ns: 250 },
    { index: 0, duration_ns: 110 },
    { index: 3, duration_ns: 400 },
  ] };
  assert.deepEqual(buildPairs(baseline, candidate), [
    { index: 0, baseline_duration_ns: 100, candidate_duration_ns: 110, delta_ns: 10 },
    { index: 1, baseline_duration_ns: 200, candidate_duration_ns: 250, delta_ns: 50 },
  ]);
});

test('纯函数：完整 pairs >= 2 时 t_test/区间/decision/attribution 按配对口径计算', () => {
  // 两组配对：baseline [100,100]，candidate [130,110]，deltas [30,10]
  // mean=20，样本方差=200，se=10，t=2，df=1；mean 增幅 20% >= 5% 但 n=2 时 p≈0.39 不显著
  const pairs = [
    { index: 0, baseline_duration_ns: 100, candidate_duration_ns: 130, delta_ns: 30 },
    { index: 1, baseline_duration_ns: 100, candidate_duration_ns: 110, delta_ns: 10 },
  ];
  const paired = buildPairedResult(pairs, 0.05, 5);
  assert.deepEqual(paired.summary,
    { count: 2, mean: 20, median: 20, p95: 30, stddev: 10 });
  assert.equal(paired.t_test.t_statistic, 2);
  assert.equal(paired.t_test.degrees_of_freedom, 1);
  assert.equal(paired.t_test.p_value, 0.295167); // t=2, df=1 双侧
  assert.equal(paired.decision, 'not_significant');
  // 区间：t*(df=1)=12.706205…，se=10
  const tc = tCriticalValue(1, 0.05) * 10;
  const ci = paired.confidence_interval;
  assert.equal(ci.level, 0.95);
  assert.equal(ci.lower_ns, r6(20 - tc));
  assert.equal(ci.upper_ns, r6(20 + tc));
  assert.equal(ci.lower_percent, r6((20 - tc) / 100 * 100));
  assert.equal(ci.upper_percent, r6((20 + tc) / 100 * 100));
  // 归因：配对后 baseline [100,100]（p95=100、stddev=0），
  // candidate [130,110]（p95=130、stddev=10）：mean +20%，p95 +30%，stddev 为 null
  assert.equal(paired.attribution.central_tendency_percent, 20);
  assert.equal(paired.attribution.tail_latency_percent, 30);
  assert.equal(paired.attribution.variability_percent, null);
  // null 视为无穷大正向，dominant 为 variability
  assert.equal(paired.attribution.dominant_factor, 'variability');
});

test('纯函数：强一致配对差值给出 regression；配对 t 比 Welch 更能检出成对变化', () => {
  // 每对候选恰好多 10ns：deltas 恒为 10 -> 零方差、均值非 0 -> p=0，显著回归
  const pairs = [
    { index: 0, baseline_duration_ns: 100, candidate_duration_ns: 110, delta_ns: 10 },
    { index: 1, baseline_duration_ns: 200, candidate_duration_ns: 210, delta_ns: 10 },
    { index: 2, baseline_duration_ns: 300, candidate_duration_ns: 310, delta_ns: 10 },
  ];
  const paired = buildPairedResult(pairs, 0.05, 5);
  assert.deepEqual(paired.t_test, { t_statistic: null, degrees_of_freedom: null, p_value: 0 });
  assert.equal(paired.confidence_interval.lower_ns, 10);
  assert.equal(paired.confidence_interval.upper_ns, 10);
  assert.equal(paired.decision, 'regression');
});

test('纯函数：pairs 少于 2 时 t_test/区间/decision/attribution 为 null', () => {
  const one = buildPairedResult(
    [{ index: 0, baseline_duration_ns: 100, candidate_duration_ns: 110, delta_ns: 10 }],
    0.05, 5);
  assert.equal(one.summary.count, 1);
  assert.equal(one.t_test, null);
  assert.equal(one.confidence_interval, null);
  assert.equal(one.decision, null);
  assert.equal(one.attribution, null);

  const zero = buildPairedResult([], 0.05, 5);
  assert.deepEqual(zero.summary,
    { count: 0, mean: null, median: null, p95: null, stddev: null });
  assert.equal(zero.t_test, null);
  assert.equal(zero.attribution, null);
});

test('交错顺序与 ab 一致：先全部预热再测量，每轮先 baseline 后 candidate', () => {
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

test('--key=value 写法与可选参数 --alpha/--min-change-percent（level=0.9）', () => {
  const out = withTempFile('eq.json');
  const r = runCli(['--baseline-command=true', '--candidate-command=true',
    '--runs=2', '--warmup=0', '--timeout-ms=5000', `--output=${out}`,
    '--alpha=0.1', '--min-change-percent=10']);
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.equal(report.baseline.warmup, 0);
  assert.equal(report.paired.confidence_interval.level, 0.9);
  assert.equal(report.paired.pairs.length, 2);
});

test('配对内连接：候选个别轮次失败时该轮不配对，其余配对保留，退出码 3', () => {
  const out = withTempFile('partial.json');
  const marker = withTempFile('partial-marker');
  // 候选第 1 轮（index=1）退出 5，其余轮次成功
  const candidateCommand =
    `n=$(cat ${marker} 2>/dev/null || echo 0); echo $((n+1)) > ${marker}; [ "$n" = "1" ] && exit 5 || true`;
  const r = runCli(['--baseline-command', 'true', '--candidate-command', candidateCommand,
    '--runs', '3', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const report = readJson(out);
  // 两侧 samples 各自独立：baseline 三个，candidate 两个（index 0、2）
  assert.equal(report.baseline.samples.length, 3);
  assert.equal(report.candidate.samples.length, 2);
  assert.deepEqual(report.candidate.samples.map((s) => s.index), [0, 2]);
  assert.deepEqual(report.candidate.errors,
    [{ stage: 'measure', index: 1, reason: 'nonzero_exit', exit_code: 5 }]);

  const paired = report.paired;
  assert.deepEqual(paired.pairs.map((p) => p.index), [0, 2]);
  assert.equal(paired.summary.count, 2);
  // 完整 pairs 达到 2：仍写出统计
  assert.notEqual(paired.t_test, null);
  assert.notEqual(paired.confidence_interval, null);
  assert.ok(DECISIONS.includes(paired.decision));
  assert.notEqual(paired.attribution, null);
});

test('pairs 少于 2：退出码 3，summary.count 为完整数，统计字段为 null', () => {
  const out = withTempFile('one-pair.json');
  const marker = withTempFile('one-marker');
  // 候选仅 index=0 成功，其余三轮失败
  const candidateCommand =
    `n=$(cat ${marker} 2>/dev/null || echo 0); echo $((n+1)) > ${marker}; [ "$n" != "0" ] && exit 7 || true`;
  const r = runCli(['--baseline-command', 'true', '--candidate-command', candidateCommand,
    '--runs', '4', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const paired = readJson(out).paired;
  assert.deepEqual(paired.pairs.map((p) => p.index), [0]);
  assert.equal(paired.summary.count, 1);
  assert.equal(paired.t_test, null);
  assert.equal(paired.confidence_interval, null);
  assert.equal(paired.decision, null);
});

test('无完整配对：summary 除 count 外为 null，退出码 3', () => {
  const out = withTempFile('zero-pair.json');
  const r = runCli(['--baseline-command', 'true', '--candidate-command', 'exit 9',
    '--runs', '2', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const paired = readJson(out).paired;
  assert.equal(paired.pairs.length, 0);
  assert.deepEqual(paired.summary,
    { count: 0, mean: null, median: null, p95: null, stddev: null });
  assert.equal(paired.t_test, null);
  assert.equal(paired.confidence_interval, null);
  assert.equal(paired.decision, null);
  assert.equal(paired.attribution, null);
});

test('单侧 measure timeout：该轮不配对，记录后继续，退出码 3', () => {
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
  assert.equal(report.paired.pairs.length, 0);
  assert.equal(report.paired.t_test, null);
}, 30000);

test('仅 warmup 出错：记录到 errors，退出码仍为 0，配对统计正常', () => {
  const out = withTempFile('warmup-errors.json');
  const marker = withTempFile('warmup-marker');
  fs.writeFileSync(marker, '0');
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
  }
  assert.equal(report.paired.pairs.length, 2);
  assert.notEqual(report.paired.t_test, null);
});

test('基线某轮失败而候选成功：该轮同样不配对', () => {
  const out = withTempFile('baseline-skip.json');
  const marker = withTempFile('base-marker');
  const baselineCommand =
    `n=$(cat ${marker} 2>/dev/null || echo 0); echo $((n+1)) > ${marker}; [ "$n" = "0" ] && exit 3 || true`;
  const r = runCli(['--baseline-command', baselineCommand, '--candidate-command', 'true',
    '--runs', '3', '--timeout-ms', '5000', '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const report = readJson(out);
  assert.deepEqual(report.baseline.samples.map((s) => s.index), [1, 2]);
  assert.equal(report.candidate.samples.length, 3);
  assert.deepEqual(report.paired.pairs.map((p) => p.index), [1, 2]);
  assert.equal(report.paired.summary.count, 2);
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
      '--timeout-ms', '5000', '--output', out, '--alpha', '0'],
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
