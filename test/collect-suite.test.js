'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'collect-suite', ...args], { encoding: 'utf8' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-collect-suite-'));
}

function writeManifest(dir, name, manifest) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(manifest));
  return p;
}

function caseItem(overrides = {}) {
  return {
    name: 'a',
    command: 'true',
    runs: 1,
    warmup: 0,
    timeout_ms: 5000,
    ...overrides,
  };
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('套件成功：退出码 0，顶层与逐 case 字段、samples/summary、suite_summary 正确', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', {
    cases: [
      caseItem({ name: 'alpha', runs: 3, warmup: 1 }),
      caseItem({ name: 'beta', command: 'true', runs: 2 }),
    ],
  });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const result = readJson(out);
  assert.deepEqual(Object.keys(result), ['cases', 'suite_summary']);
  assert.equal(result.cases.length, 2);
  assert.deepEqual(result.cases.map((c) => c.name), ['alpha', 'beta']);

  for (const c of result.cases) {
    assert.deepEqual(Object.keys(c),
      ['name', 'command', 'runs', 'warmup', 'timeout_ms', 'unit',
        'samples', 'summary', 'errors', 'status']);
    assert.equal(c.unit, 'ns');
    assert.equal(c.status, 'ok');
    assert.deepEqual(c.errors, []);
    assert.deepEqual(Object.keys(c.summary),
      ['count', 'min', 'max', 'mean', 'median', 'p95', 'stddev']);
    assert.equal(c.summary.count, c.samples.length);
    for (const s of c.samples) {
      assert.deepEqual(Object.keys(s), ['index', 'started_at', 'duration_ns', 'exit_code']);
      assert.equal(s.exit_code, 0);
      assert.equal(Number.isSafeInteger(s.duration_ns), true);
    }
  }

  assert.equal(result.cases[0].runs, 3);
  assert.equal(result.cases[0].warmup, 1);
  assert.equal(result.cases[0].timeout_ms, 5000);
  assert.equal(result.cases[0].samples.length, 3);
  assert.deepEqual(result.cases[0].samples.map((s) => s.index), [0, 1, 2]);
  assert.equal(result.cases[1].samples.length, 2);

  assert.deepEqual(result.suite_summary, {
    total: 2,
    ok: 2,
    measure_errors: 0,
    sample_count: 5,
    error_count: 0,
  });
});

test('--key=value 形式；未知 manifest 字段忽略', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', {
    extra: 'ignored',
    cases: [
      Object.assign(caseItem({ runs: 1 }), { note: null, baseline: 'x' }),
    ],
  });
  const out = path.join(dir, 'out.json');
  const r = runCli([`--manifest=${manifest}`, `--output=${out}`]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].name, 'a');
});

test('按 cases 顺序采集，case 内先 warmup 后 runs，全程不并发', () => {
  const dir = tempDir();
  const marker = path.join(dir, 'order.log');
  const manifest = writeManifest(dir, 'm.json', {
    cases: [
      caseItem({ name: 'a', command: `echo a >> ${marker}`, runs: 2, warmup: 1 }),
      caseItem({ name: 'b', command: `echo b >> ${marker}`, runs: 1, warmup: 2 }),
    ],
  });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  // a: warmup1 + runs2，然后才是 b: warmup2 + runs1
  assert.deepEqual(
    fs.readFileSync(marker, 'utf8').trim().split('\n'),
    ['a', 'a', 'a', 'b', 'b', 'b']);
});

test('被测命令 stdout/stderr 被丢弃', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', {
    cases: [caseItem({ command: 'echo hello-out; echo hello-err >&2', runs: 2 })],
  });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('measure nonzero_exit：退出码 3，写完整文件，出错执行被跳过且继续该 case 剩余测量', () => {
  const dir = tempDir();
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, '0');
  // 第 0 次失败，第 1 次成功；samples 的 index 保留原始序号
  const command = `n=$(cat ${marker}); echo $((n+1)) > ${marker}; [ "$n" = 0 ] && exit 5 || true`;
  const manifest = writeManifest(dir, 'm.json', {
    cases: [
      caseItem({ name: 'bad', command: 'exit 7', runs: 2 }),
      caseItem({ name: 'mixed', command, runs: 2 }),
      caseItem({ name: 'good', runs: 1 }),
    ],
  });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const result = readJson(out);
  assert.deepEqual(result.cases.map((c) => c.status),
    ['measure_errors', 'measure_errors', 'ok']);

  const bad = result.cases[0];
  assert.equal(bad.samples.length, 0);
  assert.equal(bad.summary.count, 0);
  assert.deepEqual(bad.summary,
    { count: 0, min: null, max: null, mean: null, median: null, p95: null, stddev: null });
  assert.equal(bad.errors.length, 2);
  assert.deepEqual(bad.errors[0],
    { stage: 'measure', index: 0, reason: 'nonzero_exit', exit_code: 7 });

  const mixed = result.cases[1];
  assert.equal(mixed.samples.length, 1);
  assert.equal(mixed.samples[0].index, 1);
  assert.deepEqual(mixed.errors[0],
    { stage: 'measure', index: 0, reason: 'nonzero_exit', exit_code: 5 });

  assert.deepEqual(result.suite_summary, {
    total: 3,
    ok: 1,
    measure_errors: 2,
    sample_count: 2,
    error_count: 3,
  });
});

