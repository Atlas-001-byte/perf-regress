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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-suite-'));
}

function writeManifest(dir, manifest) {
  const p = path.join(dir, 'manifest.json');
  fs.writeFileSync(p, JSON.stringify(manifest), 'utf8');
  return p;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const EMPTY_SUMMARY = {
  count: 0, min: null, max: null, mean: null, median: null, p95: null, stddev: null,
};

test('成功采集多 case：退出码 0，顶层/case 字段、顺序与 suite_summary 正确', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, {
    cases: [
      { name: 'a', command: 'true', runs: 2, warmup: 1, timeout_ms: 5000 },
      { name: 'b', command: 'true', runs: 1, warmup: 0, timeout_ms: 5000, extra: 'ignored' },
    ],
    top_level_extra: 1,
  });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const report = readJson(out);
  assert.deepEqual(Object.keys(report), ['cases', 'suite_summary']);
  assert.equal(report.cases.length, 2);

  const a = report.cases[0];
  assert.deepEqual(Object.keys(a),
    ['name', 'command', 'runs', 'warmup', 'timeout_ms', 'unit', 'samples', 'summary', 'errors', 'status']);
  assert.equal(a.name, 'a');
  assert.equal(a.command, 'true');
  assert.equal(a.runs, 2);
  assert.equal(a.warmup, 1);
  assert.equal(a.timeout_ms, 5000);
  assert.equal(a.unit, 'ns');
  assert.equal(a.status, 'ok');
  assert.equal(a.samples.length, 2);
  assert.equal(a.errors.length, 0);
  a.samples.forEach((s, i) => {
    assert.deepEqual(Object.keys(s), ['index', 'started_at', 'duration_ns', 'exit_code']);
    assert.equal(s.index, i);
    assert.equal(s.exit_code, 0);
    assert.equal(Number.isSafeInteger(s.duration_ns), true);
  });
  assert.equal(a.summary.count, 2);

  const b = report.cases[1];
  assert.equal(b.name, 'b');
  assert.equal(b.samples.length, 1);
  assert.equal(b.status, 'ok');

  assert.deepEqual(report.suite_summary,
    { total: 2, ok: 2, measure_errors: 0, sample_count: 3, error_count: 0 });
});

