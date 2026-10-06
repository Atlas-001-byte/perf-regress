'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { benjaminiHochberg } = require('../lib/compare-suite');
const { welchTest } = require('../lib/stats');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'compare-series', ...args], { encoding: 'utf8' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-series-'));
}

// 以给定 duration_ns 列表构造一份 collect JSON 并写入临时文件。
function writeCollect(dir, name, durations, { command = 'true', unit = 'ns',
  extraSamples = [] } = {}) {
  const samples = durations.map((d, i) => ({
    index: i,
    started_at: '2026-01-01T00:00:00.000Z',
    duration_ns: d,
    exit_code: 0,
  })).concat(extraSamples);
  const report = { command, runs: samples.length, warmup: 0, timeout_ms: 1000,
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

test('系列成功：结构、字段顺序、固定 baseline、index 从 0 起与零方差退化判定', () => {
  const dir = tempDir();
  const aBase = writeCollect(dir, 'a-base.json', [100, 100, 100]);
  const aC0 = writeCollect(dir, 'a-c0.json', [100, 100, 100]);
  const aC1 = writeCollect(dir, 'a-c1.json', [120, 120, 120]);
  const bBase = writeCollect(dir, 'b-base.json', [120, 120, 120]);
  const bC0 = writeCollect(dir, 'b-c0.json', [100, 100, 100]);
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
  assert.equal(alpha.baseline_summary.count, 3);
  assert.equal(alpha.baseline_summary.mean, 100);
  assert.equal(alpha.candidates.length, 2);
  assert.deepEqual(alpha.candidates.map((c) => c.index), [0, 1]);
  // candidate 回显 manifest 原始路径串
  assert.deepEqual(alpha.candidates.map((c) => c.candidate), ['a-c0.json', 'a-c1.json']);
  for (const c of alpha.candidates) {
    assert.deepEqual(Object.keys(c),
      ['candidate', 'index', 'baseline_summary', 'candidate_summary', 'delta',
        'welch', 'adjusted_p_value', 'decision', 'attribution']);
    // 每个候选都相对同一固定 baseline 重算
    assert.deepEqual(c.baseline_summary, alpha.baseline_summary);
  }

  // 零方差相同均值：p=1；零方差均值不同：p=0
  assert.deepEqual(alpha.candidates[0].welch,
    { t_statistic: 0, degrees_of_freedom: null, p_value: 1 });
  assert.deepEqual(alpha.candidates[1].welch,
    { t_statistic: null, degrees_of_freedom: null, p_value: 0 });
  assert.equal(alpha.candidates[0].adjusted_p_value, 1);
  assert.equal(alpha.candidates[0].decision, 'not_significant');
  assert.equal(alpha.candidates[1].adjusted_p_value, 0);
  assert.equal(alpha.candidates[1].decision, 'regression');
  assert.equal(alpha.candidates[1].delta.mean.percent, 20);
  // 候选的 delta.mean 携带置信区间（零方差退化：两端均为均值差）
  assert.deepEqual(alpha.candidates[1].delta.mean.confidence_interval, {
    level: 0.95, lower_ns: 20, upper_ns: 20, lower_percent: 20, upper_percent: 20,
  });
  assert.deepEqual(alpha.candidates[0].delta.mean.confidence_interval, {
    level: 0.95, lower_ns: 0, upper_ns: 0, lower_percent: 0, upper_percent: 0,
  });
  // 首个 regression 在 index 1
  assert.equal(alpha.first_regression_index, 1);

  assert.equal(beta.candidates[0].index, 0);
  assert.equal(beta.candidates[0].candidate, 'b-c0.json');
  assert.equal(beta.candidates[0].decision, 'improvement');
  assert.equal(beta.candidates[0].delta.mean.percent, -16.666667);
  assert.equal(beta.first_regression_index, null);

  assert.deepEqual(result.suite_summary, {
    total_cases: 2,
    total_candidates: 3,
    regression: 1,
    improvement: 1,
    no_material_change: 0,
    not_significant: 1,
    suite_decision: 'regression',
  });

  // 归因聚合全部 3 个候选：mean/p95 百分比 [0,20,-16.666667] 中位 0；
  // stddev 三项均为 0（两边零方差）-> 0；dominant_factor none。
  assert.deepEqual(Object.keys(result.suite_attribution),
    ['central_tendency_percent', 'tail_latency_percent',
      'variability_percent', 'dominant_factor']);
  assert.equal(result.suite_attribution.central_tendency_percent, 0);
  assert.equal(result.suite_attribution.tail_latency_percent, 0);
  assert.equal(result.suite_attribution.variability_percent, 0);
  assert.equal(result.suite_attribution.dominant_factor, 'none');
});

test('first_regression_index 跳过前面的 improvement/非显著，取首个 regression', () => {
  const dir = tempDir();
  writeCollect(dir, 'base.json', [100, 100, 100]);
  writeCollect(dir, 'c0.json', [80, 80, 80]);   // -20% improvement
  writeCollect(dir, 'c1.json', [100, 100, 100]); // 持平不显著
  writeCollect(dir, 'c2.json', [120, 120, 120]); // +20% regression
  const manifest = writeManifest(dir, 'm.json', [
    { name: 's', baseline: 'base.json', candidates: ['c0.json', 'c1.json', 'c2.json'] },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.deepEqual(result.cases[0].candidates.map((c) => c.decision),
    ['improvement', 'not_significant', 'regression']);
  assert.equal(result.cases[0].first_regression_index, 2);
  assert.equal(result.suite_summary.suite_decision, 'regression');
});

test('全部候选跨 case 统一 BH（区别于逐 case 校正）', () => {
  const dir = tempDir();
  // 同一 baseline 下三个候选的原始 p 值互不相同且均不显著
  writeCollect(dir, 'g-base.json', [1, 1, 4]);
  writeCollect(dir, 'g-c0.json', [1, 4, 6]);
  writeCollect(dir, 'g-c1.json', [1, 3, 6]);
  writeCollect(dir, 'g-c2.json', [1, 2, 5]);
  // 第二个 case：零方差显著回归
  writeCollect(dir, 'h-base.json', [100, 100, 100]);
  writeCollect(dir, 'h-c0.json', [120, 120, 120]);
  const manifest = writeManifest(dir, 'm.json', [
    { name: 'g', baseline: 'g-base.json',
      candidates: ['g-c0.json', 'g-c1.json', 'g-c2.json'] },
    { name: 'h', baseline: 'h-base.json', candidates: ['h-c0.json'] },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);

  const base = [1, 1, 4];
  const raws = [
    welchTest(base, [1, 4, 6]).p_value,
    welchTest(base, [1, 3, 6]).p_value,
    welchTest(base, [1, 2, 5]).p_value,
    welchTest([100, 100, 100], [120, 120, 120]).p_value,
  ];
  const globalAdjusted = benjaminiHochberg(raws);
  const perCaseAdjusted = benjaminiHochberg(raws.slice(0, 3));
  // 全局与逐 case 的校正值确实不同，保证本测试有区分度
  assert.notEqual(globalAdjusted[0], perCaseAdjusted[0]);

  const g = result.cases[0];
  assert.deepEqual(g.candidates.map((c) => c.adjusted_p_value), globalAdjusted.slice(0, 3));
  assert.deepEqual(g.candidates.map((c) => c.welch.p_value), raws.slice(0, 3));
  for (const c of g.candidates) {
    assert.equal(c.decision, 'not_significant');
  }
  assert.equal(g.first_regression_index, null);

  const h = result.cases[1];
  assert.equal(h.candidates[0].adjusted_p_value, globalAdjusted[3]);
  assert.equal(h.candidates[0].adjusted_p_value, 0);
  assert.equal(h.candidates[0].decision, 'regression');
  assert.equal(h.first_regression_index, 0);

  assert.deepEqual(result.suite_summary, {
    total_cases: 2,
    total_candidates: 4,
    regression: 1,
    improvement: 0,
    no_material_change: 0,
    not_significant: 3,
    suite_decision: 'regression',
  });
});

test('suite_decision 优先级：regression > improvement > no_material_change > not_significant', () => {
  const dir = tempDir();
  const mk = (name, base, cands) => {
    writeCollect(dir, `${name}-b.json`, base);
    cands.forEach((d, i) => writeCollect(dir, `${name}-c${i}.json`, d));
    return { name, baseline: `${name}-b.json`,
      candidates: cands.map((_, i) => `${name}-c${i}.json`) };
  };
  const flat = [70, 70];
  const reg = mk('reg', [100, 100, 100], [[120, 120, 120]]);
  const imp = mk('imp', [120, 120, 120], [[100, 100, 100]]);
  const same = mk('same', flat, [[70, 70]]);
  const nmc = mk('nmc', [100, 100], [[103, 103]]); // +3% 显著但未达默认 5%

  const run = (cases) => {
    const m = writeManifest(dir, `m-${Math.random()}.json`, cases);
    const o = path.join(dir, `o-${Math.random()}.json`);
    const rr = runCli(['--manifest', m, '--output', o]);
    assert.equal(rr.status, 0, rr.stderr);
    return readJson(o).suite_summary.suite_decision;
  };
  assert.equal(run([imp, same, reg]), 'regression');
  assert.equal(run([same, imp]), 'improvement');
  assert.equal(run([same, nmc]), 'no_material_change');
  assert.equal(run([same]), 'not_significant');
});

test('suite_attribution 聚合全部候选：中位数、null 正无穷与 dominant_factor', () => {
  const dir = tempDir();
  // case1 两候选：+100% 与 0%
  writeCollect(dir, 'c1-b.json', [50, 100, 150]);
  writeCollect(dir, 'c1-c0.json', [100, 200, 300]);
  writeCollect(dir, 'c1-c1.json', [50, 100, 150]);
  // case2 一个候选：基线 0 候选非 0 -> mean/p95 百分比 null（正无穷）
  writeCollect(dir, 'c2-b.json', [0, 0, 0]);
  writeCollect(dir, 'c2-c0.json', [5, 5, 5]);
  const manifest = writeManifest(dir, 'm.json', [
    { name: 'c1', baseline: 'c1-b.json', candidates: ['c1-c0.json', 'c1-c1.json'] },
    { name: 'c2', baseline: 'c2-b.json', candidates: ['c2-c0.json'] },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  // mean 百分比 [100, 0, null] 排序 [0,100,Inf] -> 中位 100
  assert.equal(result.suite_attribution.central_tendency_percent, 100);
  assert.equal(result.suite_attribution.tail_latency_percent, 100);
  // stddev：c1-c0 +100%，c1-c1 0%，c2-c0 两边零方差 0% -> 中位 0
  assert.equal(result.suite_attribution.variability_percent, 0);
  assert.equal(result.suite_attribution.dominant_factor, 'central_tendency');
});

test('相对路径按 manifest 所在目录解析，且各 case command 可不同', () => {
  const dir = tempDir();
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  writeCollect(dataDir, 'a-base.json', [100, 102, 98]);
  writeCollect(dataDir, 'a-cand.json', [120, 122, 118]);
  writeCollect(dataDir, 'b-base.json', [10, 11], { command: 'false' });
  writeCollect(dataDir, 'b-cand.json', [20, 21], { command: 'false' });
  const manifest = writeManifest(dataDir, 'series.json', [
    { name: 'a', baseline: 'a-base.json', candidates: ['./a-cand.json'] },
    { name: 'b', baseline: 'b-base.json', candidates: ['b-cand.json'] },
  ]);
  const out = path.join(dir, 'out.json');
  const r = spawnSync(process.execPath,
    [BIN, 'compare-series', '--manifest', manifest, '--output', out],
    { encoding: 'utf8', cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.deepEqual(result.cases.map((c) => c.command), ['true', 'false']);
  assert.equal(result.cases[0].candidates[0].decision, 'regression');
  assert.equal(result.cases[1].candidates[0].decision, 'regression');
  assert.equal(result.suite_summary.total_cases, 2);
  assert.equal(result.suite_summary.total_candidates, 2);
});

test('--key=value 形式与默认/自定义 alpha、min-change-percent', () => {
  const dir = tempDir();
  writeCollect(dir, 'base.json', [100, 100, 100]);
  writeCollect(dir, 'cand.json', [103, 103, 103]); // +3%，默认阈值 5 不达标
  const manifest = writeManifest(dir, 'm.json', [
    { name: 'c', baseline: 'base.json', candidates: ['cand.json'] },
  ]);
  const out1 = path.join(dir, 'out1.json');
  const r1 = runCli([`--manifest=${manifest}`, `--output=${out1}`]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(readJson(out1).cases[0].candidates[0].decision, 'no_material_change');
  assert.equal(readJson(out1).cases[0].first_regression_index, null);

  const out2 = path.join(dir, 'out2.json');
  const r2 = runCli(['--manifest', manifest, '--output', out2,
    '--min-change-percent=2']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readJson(out2).cases[0].candidates[0].decision, 'regression');
  assert.equal(readJson(out2).cases[0].first_regression_index, 0);
});

test('collect errors（非 0 退出样本）不参与统计', () => {
  const dir = tempDir();
  writeCollect(dir, 'base.json', [100, 100, 100]);
  // 三个有效样本 + 一个 exit_code 非 0 的样本，统计应只计 3 个
  const cand = writeCollect(dir, 'cand.json', [120, 120, 120], {
    extraSamples: [{
      index: 3,
      started_at: '2026-01-01T00:00:01.000Z',
      duration_ns: 999,
      exit_code: 1,
    }],
  });
  const manifest = writeManifest(dir, 'm.json', [
    { name: 'c', baseline: 'base.json', candidates: [path.basename(cand)] },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.cases[0].candidates[0].candidate_summary.count, 3);
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
  const missingBase = writeRaw('missing-base.json', JSON.stringify({
    cases: [{ name: 'a', candidates: [good] }],
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
    cases: [{ name: 'a', baseline: good, candidates: [42] }],
  }));
  const emptyCandidate = writeRaw('cand-empty-str.json', JSON.stringify({
    cases: [{ name: 'a', baseline: good, candidates: [''] }],
  }));
  const missingRef = writeRaw('missing-ref.json', JSON.stringify({
    cases: [{ name: 'a', baseline: good, candidates: ['nope.json'] }],
  }));
  const commandMismatch = writeRaw('cmd-mismatch.json', JSON.stringify({
    cases: [{ name: 'a', baseline: good, candidates: [other] }],
  }));
  const fewSamples = writeRaw('few-samples.json', JSON.stringify({
    cases: [{ name: 'a', baseline: tooFew, candidates: [good] }],
  }));
  const fewSamplesCand = writeRaw('few-samples-cand.json', JSON.stringify({
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
    ['--manifest', missingBase, '--output', out],
    ['--manifest', noCandidates, '--output', out],
    ['--manifest', candidatesNotArray, '--output', out],
    ['--manifest', emptyCandidates, '--output', out],
    ['--manifest', badCandidate, '--output', out],
    ['--manifest', emptyCandidate, '--output', out],
    ['--manifest', missingRef, '--output', out],
    ['--manifest', commandMismatch, '--output', out],
    ['--manifest', fewSamples, '--output', out],
    ['--manifest', fewSamplesCand, '--output', out],
    ['--manifest', noCases], // 缺 --output
    ['--manifest', noCases, '--output', out, '--alpha', '0'],
    ['--manifest', noCases, '--output', out, '--alpha', '1'],
    ['--manifest', noCases, '--output', out, '--alpha', '-0.1'],
    ['--manifest', noCases, '--output', out, '--alpha', 'x'],
    ['--manifest', noCases, '--output', out, '--min-change-percent', '-1'],
    ['--manifest', noCases, '--output', out, '--bogus', '1'],
    ['--manifest', noCases, '--manifest', noCases, '--output', out],
  ];
  for (const args of cases) {
    const rr = runCli(args);
    assert.equal(rr.status, 2, `应退出码2: ${JSON.stringify(args)} -> ${rr.stderr}`);
    assert.equal(rr.stderr.trim().split('\n').length, 1,
      `stderr 应仅一条: ${JSON.stringify(args)} -> ${rr.stderr}`);
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
  writeCollect(dir, 'cand.json', [4, 5, 6]);
  const manifest = writeManifest(dir, 'm.json', [
    { name: 'a', baseline: 'base.json', candidates: ['cand.json'] },
  ]);
  const out = path.join(dir, 'no-such-dir', 'nested', 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});

test('既有子命令行为不受影响（compare-suite 冒烟）', () => {
  const dir = tempDir();
  const base = writeCollect(dir, 'base.json', [100, 102, 98]);
  const cand = writeCollect(dir, 'cand.json', [120, 122, 118]);
  const manifest = writeManifest(dir, 'm.json', [
    { name: 'c', baseline: 'base.json', candidate: 'cand.json' },
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
  assert.equal('candidates' in result.cases[0], false);
});