test('measure timeout：reason=timeout、exit_code=null，跳过并继续', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', {
    cases: [
      caseItem({ name: 'slow', command: 'sleep 5', runs: 1, timeout_ms: 100 }),
      caseItem({ name: 'fast', runs: 1 }),
    ],
  });
  const out = path.join(dir, 'out.json');
  const start = Date.now();
  const r = runCli(['--manifest', manifest, '--output', out]);
  const elapsed = Date.now() - start;
  assert.equal(r.status, 3, r.stderr);
  assert.ok(elapsed < 2000, `超时未及时生效: ${elapsed}ms`);

  const result = readJson(out);
  assert.equal(result.cases[0].status, 'measure_errors');
  assert.deepEqual(result.cases[0].errors[0],
    { stage: 'measure', index: 0, reason: 'timeout', exit_code: null });
  // 超时的 case 之后仍继续采集后续 case
  assert.equal(result.cases[1].status, 'ok');
  assert.equal(result.cases[1].samples.length, 1);
  assert.equal(result.suite_summary.measure_errors, 1);
}, 30000);

test('warmup nonzero/timeout 只记 errors：status 仍为 ok，退出码 0，但计入 error_count', () => {
  const dir = tempDir();
  // 前 2 次（warmup）nonzero，之后（measure）成功
  const marker1 = path.join(dir, 'm1');
  fs.writeFileSync(marker1, '0');
  const wfailCmd = `n=$(cat ${marker1}); echo $((n+1)) > ${marker1}; [ "$n" -lt 2 ] && exit 3 || true`;
  // 第 1 次（warmup）sleep 超时，之后（measure）立即成功
  const marker2 = path.join(dir, 'm2');
  fs.writeFileSync(marker2, '0');
  const wslowCmd = `n=$(cat ${marker2}); echo $((n+1)) > ${marker2}; [ "$n" = 0 ] && sleep 5 || true`;
  const manifest = writeManifest(dir, 'm.json', {
    cases: [
      caseItem({ name: 'wfail', command: wfailCmd, runs: 1, warmup: 2 }),
      caseItem({ name: 'wslow', command: wslowCmd, runs: 1, warmup: 1, timeout_ms: 100 }),
    ],
  });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const result = readJson(out);
  for (const c of result.cases) assert.equal(c.status, 'ok');
  assert.equal(result.cases[0].samples.length, 1);
  assert.equal(result.cases[0].errors.length, 2);
  assert.deepEqual(result.cases[0].errors, [
    { stage: 'warmup', index: 0, reason: 'nonzero_exit', exit_code: 3 },
    { stage: 'warmup', index: 1, reason: 'nonzero_exit', exit_code: 3 },
  ]);
  assert.equal(result.cases[1].samples.length, 1);
  assert.deepEqual(result.cases[1].errors,
    [{ stage: 'warmup', index: 0, reason: 'timeout', exit_code: null }]);
  assert.deepEqual(result.suite_summary, {
    total: 2,
    ok: 2,
    measure_errors: 0,
    sample_count: 2,
    error_count: 3,
  });
}, 30000);

