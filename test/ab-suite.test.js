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

function writeManifest(dir, name, cases, extra = {}) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify({ ...extra, cases }));
  return p;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const SIDE_KEYS = ['command', 'runs', 'warmup', 'timeout_ms', 'unit', 'samples', 'summary', 'errors'];
const COMPARISON_KEYS = ['baseline_summary', 'candidate_summary', 'delta', 'welch', 'decision', 'attribution'];
const CASE_KEYS = ['name', 'baseline', 'candidate', 'comparison', 'adjusted_p_value', 'decision'];

const AB_CASE = (over = {}) => ({
  name: 'c',
  baseline_command: 'true',
  candidate_command: 'true',
  runs: 2,
  warmup: 0,
  timeout_ms: 5000,
  ...over,
});

test('成功：退出码 0；顶层/逐 case 字段固定，cases 按 manifest 顺序，BH 与 decision 正确', () => {
  const dir = tempDir();
  // 效应量远大于计时噪声：+150ms / -150ms，Welch 必显著
  const manifest = writeManifest(dir, 'm.json', [
    AB_CASE({ name: 'reg', baseline_command: 'sleep 0.12', candidate_command: 'sleep 0.30', runs: 4 }),
    AB_CASE({ name: 'imp', baseline_command: 'sleep 0.30', candidate_command: 'sleep 0.12', runs: 4 }),
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
    assert.notEqual(c.comparison, null);
    assert.deepEqual(Object.keys(c.comparison), COMPARISON_KEYS);
    assert.deepEqual(Object.keys(c.comparison.delta.mean.confidence_interval),
      ['level', 'lower_ns', 'upper_ns', 'lower_percent', 'upper_percent']);
    assert.equal(c.comparison.delta.mean.confidence_interval.level, 0.95);
    assert.equal(typeof c.comparison.delta.mean.confidence_interval.upper_ns, 'number');
    assert.equal(typeof c.adjusted_p_value, 'number');
    assert.ok(['regression', 'improvement', 'no_material_change', 'not_significant']
      .includes(c.decision));
    // BH 校正后的 p 不小于原始 p（m=2 且两者均极显著时取等）
    assert.ok(c.adjusted_p_value >= c.comparison.welch.p_value);
  }

  const [reg, imp] = result.cases;
  assert.equal(reg.decision, 'regression');
  assert.equal(reg.comparison.decision, 'regression');
  assert.equal(imp.decision, 'improvement');
  assert.equal(imp.comparison.decision, 'improvement');

  assert.deepEqual(result.suite_summary, {
    total: 2,
    comparable: 2,
    incomplete: 0,
    suite_decision: 'regression',
  });

  assert.deepEqual(Object.keys(result.suite_attribution),
    ['central_tendency_percent', 'tail_latency_percent',
      'variability_percent', 'dominant_factor']);
  assert.equal(typeof result.suite_attribution.central_tendency_percent, 'number');
}, 60000);

test('case 间串行、case 内沿用 ab 交错：先两侧预热再测量，每轮先 baseline 后 candidate', () => {
  const dir = tempDir();
  const log = path.join(dir, 'order.log');
  const manifest = writeManifest(dir, 'm.json', [
    AB_CASE({
      name: 'a',
      baseline_command: `echo ab >> ${log}`,
      candidate_command: `echo ac >> ${log}`,
      runs: 2,
      warmup: 1,
    }),
    AB_CASE({
      name: 'b',
      baseline_command: `echo bb >> ${log}`,
      candidate_command: `echo bc >> ${log}`,
      runs: 2,
      warmup: 1,
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
    AB_CASE({ name: 'reg', baseline_command: 'sleep 0.12', candidate_command: 'sleep 0.30',
      runs: 3, bogus_field: 'ignored' }),
  ], { top_level_ignored: 1 });
  const out = path.join(dir, 'out.json');
  const r = runCli([`--manifest=${manifest}`, `--output=${out}`,
    '--alpha=0.01', '--min-change-percent=10']);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.cases[0].name, 'reg');
  assert.equal(result.cases[0].decision, 'regression');
  assert.equal(result.suite_summary.suite_decision, 'regression');
}, 60000);

test('measure nonzero_exit：退出码 3 写完整 JSON；失败 case 三项为 null 且不参与 BH，其余 case 正常', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', [
    AB_CASE({ name: 'bad', candidate_command: 'exit 7' }),
    AB_CASE({ name: 'good', runs: 3 }),
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const result = readJson(out);
  const [bad, good] = result.cases;
  assert.equal(bad.name, 'bad');
  assert.equal(bad.baseline.samples.length, 2);
  assert.equal(bad.candidate.samples.length, 0);
  assert.equal(bad.candidate.summary.count, 0);
  assert.deepEqual(bad.candidate.errors, [
    { stage: 'measure', index: 0, reason: 'nonzero_exit', exit_code: 7 },
    { stage: 'measure', index: 1, reason: 'nonzero_exit', exit_code: 7 },
  ]);
  assert.equal(bad.comparison, null);
  assert.equal(bad.adjusted_p_value, null);
  assert.equal(bad.decision, null);

  assert.equal(good.name, 'good');
  assert.notEqual(good.comparison, null);
  // 仅 1 个可比较 case 参与 BH：校正值等于原始 p
  assert.equal(good.adjusted_p_value, good.comparison.welch.p_value);

  assert.deepEqual(result.suite_summary, {
    total: 2,
    comparable: 1,
    incomplete: 1,
    suite_decision: result.suite_summary.suite_decision,
  });
  assert.equal(['regression', 'improvement', 'no_material_change', 'not_significant']
    .includes(result.suite_summary.suite_decision), true);

  // 套件归因只汇总非 null comparison（即 good 一个 case 的百分比）
  assert.equal(result.suite_attribution.central_tendency_percent,
    good.comparison.attribution.central_tendency_percent);
  assert.equal(result.suite_attribution.tail_latency_percent,
    good.comparison.attribution.tail_latency_percent);
  assert.equal(result.suite_attribution.variability_percent,
    good.comparison.attribution.variability_percent);
  assert.equal(['central_tendency', 'tail_latency', 'variability', 'none']
    .includes(result.suite_attribution.dominant_factor), true);
});

test('单侧 measure timeout：记录后跳过，退出码 3', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', [
    AB_CASE({ name: 'slow', candidate_command: 'sleep 5', timeout_ms: 200 }),
  ]);
  const out = path.join(dir, 'out.json');
  const start = Date.now();
  const r = runCli(['--manifest', manifest, '--output', out]);
  const elapsed = Date.now() - start;
  assert.equal(r.status, 3, r.stderr);
  assert.ok(elapsed < 4000, `超时未及时生效: ${elapsed}ms`);
  const result = readJson(out);
  const c = result.cases[0];
  assert.equal(c.baseline.samples.length, 2);
  assert.equal(c.candidate.samples.length, 0);
  assert.deepEqual(c.candidate.errors.map((e) => e.reason), ['timeout', 'timeout']);
  assert.equal(c.comparison, null);
  assert.equal(c.adjusted_p_value, null);
  assert.equal(c.decision, null);
  assert.equal(result.suite_summary.comparable, 0);
  assert.equal(result.suite_summary.incomplete, 1);
  assert.equal(result.suite_summary.suite_decision, 'incomplete');
}, 30000);

