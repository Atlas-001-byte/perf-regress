'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'ab-paired-suite', ...args], { encoding: 'utf8' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-ab-paired-suite-'));
}

function writeManifest(dir, name, cases, extra = {}) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify({ ...extra, cases }));
  return p;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const SIDE_KEYS = ['command', 'runs', 'warmup', 'timeout_ms', 'unit', 'samples', 'summary', 'errors'];
const PAIRED_KEYS = ['pairs', 'summary', 't_test', 'confidence_interval', 'decision', 'attribution'];
const CASE_KEYS = ['name', 'baseline', 'candidate', 'paired', 'adjusted_p_value', 'decision'];
const SUMMARY_KEYS = ['total', 'regression', 'improvement',
  'no_material_change', 'not_significant', 'suite_decision'];

const CASE = (over = {}) => ({
  name: 'c',
  baseline_command: 'true',
  candidate_command: 'true',
  runs: 4,
  warmup: 0,
  timeout_ms: 5000,
  ...over,
});

test('成功：退出码 0；顶层/逐 case 字段固定，cases 按 manifest 顺序，BH 与 decision 正确', () => {
  const dir = tempDir();
  // 效应量远大于计时噪声：+150ms / -150ms，配对 t 必显著
  const manifest = writeManifest(dir, 'm.json', [
    CASE({ name: 'reg', baseline_command: 'sleep 0.12', candidate_command: 'sleep 0.30' }),
    CASE({ name: 'imp', baseline_command: 'sleep 0.30', candidate_command: 'sleep 0.12' }),
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const result = readJson(out);
  assert.deepEqual(Object.keys(result), ['cases', 'suite_summary', 'suite_attribution']);
  assert.deepEqual(result.cases.map((c) => c.name), ['reg', 'imp']);

  for (const c of result.cases) {
    assert.deepEqual(Object.keys(c), CASE_KEYS);
    for (const sideName of ['baseline', 'candidate']) {
      const side = c[sideName];
      assert.deepEqual(Object.keys(side), SIDE_KEYS);
      assert.equal(side.unit, 'ns');
      assert.equal(side.samples.length, 4);
      assert.equal(side.summary.count, 4);
      assert.equal(side.errors.length, 0);
    }
    assert.deepEqual(Object.keys(c.paired), PAIRED_KEYS);
    assert.equal(c.paired.pairs.length, 4);
    c.paired.pairs.forEach((p, i) => {
      assert.deepEqual(Object.keys(p),
        ['index', 'baseline_duration_ns', 'candidate_duration_ns', 'delta_ns']);
      assert.equal(p.index, i);
      assert.equal(p.delta_ns, p.candidate_duration_ns - p.baseline_duration_ns);
    });
    assert.equal(c.paired.summary.count, 4);
    assert.equal(c.paired.t_test.degrees_of_freedom, 3);
    assert.equal(c.paired.confidence_interval.level, 0.95);
    assert.notEqual(c.paired.decision, null);
    assert.equal(typeof c.adjusted_p_value, 'number');
    assert.ok(['regression', 'improvement', 'no_material_change', 'not_significant']
      .includes(c.decision));
    // BH 校正后的 p 不小于原始 p（m=2 且两者均极显著时取等）
    assert.ok(c.adjusted_p_value >= c.paired.t_test.p_value);
  }

  const [reg, imp] = result.cases;
  assert.equal(reg.decision, 'regression');
  assert.equal(reg.paired.decision, 'regression');
  assert.equal(imp.decision, 'improvement');
  assert.equal(imp.paired.decision, 'improvement');

  assert.deepEqual(Object.keys(result.suite_summary), SUMMARY_KEYS);
  assert.deepEqual(result.suite_summary, {
    total: 2,
    regression: 1,
    improvement: 1,
    no_material_change: 0,
    not_significant: 0,
    suite_decision: 'regression',
  });

  assert.deepEqual(Object.keys(result.suite_attribution),
    ['central_tendency_percent', 'tail_latency_percent',
      'variability_percent', 'dominant_factor']);
  assert.equal(typeof result.suite_attribution.central_tendency_percent, 'number');
}, 60000);

test('case 间串行、case 内沿用 ab-paired 交错：先两侧预热再测量，每轮先 baseline 后 candidate', () => {
  const dir = tempDir();
  const log = path.join(dir, 'order.log');
  const manifest = writeManifest(dir, 'm.json', [
    CASE({
      name: 'a', runs: 2, warmup: 1,
      baseline_command: `echo ab >> ${log}`,
      candidate_command: `echo ac >> ${log}`,
    }),
    CASE({
      name: 'b', runs: 2, warmup: 1,
      baseline_command: `echo bb >> ${log}`,
      candidate_command: `echo bc >> ${log}`,
    }),
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const order = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(order, [
    'ab', 'ac', // case a 预热 1 轮
    'ab', 'ac', 'ab', 'ac', // case a 测量 2 轮
    'bb', 'bc', // case b 预热 1 轮
    'bb', 'bc', 'bb', 'bc', // case b 测量 2 轮
  ]);
});

test('--key=value 写法、未知字段忽略、--alpha/--min-change-percent 生效', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', [
    CASE({ name: 'reg', baseline_command: 'sleep 0.12', candidate_command: 'sleep 0.30',
      bogus_field: 'ignored' }),
  ], { top_level_ignored: 1 });
  const out = path.join(dir, 'out.json');
  const r = runCli([`--manifest=${manifest}`, `--output=${out}`,
    '--alpha=0.01', '--min-change-percent=10']);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.cases[0].decision, 'regression');
  assert.equal(result.cases[0].paired.confidence_interval.level, 0.99);
  assert.equal(result.suite_summary.suite_decision, 'regression');
}, 60000);