test('manifest 或参数不合口径：退出码 2，stderr 一条，不创建 output', () => {
  const dir = tempDir();
  const out = path.join(dir, 'out.json');
  const writeRaw = (name, content) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  const good = writeManifest(dir, 'good.json', JSON.stringify({ cases: [caseItem()] }));
  const notJson = writeRaw('not-json.json', 'not json{');
  const topArray = writeRaw('array.json', '[]');
  const noCases = writeRaw('no-cases.json', JSON.stringify({}));
  const emptyCases = writeRaw('empty.json', JSON.stringify({ cases: [] }));
  const badItem = writeRaw('bad-item.json', JSON.stringify({ cases: [42] }));
  const nullItem = writeRaw('null-item.json', JSON.stringify({ cases: [null] }));
  const emptyName = writeRaw('empty-name.json', JSON.stringify({ cases: [caseItem({ name: '' })] }));
  const nonStringName = writeRaw('num-name.json', JSON.stringify({ cases: [caseItem({ name: 3 })] }));
  const dupName = writeRaw('dup.json', JSON.stringify({
    cases: [caseItem({ name: 'a' }), caseItem({ name: 'a' })],
  }));
  const emptyCommand = writeRaw('empty-command.json', JSON.stringify({
    cases: [caseItem({ command: '' })],
  }));
  const missingRuns = writeRaw('missing-runs.json', JSON.stringify({
    cases: [(() => { const c = caseItem(); delete c.runs; return c; })()],
  }));
  const zeroRuns = writeRaw('zero-runs.json', JSON.stringify({ cases: [caseItem({ runs: 0 })] }));
  const floatRuns = writeRaw('float-runs.json', JSON.stringify({ cases: [caseItem({ runs: 1.5 })] }));
  const stringRuns = writeRaw('string-runs.json', JSON.stringify({ cases: [caseItem({ runs: '2' })] }));
  const negWarmup = writeRaw('neg-warmup.json', JSON.stringify({ cases: [caseItem({ warmup: -1 })] }));
  const floatWarmup = writeRaw('float-warmup.json',
    JSON.stringify({ cases: [caseItem({ warmup: 0.5 })] }));
  const zeroTimeout = writeRaw('zero-timeout.json',
    JSON.stringify({ cases: [caseItem({ timeout_ms: 0 })] }));
  const missingTimeout = writeRaw('missing-timeout.json', JSON.stringify({
    cases: [(() => { const c = caseItem(); delete c.timeout_ms; return c; })()],
  }));

  const cases = [
    ['--output', out], // 缺 --manifest
    ['--manifest', '', '--output', out],
    ['--output', out, '--bogus', '1'],
    ['--manifest', good], // 缺 --output
    ['--manifest', good, '--output', ''],
    ['--manifest', path.join(dir, 'missing.json'), '--output', out],
    ['--manifest', notJson, '--output', out],
    ['--manifest', topArray, '--output', out],
    ['--manifest', noCases, '--output', out],
    ['--manifest', emptyCases, '--output', out],
    ['--manifest', badItem, '--output', out],
    ['--manifest', nullItem, '--output', out],
    ['--manifest', emptyName, '--output', out],
    ['--manifest', nonStringName, '--output', out],
    ['--manifest', dupName, '--output', out],
    ['--manifest', emptyCommand, '--output', out],
    ['--manifest', missingRuns, '--output', out],
    ['--manifest', zeroRuns, '--output', out],
    ['--manifest', floatRuns, '--output', out],
    ['--manifest', stringRuns, '--output', out],
    ['--manifest', negWarmup, '--output', out],
    ['--manifest', floatWarmup, '--output', out],
    ['--manifest', zeroTimeout, '--output', out],
    ['--manifest', missingTimeout, '--output', out],
  ];
  for (const args of cases) {
    const r = runCli(args);
    assert.equal(r.status, 2, `应退出码2: ${JSON.stringify(args)} / ${r.stderr}`);
    assert.equal(r.stderr.trim().split('\n').length, 1,
      `stderr 应仅一条: ${JSON.stringify(args)} -> ${r.stderr}`);
    assert.equal(fs.existsSync(out), false, `不应创建 output: ${JSON.stringify(args)}`);
  }
});

test('manifest 无效时不改写已存在的 output', () => {
  const dir = tempDir();
  const manifest = path.join(dir, 'not-json.json');
  fs.writeFileSync(manifest, 'not json{');
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('进程无法启动（shell 127）：退出码 2，不写 output；前序 case 结果也不落盘', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', {
    cases: [
      caseItem({ name: 'ok', runs: 1 }),
      caseItem({ name: 'dead', command: 'this_command_does_not_exist_xyz_9182', runs: 2 }),
    ],
  });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(fs.existsSync(out), false);
  assert.match(r.stderr, /nonzero_exit/);
  assert.doesNotMatch(r.stderr, /timeout/);
});

test('warmup 阶段进程无法启动同样致命：退出码 2，不改写已有 output', () => {
  const dir = tempDir();
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const manifest = writeManifest(dir, 'm.json', {
    cases: [
      caseItem({
        name: 'dead-warmup',
        command: 'this_command_does_not_exist_xyz_9182',
        runs: 1,
        warmup: 1,
      }),
    ],
  });
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('output 写入失败：退出码 4', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, 'm.json', { cases: [caseItem()] });
  const out = path.join(dir, 'no-such-dir', 'nested', 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});

test('collect / compare / compare-suite 行为不受影响（collect 冒烟）', () => {
  const dir = tempDir();
  const out = path.join(dir, 'collect.json');
  const r = spawnSync(process.execPath,
    [BIN, 'collect', '--command', 'true', '--runs', '2',
      '--timeout-ms', '5000', '--output', out],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const report = readJson(out);
  assert.deepEqual(Object.keys(report),
    ['command', 'runs', 'warmup', 'timeout_ms', 'unit', 'samples', 'summary', 'errors']);
  assert.equal('status' in report, false);
});
