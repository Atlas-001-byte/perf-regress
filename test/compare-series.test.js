'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { benjaminiHochberg } = require('../lib/compare-suite');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'compare-series', ...args], { encoding: 'utf8' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-series-'));
}

// 以给定 duration_ns 列表构造一份 collect JSON 并写入临时文件。
function writeCollect(dir, name, durations, { command = 'true', unit = 'ns' } = {}) {
  const samples = durations.map((d, i) => ({
    index: i,
    started_at: '2026-01-01T00:00:00.000Z',
    duration_ns: d,
    exit_code: 0,
  }));
  const report = { command, runs: durations.length, warmup: 0, timeout_ms: 1000,
    unit, samples, summary: {}, errors: [] };
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(report));
  return p;
}

function writeManifest(dir, name, cases) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify({ cases }));
  return p;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('序列成功：cases 按 manifest 顺序，结构、字段顺序、index 与零方差退化判定正确', () => {
  const dir = tempDir();
  writeCollect(dir, 'a-base.json', [100, 100, 100]);
  writeCollect(dir, 'a-c0.json', [120, 120, 120]);
  writeCollect(dir, 'a-c1.json', [130, 130, 130]);
  writeCollect(dir, 'b-base.json', [50, 50]);
  writeCollect(dir, 'b-c0.json', [50, 50]);
  const manifest = writeManifest(dir, 'manifest.json', [
    { name: 'alpha', baseline: 'a-base.json', candidates: ['a-c0.json', 'a-c1.json'] },
    { name: 'beta', baseline: 'b-base.json', candidates: ['b-c0.json'] },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const result = readJson(out);
  assert.deepEqual(Object.keys(result), ['cases', 'suite_summary', 'suite_attribution']);
  assert.equal(result.cases.length, 2);
  assert.deepEqual(result.cases.map((c) => c.name), ['alpha', 'beta']);

  for (const c of result.cases) {
    assert.deepEqual(Object.keys(c),
      ['name', 'command', 'baseline_summary', 'candidates', 'first_regression_index']);
    assert.equal(c.command, 'true');
  }

  const [alpha, beta] = result.cases;
  assert.deepEqual(Object.keys(alpha.baseline_summary),
    ['count', 'min', 'max', 'mean', 'median', 'p95', 'stddev']);
  assert.equal(alpha.baseline_summary.mean, 100);
  assert.equal(alpha.candidates.length, 2);

  alpha.candidates.forEach((c, i) => {
    assert.deepEqual(Object.keys(c),
      ['candidate', 'index', 'delta', 'welch', 'adjusted_p_value', 'decision', 'attribution']);
    assert.equal(c.index, i);
    assert.deepEqual(Object.keys(c.candidate),
      ['count', 'min', 'max', 'mean', 'median', 'p95', 'stddev']);
  });

  // 零方差且均值不同：p=0；全部候选统一 BH 校正后仍为 0
  assert.equal(alpha.candidates[0].candidate.mean, 120);
  assert.equal(alpha.candidates[0].delta.mean.percent, 20);
  assert.deepEqual(alpha.candidates[0].welch,
    { t_statistic: null, degrees_of_freedom: null, p_value: 0 });
  assert.equal(alpha.candidates[0].adjusted_p_value, 0);
  assert.equal(alpha.candidates[0].decision, 'regression');
  assert.equal(alpha.candidates[1].candidate.mean, 130);
  assert.equal(alpha.candidates[1].delta.mean.percent, 30);
  assert.equal(alpha.candidates[1].decision, 'regression');
  assert.equal(alpha.first_regression_index, 0);

  // 零方差相同均值：p=1
  assert.equal(beta.candidates[0].welch.p_value, 1);
  assert.equal(beta.candidates[0].adjusted_p_value, 1);
  assert.equal(beta.candidates[0].decision, 'not_significant');
  assert.equal(beta.first_regression_index, null);

  assert.deepEqual(result.suite_summary, {
    total_cases: 2,
    total_candidates: 3,
    regression: 2,
    improvement: 0,
    no_material_change: 0,
    not_significant: 1,
    suite_decision: 'regression',
  });

  assert.deepEqual(Object.keys(result.suite_attribution),
    ['central_tendency_percent', 'tail_latency_percent',
      'variability_percent', 'dominant_factor']);
  // 三个候选的 mean/p95 百分比为 20、30、0，中位数 20；stddev 全 0
  assert.equal(result.suite_attribution.central_tendency_percent, 20);
  assert.equal(result.suite_attribution.tail_latency_percent, 20);
  assert.equal(result.suite_attribution.variability_percent, 0);
  assert.equal(result.suite_attribution.dominant_factor, 'central_tendency');
});

test('first_regression_index：跳过非 regression，取候选序列中首个 regression 的 index', () => {
  const dir = tempDir();
  writeCollect(dir, 'base.json', [100, 100]);
  writeCollect(dir, 'c0.json', [103, 103]); // +3% 显著但未达默认 5%
  writeCollect(dir, 'c1.json', [80, 80]);   // 显著改进
  writeCollect(dir, 'c2.json', [120, 120]); // +20% 回归
  const manifest = writeManifest(dir, 'm.json', [
    { name: 's', baseline: 'base.json', candidates: ['c0.json', 'c1.json', 'c2.json'] },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const c = readJson(out).cases[0];
  assert.deepEqual(c.candidates.map((x) => x.index), [0, 1, 2]);
  assert.deepEqual(c.candidates.map((x) => x.decision),
    ['no_material_change', 'improvement', 'regression']);
  assert.equal(c.first_regression_index, 2);
});

test('全部候选跨 case 统一 BH 校正：adjusted_p_value 与按 manifest 顺序拍平的原始 p 一致', () => {
  const dir = tempDir();
  const mkSeries = (name, base, cands) => {
    writeCollect(dir, `${name}-b.json`, base);
    const files = cands.map((d, i) => {
      writeCollect(dir, `${name}-c${i}.json`, d);
      return `${name}-c${i}.json`;
    });
    return { name, baseline: `${name}-b.json`, candidates: files };
  };
  // 有方差样本，产生 0 与 1 之间的原始 p 值
  const cases = [
    mkSeries('a', [100, 102, 98, 101, 99, 100],
      [[101, 103, 97, 102, 98, 101], [140, 138, 142, 141, 139, 137]]),
    mkSeries('b', [200, 198, 202, 201, 199, 200],
      [[200, 201, 199, 202, 198, 200], [205, 207, 203, 206, 204, 208]]),
  ];
  const manifest = writeManifest(dir, 'm.json', cases);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);

  const flat = result.cases.flatMap((c) => c.candidates);
  assert.equal(flat.length, 4);
  const expected = benjaminiHochberg(flat.map((c) => c.welch.p_value));
  assert.deepEqual(flat.map((c) => c.adjusted_p_value), expected);
  // 至少存在一个非退化原始 p 值，使校正有实际意义
  assert.ok(flat.some((c) => c.welch.p_value > 0 && c.welch.p_value < 1));
  assert.equal(result.suite_summary.total_cases, 2);
  assert.equal(result.suite_summary.total_candidates, 4);
});

test('无 regression 时 first_regression_index 为 null，suite_decision 按既有优先级', () => {
  const dir = tempDir();
  writeCollect(dir, 'base.json', [50, 50]);
  writeCollect(dir, 'c0.json', [40, 40]); // 显著改进
  const manifest = writeManifest(dir, 'm.json', [
    { name: 's', baseline: 'base.json', candidates: ['c0.json'] },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.cases[0].first_regression_index, null);
  assert.equal(result.suite_summary.suite_decision, 'improvement');
  assert.equal(result.suite_summary.improvement, 1);
});

test('相对路径按 manifest 所在目录解析', () => {
  const dir = tempDir();
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  writeCollect(dataDir, 'base.json', [100, 102, 98]);
  writeCollect(dataDir, 'c0.json', [120, 122, 118]);
  const manifest = writeManifest(dataDir, 'series.json', [
    { name: 's', baseline: 'base.json', candidates: ['./c0.json'] },
  ]);
  const out = path.join(dir, 'out.json');
  const r = spawnSync(process.execPath,
    [BIN, 'compare-series', '--manifest', manifest, '--output', out],
    { encoding: 'utf8', cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readJson(out).cases[0].candidates[0].decision, 'regression');
});

test('--key=value 形式与默认 alpha/min-change-percent', () => {
  const dir = tempDir();
  writeCollect(dir, 'base.json', [100, 100]);
  writeCollect(dir, 'c0.json', [103, 103]); // +3%，默认阈值 5 不达标
  const manifest = writeManifest(dir, 'm.json', [
    { name: 's', baseline: 'base.json', candidates: ['c0.json'] },
  ]);
  const out1 = path.join(dir, 'out1.json');
  const r1 = runCli([`--manifest=${manifest}`, `--output=${out1}`]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(readJson(out1).cases[0].candidates[0].decision, 'no_material_change');

  const out2 = path.join(dir, 'out2.json');
  const r2 = runCli(['--manifest', manifest, '--output', out2,
    '--min-change-percent=2']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readJson(out2).cases[0].candidates[0].decision, 'regression');
});

test('manifest 或输入不合口径：退出码 2，stderr 一条，不创建/不改写 output', () => {
  const dir = tempDir();
  const good = writeCollect(dir, 'good.json', [1, 2, 3]);
  const other = writeCollect(dir, 'other.json', [1, 2, 3], { command: 'false' });
  const tooFew = writeCollect(dir, 'few.json', [1]);
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
  const emptyName = writeRaw('empty-name.json', JSON.stringify({
    cases: [{ name: '', baseline: good, candidates: [good] }],
  }));
  const dupName = writeRaw('dup.json', JSON.stringify({
    cases: [
      { name: 'a', baseline: good, candidates: [good] },
      { name: 'a', baseline: good, candidates: [good] },
    ],
  }));
  const emptyBase = writeRaw('empty-base.json', JSON.stringify({
    cases: [{ name: 'a', baseline: '', candidates: [good] }],
  }));
  const noCandidates = writeRaw('no-candidates.json', JSON.stringify({
    cases: [{ name: 'a', baseline: good }],
  }));
  const candidatesNotArray = writeRaw('cand-not-array.json', JSON.stringify({
    cases: [{ name: 'a', baseline: good, candidates: good }],
  }));
  const emptyCandidates = writeRaw('cand-empty.json', JSON.stringify({
    cases: [{ name: 'a', baseline: good, candidates: [] }],
  }));
  const badCandidate = writeRaw('cand-bad.json', JSON.stringify({
    cases: [{ name: 'a', baseline: good, candidates: [good, ''] }],
  }));
  const candidateNotString = writeRaw('cand-number.json', JSON.stringify({
    cases: [{ name: 'a', baseline: good, candidates: [42] }],
  }));
  const missingRef = writeRaw('missing-ref.json', JSON.stringify({
    cases: [{ name: 'a', baseline: good, candidates: ['nope.json'] }],
  }));
  const commandMismatch = writeRaw('cmd-mismatch.json', JSON.stringify({
    cases: [{ name: 'a', baseline: good, candidates: [other] }],
  }));
  const fewSamples = writeRaw('few-samples.json', JSON.stringify({
    cases: [{ name: 'a', baseline: good, candidates: [tooFew] }],
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
    ['--manifest', noCandidates, '--output', out],
    ['--manifest', candidatesNotArray, '--output', out],
    ['--manifest', emptyCandidates, '--output', out],
    ['--manifest', badCandidate, '--output', out],
    ['--manifest', candidateNotString, '--output', out],
    ['--manifest', missingRef, '--output', out],
    ['--manifest', commandMismatch, '--output', out],
    ['--manifest', fewSamples, '--output', out],
    ['--manifest', noCases, '--output', out, '--alpha', '0'],
    ['--manifest', noCases, '--output', out, '--alpha', 'x'],
    ['--manifest', noCases, '--output', out, '--min-change-percent', '-1'],
    ['--manifest', noCases, '--output', out, '--bogus', '1'],
  ];
  for (const args of cases) {
    const r = runCli(args);
    assert.equal(r.status, 2, `应退出码2: ${JSON.stringify(args)} -> ${r.stderr}`);
    assert.equal(r.stderr.trim().split('\n').length, 1,
      `stderr 应仅一条: ${JSON.stringify(args)} -> ${r.stderr}`);
    assert.equal(fs.existsSync(out), false, `不应创建 output: ${JSON.stringify(args)}`);
  }
});

test('输入无效时不改写已存在的 output', () => {
  const dir = tempDir();
  const good = writeCollect(dir, 'good.json', [1, 2, 3]);
  const manifest = writeManifest(dir, 'm.json', [
    { name: 'a', baseline: good, candidates: ['nope.json'] },
  ]);
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('output 写入失败：退出码 4', () => {
  const dir = tempDir();
  writeCollect(dir, 'base.json', [1, 2, 3]);
  writeCollect(dir, 'c0.json', [4, 5, 6]);
  const manifest = writeManifest(dir, 'm.json', [
    { name: 'a', baseline: 'base.json', candidates: ['c0.json'] },
  ]);
  const out = path.join(dir, 'no-such-dir', 'nested', 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});

test('既有子命令行为不受影响（compare-suite 冒烟）', () => {
  const dir = tempDir();
  const base = writeCollect(dir, 'base.json', [100, 100, 100]);
  const cand = writeCollect(dir, 'cand.json', [120, 120, 120]);
  const manifest = writeManifest(dir, 'm.json', [
    { name: 'a', baseline: 'base.json', candidate: 'cand.json' },
  ]);
  const out = path.join(dir, 'out.json');
  const r = spawnSync(process.execPath,
    [BIN, 'compare-suite', '--manifest', manifest, '--output', out],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.deepEqual(Object.keys(result), ['cases', 'suite_summary', 'suite_attribution']);
  assert.equal(result.cases[0].decision, 'regression');
  assert.equal('total_cases' in result.suite_summary, false);
});