test('单侧单次 measure 失败：退出码 3，失败轮不成对，pairs>=2 仍可比较并参与 BH', () => {
  const dir = tempDir();
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, '0');
  // 候选第 2 次执行（measure index 1）失败，其余成功，runs=3 -> 2 个完整对
  const candidate = `n=$(cat ${marker}); echo $((n+1)) > ${marker}; [ "$n" = 1 ] && exit 7 || true`;
  const manifest = writeManifest(dir, 'm.json', [
    CASE({ name: 'partial', runs: 3, candidate_command: candidate }),
    CASE({ name: 'good', runs: 3 }),
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const result = readJson(out);
  const [partial, good] = result.cases;
  assert.equal(partial.baseline.samples.length, 3);
  assert.equal(partial.candidate.samples.length, 2);
  assert.deepEqual(partial.candidate.errors,
    [{ stage: 'measure', index: 1, reason: 'nonzero_exit', exit_code: 7 }]);
  assert.deepEqual(partial.paired.pairs.map((p) => p.index), [0, 2]);
  assert.equal(partial.paired.summary.count, 2);
  assert.notEqual(partial.paired.t_test, null);
  assert.equal(partial.paired.t_test.degrees_of_freedom, 1);
  assert.notEqual(partial.paired.decision, null);
  assert.equal(typeof partial.adjusted_p_value, 'number');
  assert.notEqual(partial.decision, null);

  // 两个 case 均可比较：BH m=2，校正值不小于原始值
  assert.ok(good.adjusted_p_value >= good.paired.t_test.p_value);
  assert.ok(partial.adjusted_p_value >= partial.paired.t_test.p_value);

  assert.equal(result.suite_summary.total, 2);
  assert.equal(result.suite_summary.regression + result.suite_summary.improvement
    + result.suite_summary.no_material_change + result.suite_summary.not_significant, 2);
});

test('候选全部失败：pairs 为 0，paired 统计/区间/decision 与顶层两项为 null，退出码 3', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', [
    CASE({ name: 'bad', candidate_command: 'exit 7' }),
    CASE({ name: 'good', runs: 3 }),
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const result = readJson(out);
  const [bad, good] = result.cases;
  assert.equal(bad.baseline.samples.length, 4);
  assert.equal(bad.candidate.samples.length, 0);
  assert.deepEqual(bad.paired.pairs, []);
  assert.deepEqual(bad.paired.summary, {
    count: 0, mean: null, median: null, p95: null, stddev: null,
  });
  assert.equal(bad.paired.t_test, null);
  assert.equal(bad.paired.confidence_interval, null);
  assert.equal(bad.paired.decision, null);
  assert.deepEqual(bad.paired.attribution, {
    central_tendency_percent: null,
    tail_latency_percent: null,
    variability_percent: null,
    dominant_factor: 'none',
  });
  assert.equal(bad.adjusted_p_value, null);
  assert.equal(bad.decision, null);

  // 仅 good 一个可比较 case 参与 BH：校正值等于原始 p
  assert.notEqual(good.paired, null);
  assert.equal(good.adjusted_p_value, good.paired.t_test.p_value);

  assert.equal(result.suite_summary.total, 2);
  // 四类计数只统计可比较 case（good 一个）
  assert.equal(result.suite_summary.regression + result.suite_summary.improvement
    + result.suite_summary.no_material_change + result.suite_summary.not_significant, 1);
  assert.notEqual(result.suite_summary.suite_decision, 'incomplete');

  // 套件归因只汇总可比较 case（即 good 一个 case 的百分比）
  assert.equal(result.suite_attribution.central_tendency_percent,
    good.paired.attribution.central_tendency_percent);
  assert.equal(result.suite_attribution.tail_latency_percent,
    good.paired.attribution.tail_latency_percent);
  assert.equal(result.suite_attribution.variability_percent,
    good.paired.attribution.variability_percent);
});