test('全部 case 不具可比性：suite_decision 为 incomplete，套件归因百分比为 null、dominant 为 none', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', [
    AB_CASE({ name: 'x', candidate_command: 'exit 3' }),
    AB_CASE({ name: 'y', baseline_command: 'exit 4', candidate_command: 'exit 5' }),
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 3, r.stderr);
  const result = readJson(out);
  assert.equal(result.suite_summary.total, 2);
  assert.equal(result.suite_summary.comparable, 0);
  assert.equal(result.suite_summary.incomplete, 2);
  assert.equal(result.suite_summary.suite_decision, 'incomplete');
  assert.equal(result.suite_attribution.central_tendency_percent, null);
  assert.equal(result.suite_attribution.tail_latency_percent, null);
  assert.equal(result.suite_attribution.variability_percent, null);
  assert.equal(result.suite_attribution.dominant_factor, 'none');
});

test('仅 warmup 出错：只记录到 errors，退出码 0，comparison 正常', () => {
  const dir = tempDir();
  // 每个侧首次执行（warmup）失败，measure 全部成功
  const marker = path.join(dir, 'marker');
  const command = (tag) => {
    const m = `${marker}-${tag}`;
    return `n=$(cat ${m} 2>/dev/null || echo 0); echo $((n+1)) > ${m}; [ "$n" = 0 ] && exit 5 || true`;
  };
  const manifest = writeManifest(dir, 'm.json', [
    AB_CASE({
      name: 'a',
      baseline_command: command('ab'),
      candidate_command: command('ac'),
      runs: 2,
      warmup: 1,
    }),
    AB_CASE({
      name: 'b',
      baseline_command: command('bb'),
      candidate_command: command('bc'),
      runs: 2,
      warmup: 1,
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
    assert.notEqual(c.comparison, null);
    assert.equal(typeof c.adjusted_p_value, 'number');
  }
  assert.equal(result.suite_summary.incomplete, 0);
});

test('manifest/参数不合口径：退出码 2，stderr 一条，不创建/不改写 output', () => {
  const dir = tempDir();
  const out = path.join(dir, 'out.json');
  const good = AB_CASE();
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
  const emptyName = writeRaw('empty-name.json', JSON.stringify({ cases: [AB_CASE({ name: '' })] }));
  const dupName = writeRaw('dup.json', JSON.stringify({ cases: [good, AB_CASE({ name: 'c' })] }));
  const emptyBase = writeRaw('empty-base.json', JSON.stringify({
    cases: [AB_CASE({ baseline_command: '' })],
  }));
  const emptyCand = writeRaw('empty-cand.json', JSON.stringify({
    cases: [AB_CASE({ candidate_command: '' })],
  }));
  const runsOne = writeRaw('runs-one.json', JSON.stringify({ cases: [AB_CASE({ runs: 1 })] }));
  const runsString = writeRaw('runs-str.json', JSON.stringify({ cases: [AB_CASE({ runs: '2' })] }));
  const badWarmup = writeRaw('warmup.json', JSON.stringify({ cases: [AB_CASE({ warmup: -1 })] }));
  const badTimeout = writeRaw('timeout.json', JSON.stringify({
    cases: [AB_CASE({ timeout_ms: 0 })],
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
    AB_CASE({ name: 'ok' }),
    AB_CASE({ name: 'boom', candidate_command: 'this_command_does_not_exist_xyz_9182' }),
  ]);
  const r2 = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /nonzero_exit/);
  assert.doesNotMatch(r2.stderr, /timeout/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('output 写入失败：退出码 4', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', [AB_CASE()]);
  const out = path.join(dir, 'no-such-dir', 'nested', 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});

test('既有入口不受影响（ab 冒烟）', () => {
  const dir = tempDir();
  const out = path.join(dir, 'ab.json');
  const r = spawnSync(process.execPath,
    [BIN, 'ab', '--baseline-command', 'true', '--candidate-command', 'true',
      '--runs', '2', '--timeout-ms', '5000', '--output', out],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.deepEqual(Object.keys(report), ['baseline', 'candidate', 'comparison']);
  assert.equal('adjusted_p_value' in report, false);
});