test('支持 --key=value 写法', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, {
    cases: [{ name: 'a', command: 'true', runs: 1, warmup: 0, timeout_ms: 5000 }],
  });
  const out = path.join(dir, 'out.json');
  const r = runCli([`--manifest=${manifest}`, `--output=${out}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readJson(out).suite_summary.total, 1);
});

test('measure 错误：退出码 3 仍写完整文件，status=measure_errors，计数正确', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, {
    cases: [
      { name: 'ok', command: 'true', runs: 1, warmup: 0, timeout_ms: 5000 },
      { name: 'bad', command: 'exit 7', runs: 2, warmup: 0, timeout_ms: 5000 },
    ],
  });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 3, r.stderr);

  const report = readJson(out);
  assert.equal(report.cases[0].status, 'ok');
  assert.equal(report.cases[1].status, 'measure_errors');
  assert.equal(report.cases[1].samples.length, 0);
  assert.deepEqual(report.cases[1].summary, EMPTY_SUMMARY);
  assert.equal(report.cases[1].errors.length, 2);
  assert.deepEqual(report.cases[1].errors[0],
    { stage: 'measure', index: 0, reason: 'nonzero_exit', exit_code: 7 });
  assert.deepEqual(report.suite_summary,
    { total: 2, ok: 1, measure_errors: 1, sample_count: 1, error_count: 2 });
});

test('仅 warmup 错误：status 仍为 ok，退出码 0，error_count 计入 warmup 错误', () => {
  const dir = tempDir();
  // 用自增 marker：前 2 次（warmup）失败退出 4，第 3 次（measure）成功。
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, '0');
  const command = `n=$(cat ${marker}); echo $((n+1)) > ${marker}; [ "$n" -lt 2 ] && exit 4 || true`;
  const manifest = writeManifest(dir, {
    cases: [{ name: 'w', command, runs: 1, warmup: 2, timeout_ms: 5000 }],
  });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const report = readJson(out);
  const c = report.cases[0];
  assert.equal(c.status, 'ok');
  assert.equal(c.samples.length, 1);
  assert.equal(c.samples[0].index, 0);
  assert.equal(c.errors.length, 2);
  assert.deepEqual(c.errors.map((e) => e.stage), ['warmup', 'warmup']);
  assert.ok(c.errors.every((e) => e.reason === 'nonzero_exit' && e.exit_code === 4));
  assert.deepEqual(report.suite_summary,
    { total: 1, ok: 1, measure_errors: 0, sample_count: 1, error_count: 2 });
});

test('measure timeout：reason=timeout 记 error，退出码 3', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, {
    cases: [{ name: 'slow', command: 'sleep 5', runs: 1, warmup: 0, timeout_ms: 200 }],
  });
  const out = path.join(dir, 'out.json');
  const start = Date.now();
  const r = runCli(['--manifest', manifest, '--output', out]);
  const elapsed = Date.now() - start;
  assert.equal(r.status, 3, r.stderr);
  assert.ok(elapsed < 2000, `超时未及时生效: ${elapsed}ms`);
  const report = readJson(out);
  assert.equal(report.cases[0].samples.length, 0);
  assert.deepEqual(report.cases[0].errors[0],
    { stage: 'measure', index: 0, reason: 'timeout', exit_code: null });
}, 30000);

test('采集顺序：先 warmup 后 measure，case 间按顺序不并发', () => {
  const dir = tempDir();
  const log = path.join(dir, 'log');
  const mk = (tag) => `echo ${tag} >> ${log}`;
  const manifest = writeManifest(dir, {
    cases: [
      { name: 'a', command: mk('a'), runs: 2, warmup: 1, timeout_ms: 5000 },
      { name: 'b', command: mk('b'), runs: 1, warmup: 2, timeout_ms: 5000 },
    ],
  });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(lines, ['a', 'a', 'a', 'b', 'b', 'b']);
});

test('manifest 无效：各类结构/字段错误均退出 2 且不创建 output', () => {
  const dir = tempDir();
  const out = path.join(dir, 'out.json');

  const jsonCase = (content, name) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, 'utf8');
    return p;
  };
  const goodCase = { name: 'x', command: 'true', runs: 1, warmup: 0, timeout_ms: 5000 };
  const manifests = [
    ['not-json.json', '{not json'],
    ['array.json', '[]'],
    ['no-cases.json', JSON.stringify({})],
    ['cases-array.json', JSON.stringify({ cases: {} })],
    ['cases-empty.json', JSON.stringify({ cases: [] })],
    ['case-not-object.json', JSON.stringify({ cases: [1] })],
    ['name-empty.json', JSON.stringify({ cases: [{ ...goodCase, name: '' }] })],
    ['name-not-string.json', JSON.stringify({ cases: [{ ...goodCase, name: 1 }] })],
    ['name-dup.json', JSON.stringify({ cases: [goodCase, { ...goodCase }] })],
    ['command-empty.json', JSON.stringify({ cases: [{ ...goodCase, command: '' }] })],
    ['command-missing.json', JSON.stringify({ cases: [{ name: 'x', runs: 1, warmup: 0, timeout_ms: 5000 }] })],
    ['runs-zero.json', JSON.stringify({ cases: [{ ...goodCase, runs: 0 }] })],
    ['runs-float.json', JSON.stringify({ cases: [{ ...goodCase, runs: 1.5 }] })],
    ['runs-string.json', JSON.stringify({ cases: [{ ...goodCase, runs: '1' }] })],
    ['warmup-neg.json', JSON.stringify({ cases: [{ ...goodCase, warmup: -1 }] })],
    ['timeout-zero.json', JSON.stringify({ cases: [{ ...goodCase, timeout_ms: 0 }] })],
  ];

  for (const [name, content] of manifests) {
    const p = jsonCase(content, name);
    const r = runCli(['--manifest', p, '--output', out]);
    assert.equal(r.status, 2, `${name} 应退出2: ${r.stderr}`);
    assert.ok(r.stderr.length > 0, `${name} 应向 stderr 输出原因`);
    assert.equal(fs.existsSync(out), false, `${name} 不应创建 output`);
  }
});

test('manifest 文件不存在：退出 2', () => {
  const dir = tempDir();
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', path.join(dir, 'missing.json'), '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.existsSync(out), false);
});

test('参数错误：缺 manifest/output、空值、未知参数、重复均退出 2', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, {
    cases: [{ name: 'a', command: 'true', runs: 1, warmup: 0, timeout_ms: 5000 }],
  });
  const out = path.join(dir, 'out.json');
  const cases = [
    ['--output', out],
    ['--manifest', manifest],
    ['--manifest', '', '--output', out],
    ['--manifest', manifest, '--output', ''],
    ['--manifest', manifest, '--output', out, '--bogus', 'x'],
    ['--manifest', manifest, '--manifest', manifest, '--output', out],
  ];
  for (const args of cases) {
    const r = runCli(args);
    assert.equal(r.status, 2, `应退出2: ${JSON.stringify(args)} / ${r.stderr}`);
  }
  assert.equal(fs.existsSync(out), false);
});

test('校验失败时不改写已存在的 output', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, { cases: [] });
  const out = path.join(dir, 'existing.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('进程无法启动（shell 127）：退出码 2，不写 output，按 nonzero_exit 而非 timeout', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, {
    cases: [
      { name: 'ok', command: 'true', runs: 1, warmup: 0, timeout_ms: 5000 },
      { name: 'nope', command: 'this_command_does_not_exist_xyz_9182',
        runs: 1, warmup: 0, timeout_ms: 5000 },
    ],
  });
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(fs.existsSync(out), false);
  assert.match(r.stderr, /nonzero_exit/);
  assert.doesNotMatch(r.stderr, /timeout/);
});

test('进程无法启动时不改写已存在的 output', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, {
    cases: [{
      name: 'nope', command: 'this_command_does_not_exist_xyz_9182',
      runs: 1, warmup: 0, timeout_ms: 5000,
    }],
  });
  const out = path.join(dir, 'existing.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('output 写入失败：退出码 4，stderr 含路径与原因', () => {
  const dir = tempDir();
  const manifest = writeManifest(dir, {
    cases: [{ name: 'a', command: 'true', runs: 1, warmup: 0, timeout_ms: 5000 }],
  });
  const out = path.join(dir, 'no-such-dir', 'nested', 'result.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 4, r.stderr);
  assert.ok(r.stderr.includes(out));
});