test('仅一对完整：paired 写 count=1 与 attribution，统计/区间/decision 及顶层两项为 null', () => {
  const dir = tempDir();
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, '0');
  // runs=2 时候选 index 1 失败 -> 仅 index 0 成对
  const candidate = `n=$(cat ${marker}); echo $((n+1)) > ${marker}; [ "$n" = 1 ] && exit 7 || true`;
  const manifest = writeManifest(dir, 'm.json', [
    CASE({ name: 'one', runs: 2, candidate_command: candidate }),
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const [c] = readJson(out).cases;
  assert.deepEqual(c.paired.pairs.map((p) => p.index), [0]);
  assert.equal(c.paired.summary.count, 1);
  assert.equal(c.paired.summary.mean, c.paired.pairs[0].delta_ns);
  assert.equal(c.paired.t_test, null);
  assert.equal(c.paired.confidence_interval, null);
  assert.equal(c.paired.decision, null);
  assert.equal(c.adjusted_p_value, null);
  assert.equal(c.decision, null);
  // 有一对完整样本：attribution 仍按 compare 口径给出
  assert.notEqual(c.paired.attribution, null);
  assert.equal(typeof c.paired.attribution.dominant_factor, 'string');
});

test('单侧 measure timeout：记录后跳过，退出码 3', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', [
    CASE({ name: 'slow', candidate_command: 'sleep 5', timeout_ms: 200 }),
  ]);
  const out = path.join(dir, 'out.json');
  const start = Date.now();
  const r = runCli(['--manifest', manifest, '--output', out]);
  const elapsed = Date.now() - start;
  assert.equal(r.status, 3, r.stderr);
  assert.ok(elapsed < 4000, `超时未及时生效: ${elapsed}ms`);
  const result = readJson(out);
  const c = result.cases[0];
  assert.equal(c.baseline.samples.length, 4);
  assert.equal(c.candidate.samples.length, 0);
  assert.deepEqual(c.candidate.errors.map((e) => e.reason), ['timeout', 'timeout', 'timeout', 'timeout']);
  assert.equal(c.paired.pairs.length, 0);
  assert.equal(c.adjusted_p_value, null);
  assert.equal(c.decision, null);
  assert.equal(result.suite_summary.suite_decision, 'incomplete');
}, 30000);

test('全部 case 不可比较：suite_decision 为 incomplete，套件归因百分比为 null、dominant 为 none', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', [
    CASE({ name: 'x', candidate_command: 'exit 3' }),
    CASE({ name: 'y', baseline_command: 'exit 4', candidate_command: 'exit 5' }),
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 3, r.stderr);
  const result = readJson(out);
  assert.deepEqual(result.suite_summary, {
    total: 2,
    regression: 0,
    improvement: 0,
    no_material_change: 0,
    not_significant: 0,
    suite_decision: 'incomplete',
  });
  assert.equal(result.suite_attribution.central_tendency_percent, null);
  assert.equal(result.suite_attribution.tail_latency_percent, null);
  assert.equal(result.suite_attribution.variability_percent, null);
  assert.equal(result.suite_attribution.dominant_factor, 'none');
});

test('仅 warmup 出错：只记录到 errors，退出码 0，pairs 完整、可比较', () => {
  const dir = tempDir();
  const marker = path.join(dir, 'marker');
  const command = (tag) => {
    const m = `${marker}-${tag}`;
    return `n=$(cat ${m} 2>/dev/null || echo 0); echo $((n+1)) > ${m}; [ "$n" = 0 ] && exit 5 || true`;
  };
  const manifest = writeManifest(dir, 'm.json', [
    CASE({
      name: 'a', runs: 2, warmup: 1,
      baseline_command: command('ab'),
      candidate_command: command('ac'),
    }),
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  for (const c of result.cases) {
    for (const sideName of ['baseline', 'candidate']) {
      assert.deepEqual(c[sideName].errors,
        [{ stage: 'warmup', index: 0, reason: 'nonzero_exit', exit_code: 5 }]);
      assert.equal(c[sideName].samples.length, 2);
    }
    assert.equal(c.paired.pairs.length, 2);
    assert.equal(typeof c.adjusted_p_value, 'number');
    assert.notEqual(c.decision, null);
  }
});

test('manifest/参数不合口径：退出码 2，stderr 一条，不创建/不改写 output', () => {
  const dir = tempDir();
  const out = path.join(dir, 'out.json');
  const writeRaw = (name, content) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };
  const notJson = writeRaw('not-json.json', 'not json{');
  const topArray = writeRaw('array.json', '[]');
  const noCases = writeRaw('no-cases.json', JSON.stringify({}));
  const emptyCases = writeRaw('empty.json', JSON.stringify({ cases: [] }));
  const badItem = writeRaw('bad-item.json', JSON.stringify({ cases: [42] }));
  const emptyName = writeRaw('empty-name.json', JSON.stringify({ cases: [CASE({ name: '' })] }));
  const dupName = writeRaw('dup.json', JSON.stringify({ cases: [CASE(), CASE({ name: 'c' })] }));
  const emptyBase = writeRaw('empty-base.json', JSON.stringify({
    cases: [CASE({ baseline_command: '' })],
  }));
  const emptyCand = writeRaw('empty-cand.json', JSON.stringify({
    cases: [CASE({ candidate_command: '' })],
  }));
  const runsOne = writeRaw('runs-one.json', JSON.stringify({ cases: [CASE({ runs: 1 })] }));
  const runsString = writeRaw('runs-str.json', JSON.stringify({ cases: [CASE({ runs: '2' })] }));
  const badWarmup = writeRaw('warmup.json', JSON.stringify({ cases: [CASE({ warmup: -1 })] }));
  const badTimeout = writeRaw('timeout.json', JSON.stringify({
    cases: [CASE({ timeout_ms: 0 })],
  }));
  const missingRuns = writeRaw('missing-runs.json', JSON.stringify({
    cases: [{
      name: 'c', baseline_command: 'true', candidate_command: 'true',
      warmup: 0, timeout_ms: 5000,
    }],
  }));

  const cases = [
    ['--output', out], // 缺 --manifest
    ['--manifest', '', '--output', out],
    ['--manifest', path.join(dir, 'missing-manifest.json'), '--output', out],
    ['--manifest', notJson, '--output', out],
    ['--manifest', topArray, '--output', out],
    ['--manifest', noCases, '--output', out],
    ['--manifest', emptyCases, '--output', out],
    ['--manifest', badItem, '--output', out],
    ['--manifest', emptyName, '--output', out],
    ['--manifest', dupName, '--output', out],
    ['--manifest', emptyBase, '--output', out],
    ['--manifest', emptyCand, '--output', out],
    ['--manifest', runsOne, '--output', out],
    ['--manifest', runsString, '--output', out],
    ['--manifest', badWarmup, '--output', out],
    ['--manifest', badTimeout, '--output', out],
    ['--manifest', missingRuns, '--output', out],
    ['--manifest', noCases, '--output', out, '--alpha', '0'],
    ['--manifest', noCases, '--output', out, '--alpha', 'x'],
    ['--manifest', noCases, '--output', out, '--min-change-percent', '-1'],
    ['--manifest', noCases, '--output', out, '--bogus', '1'],
  ];
  for (const args of cases) {
    const r = runCli(args);
    assert.equal(r.status, 2, `应退出码2: ${JSON.stringify(args)} / ${r.stderr}`);
    assert.equal(r.stderr.trim().split('\n').length, 1,
      `stderr 应仅一条: ${JSON.stringify(args)} -> ${r.stderr}`);
    assert.equal(fs.existsSync(out), false, `不应创建 output: ${JSON.stringify(args)}`);
  }
});

test('校验失败与启动失败时不改写已存在的 output', () => {
  const dir = tempDir();
  const out = path.join(dir, 'existing.json');
  fs.writeFileSync(out, 'KEEP-ME');

  // manifest 校验失败
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ cases: [] }));
  const r1 = runCli(['--manifest', bad, '--output', out]);
  assert.equal(r1.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');

  // 第二个 case 启动失败（第一个 case 已执行完也不得写 output）
  const manifest = writeManifest(dir, 'm.json', [
    CASE({ name: 'ok' }),
    CASE({ name: 'boom', candidate_command: 'this_command_does_not_exist_xyz_9182' }),
  ]);
  const r2 = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /nonzero_exit/);
  assert.doesNotMatch(r2.stderr, /timeout/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('output 写入失败：退出码 4', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', [CASE()]);
  const out = path.join(dir, 'no-such-dir', 'nested', 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});

test('既有入口不受影响（ab-paired 冒烟）', () => {
  const dir = tempDir();
  const out = path.join(dir, 'ab-paired.json');
  const r = spawnSync(process.execPath,
    [BIN, 'ab-paired', '--baseline-command', 'true', '--candidate-command', 'true',
      '--runs', '2', '--timeout-ms', '5000', '--output', out],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.deepEqual(Object.keys(report), ['baseline', 'candidate', 'paired']);
  assert.equal('adjusted_p_value' in report, false);
});
