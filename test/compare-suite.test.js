'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { benjaminiHochberg, medianPercent } = require('../lib/compare-suite');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'compare-suite', ...args], { encoding: 'utf8' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-suite-'));
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

test('BH 校正：q_(i)=min(1,min over j>=i (m*p_(j)/j))，映回原序并保留六位小数', () => {
  // 排序后 0.01/0.03/0.04：原始阈值 0.03、0.045、0.04，自秩 m 向 1 取 min
  // -> 0.03、0.04、0.04，映回原序
  assert.deepEqual(benjaminiHochberg([0.01, 0.04, 0.03]), [0.03, 0.04, 0.04]);
  assert.deepEqual(benjaminiHochberg([0.5]), [0.5]);
  // 不超过 1
  assert.deepEqual(benjaminiHochberg([0.9, 0.9]), [0.9, 0.9]);
  // 六位小数
  const adjusted = benjaminiHochberg([0.123456789, 0.0000001]);
  for (const v of adjusted) {
    assert.equal(v, Math.round(v * 1e6) / 1e6);
  }
});

test('suite 归因中位数：null 按正无穷比较，正无穷结果写 null', () => {
  assert.equal(medianPercent([10, null, 20]), 20);
  assert.equal(medianPercent([null, 10, 20]), 20);
  assert.equal(medianPercent([-5, null, 3]), 3);
  assert.equal(medianPercent([10, 20]), 15);
  assert.equal(medianPercent([null]), null);
  assert.equal(medianPercent([null, null]), null);
  assert.equal(medianPercent([10, null]), null); // (10 + Inf) / 2 = Inf
});

test('套件成功：cases 按 manifest 顺序，结构、字段顺序与零方差退化判定正确', () => {
  const dir = tempDir();
  const a1 = writeCollect(dir, 'a-base.json', [100, 100, 100]);
  const a2 = writeCollect(dir, 'a-cand.json', [120, 120, 120]);
  const b1 = writeCollect(dir, 'b-base.json', [50, 50]);
  const b2 = writeCollect(dir, 'b-cand.json', [50, 50]);
  const manifest = writeManifest(dir, 'manifest.json', [
    { name: 'alpha', baseline: 'a-base.json', candidate: 'a-cand.json' },
    { name: 'beta', baseline: 'b-base.json', candidate: 'b-cand.json' },
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
      ['name', 'command', 'baseline_summary', 'candidate_summary', 'delta',
        'welch', 'adjusted_p_value', 'decision', 'attribution']);
    assert.equal(c.command, 'true');
    assert.deepEqual(Object.keys(c.suite_summary || {}), []);
  }

  const [alpha, beta] = result.cases;
  // 零方差且均值不同：p=0；m=2 校正后仍为 0；增幅 20% 达默认阈值
  assert.deepEqual(alpha.welch, { t_statistic: null, degrees_of_freedom: null, p_value: 0 });
  assert.equal(alpha.adjusted_p_value, 0);
  assert.equal(alpha.decision, 'regression');
  assert.equal(alpha.delta.mean.percent, 20);
  // 区间退化为单点：两端均为候选减基线差（20ns / 20%）
  assert.deepEqual(alpha.delta.mean.confidence_interval, {
    level: 0.95, lower_ns: 20, upper_ns: 20, lower_percent: 20, upper_percent: 20,
  });
  // 零方差相同均值：p=1，校正后仍为 1；区间两端为 0
  assert.equal(beta.welch.p_value, 1);
  assert.equal(beta.adjusted_p_value, 1);
  assert.equal(beta.decision, 'not_significant');
  assert.deepEqual(beta.delta.mean.confidence_interval, {
    level: 0.95, lower_ns: 0, upper_ns: 0, lower_percent: 0, upper_percent: 0,
  });
  // 仅 mean 有区间，其余三项无
  for (const c of result.cases) {
    assert.deepEqual(Object.keys(c.delta.mean.confidence_interval),
      ['level', 'lower_ns', 'upper_ns', 'lower_percent', 'upper_percent']);
    assert.equal('confidence_interval' in c.delta.median, false);
    assert.equal('confidence_interval' in c.delta.p95, false);
    assert.equal('confidence_interval' in c.delta.stddev, false);
  }

  assert.deepEqual(result.suite_summary, {
    total: 2,
    regression: 1,
    improvement: 0,
    no_material_change: 0,
    not_significant: 1,
    suite_decision: 'regression',
  });

  assert.deepEqual(Object.keys(result.suite_attribution),
    ['central_tendency_percent', 'tail_latency_percent',
      'variability_percent', 'dominant_factor']);
  // alpha mean/p95 +20% 而 stddev 两边均为 0（百分比 0），beta 全 0%
  assert.equal(result.suite_attribution.central_tendency_percent, 10);
  assert.equal(result.suite_attribution.tail_latency_percent, 10);
  assert.equal(result.suite_attribution.variability_percent, 0);
  assert.equal(result.suite_attribution.dominant_factor, 'central_tendency');
});

test('相对路径按 manifest 所在目录解析', () => {
  const dir = tempDir();
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  writeCollect(dataDir, 'base.json', [100, 102, 98]);
  writeCollect(dataDir, 'cand.json', [120, 122, 118]);
  const manifest = writeManifest(dataDir, 'suite.json', [
    { name: 'c', baseline: 'base.json', candidate: './cand.json' },
  ]);
  // 从另一个 cwd 调用，证明不以 cwd 解析
  const out = path.join(dir, 'out.json');
  const r = spawnSync(process.execPath,
    [BIN, 'compare-suite', '--manifest', manifest, '--output', out],
    { encoding: 'utf8', cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.cases[0].decision, 'regression');
});

test('confidence_interval：alpha 只改 level/区间，p 值、BH 校正、decision、suite 汇总与归因不变', () => {
  const dir = tempDir();
  writeCollect(dir, 'a-b.json', [1, 2, 3]);
  writeCollect(dir, 'a-c.json', [4, 5, 6]);
  writeCollect(dir, 'b-b.json', [100, 102, 98]);
  writeCollect(dir, 'b-c.json', [120, 122, 118]);
  const manifest = writeManifest(dir, 'm.json', [
    { name: 'a', baseline: 'a-b.json', candidate: 'a-c.json' },
    { name: 'b', baseline: 'b-b.json', candidate: 'b-c.json' },
  ]);
  const run = (alpha) => {
    const out = path.join(dir, `o-${alpha}.json`);
    const rr = runCli(['--manifest', manifest, '--output', out, '--alpha', String(alpha)]);
    assert.equal(rr.status, 0, rr.stderr);
    return readJson(out);
  };
  const r95 = run(0.05);
  const r90 = run(0.1);
  assert.equal(r95.cases[0].delta.mean.confidence_interval.level, 0.95);
  assert.equal(r90.cases[0].delta.mean.confidence_interval.level, 0.9);
  // 除区间外逐字段一致
  for (let i = 0; i < r95.cases.length; i++) {
    assert.deepEqual(r95.cases[i].welch, r90.cases[i].welch);
    assert.equal(r95.cases[i].adjusted_p_value, r90.cases[i].adjusted_p_value);
    assert.equal(r95.cases[i].decision, r90.cases[i].decision);
    assert.equal(r95.cases[i].delta.mean.ns, r90.cases[i].delta.mean.ns);
    assert.equal(r95.cases[i].delta.mean.percent, r90.cases[i].delta.mean.percent);
    assert.deepEqual(r95.cases[i].attribution, r90.cases[i].attribution);
    const w95 = r95.cases[i].delta.mean.confidence_interval.upper_ns
      - r95.cases[i].delta.mean.confidence_interval.lower_ns;
    const w90 = r90.cases[i].delta.mean.confidence_interval.upper_ns
      - r90.cases[i].delta.mean.confidence_interval.lower_ns;
    assert.ok(w90 < w95);
  }
  assert.deepEqual(r95.suite_summary, r90.suite_summary);
  assert.deepEqual(r95.suite_attribution, r90.suite_attribution);
});

test('--key=value 形式与默认 alpha/min-change-percent', () => {
  const dir = tempDir();
  writeCollect(dir, 'base.json', [100, 100, 100]);
  writeCollect(dir, 'cand.json', [103, 103, 103]); // +3%，默认阈值 5 不达标
  const manifest = writeManifest(dir, 'm.json', [
    { name: 'c', baseline: 'base.json', candidate: 'cand.json' },
  ]);
  const out1 = path.join(dir, 'out1.json');
  const r1 = runCli([`--manifest=${manifest}`, `--output=${out1}`]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(readJson(out1).cases[0].decision, 'no_material_change');

  // 阈值降到 2 -> regression
  const out2 = path.join(dir, 'out2.json');
  const r2 = runCli(['--manifest', manifest, '--output', out2,
    '--min-change-percent=2']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readJson(out2).cases[0].decision, 'regression');
});

test('suite_decision 优先级：regression > improvement > no_material_change > not_significant', () => {
  const dir = tempDir();
  const mkCase = (name, base, cand) => {
    writeCollect(dir, `${name}-b.json`, base);
    writeCollect(dir, `${name}-c.json`, cand);
    return { name, baseline: `${name}-b.json`, candidate: `${name}-c.json` };
  };
  const reg = mkCase('reg', [100, 100, 100], [120, 120, 120]);
  const imp = mkCase('imp', [120, 120, 120], [100, 100, 100]);
  const flat = mkCase('flat', [70, 70], [70, 70]);

  const out1 = path.join(dir, 'out1.json');
  const m1 = writeManifest(dir, 'm1.json', [imp, flat, reg]);
  const r1 = runCli(['--manifest', m1, '--output', out1]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(readJson(out1).suite_summary.suite_decision, 'regression');

  const out2 = path.join(dir, 'out2.json');
  const m2 = writeManifest(dir, 'm2.json', [flat, imp]);
  const r2 = runCli(['--manifest', m2, '--output', out2]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readJson(out2).suite_summary.suite_decision, 'improvement');

  const out3 = path.join(dir, 'out3.json');
  // +3% 显著（零方差）但未达 5% 阈值
  const nmc = mkCase('nmc', [100, 100], [103, 103]);
  const m3 = writeManifest(dir, 'm3.json', [flat, nmc]);
  const r3 = runCli(['--manifest', m3, '--output', out3]);
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(readJson(out3).suite_summary.suite_decision, 'no_material_change');

  const out4 = path.join(dir, 'out4.json');
  const m4 = writeManifest(dir, 'm4.json', [flat]);
  const r4 = runCli(['--manifest', m4, '--output', out4]);
  assert.equal(r4.status, 0, r4.stderr);
  assert.equal(readJson(out4).suite_summary.suite_decision, 'not_significant');
});

test('suite 归因：null（基线 0 候选非 0）中位数与 dominant_factor', () => {
  const dir = tempDir();
  // case1: mean/p95/stddev 均 +100%
  writeCollect(dir, 'c1-b.json', [50, 100, 150]);
  writeCollect(dir, 'c1-c.json', [100, 200, 300]);
  // case2: 基线均值 0、候选非 0 -> mean 百分比 null（视为正无穷）
  writeCollect(dir, 'c2-b.json', [0, 0, 0]);
  writeCollect(dir, 'c2-c.json', [5, 5, 5]);
  // case3: 持平
  writeCollect(dir, 'c3-b.json', [80, 80]);
  writeCollect(dir, 'c3-c.json', [80, 80]);
  const manifest = writeManifest(dir, 'm.json', [
    { name: 'c1', baseline: 'c1-b.json', candidate: 'c1-c.json' },
    { name: 'c2', baseline: 'c2-b.json', candidate: 'c2-c.json' },
    { name: 'c3', baseline: 'c3-b.json', candidate: 'c3-c.json' },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  // mean 百分比 [100, null, 0] 排序 [0,100,Inf] -> 中位 100
  assert.equal(result.suite_attribution.central_tendency_percent, 100);
  // c2 两边方差均为 0，stddev 百分比 0；p95 百分比为 null -> [100,null,0] -> 100
  assert.equal(result.suite_attribution.tail_latency_percent, 100);
  // c1 stddev +100%，c2 0%，c3 0% -> 中位 0
  assert.equal(result.suite_attribution.variability_percent, 0);
  assert.equal(result.suite_attribution.dominant_factor, 'central_tendency');
});

test('suite 归因：中位数为正无穷时写 null；null 视为正无穷正值，平手按顺序取 central_tendency', () => {
  const dir = tempDir();
  // 两个 case 均为基线 0 候选非 0 -> 三项百分比全 null
  for (const n of ['x', 'y']) {
    writeCollect(dir, `${n}-b.json`, [0, 0]);
    writeCollect(dir, `${n}-c.json`, [5, 5]);
  }
  const manifest = writeManifest(dir, 'm.json', [
    { name: 'x', baseline: 'x-b.json', candidate: 'x-c.json' },
    { name: 'y', baseline: 'y-b.json', candidate: 'y-c.json' },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.suite_attribution.central_tendency_percent, null);
  assert.equal(result.suite_attribution.tail_latency_percent, null);
  assert.equal(result.suite_attribution.variability_percent, 0); // 0->0 为 0，非 null
  assert.equal(result.suite_attribution.dominant_factor, 'central_tendency');
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
    cases: [{ name: '', baseline: good, candidate: good }],
  }));
  const dupName = writeRaw('dup.json', JSON.stringify({
    cases: [
      { name: 'a', baseline: good, candidate: good },
      { name: 'a', baseline: good, candidate: good },
    ],
  }));
  const emptyBase = writeRaw('empty-base.json', JSON.stringify({
    cases: [{ name: 'a', baseline: '', candidate: good }],
  }));
  const missingRef = writeRaw('missing-ref.json', JSON.stringify({
    cases: [{ name: 'a', baseline: 'nope.json', candidate: good }],
  }));
  const commandMismatch = writeRaw('cmd-mismatch.json', JSON.stringify({
    cases: [{ name: 'a', baseline: good, candidate: other }],
  }));
  const fewSamples = writeRaw('few-samples.json', JSON.stringify({
    cases: [{ name: 'a', baseline: tooFew, candidate: good }],
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
    assert.equal(r.status, 2, `应退出码2: ${JSON.stringify(args)}`);
    assert.equal(r.stderr.trim().split('\n').length, 1,
      `stderr 应仅一条: ${JSON.stringify(args)} -> ${r.stderr}`);
    assert.equal(fs.existsSync(out), false, `不应创建 output: ${JSON.stringify(args)}`);
  }
});

test('输入无效时不改写已存在的 output', () => {
  const dir = tempDir();
  const good = writeCollect(dir, 'good.json', [1, 2, 3]);
  const manifest = writeManifest(dir, 'm.json', {
    cases: [{ name: 'a', baseline: 'nope.json', candidate: good }],
  });
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
    { name: 'a', baseline: 'base.json', candidate: 'cand.json' },
  ]);
  const out = path.join(dir, 'no-such-dir', 'nested', 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});

test('collect 与 compare 行为不受影响（compare 冒烟）', () => {
  const dir = tempDir();
  const base = writeCollect(dir, 'base.json', [100, 102, 98, 101, 99]);
  const cand = writeCollect(dir, 'cand.json', [120, 122, 118, 121, 119]);
  const out = path.join(dir, 'out.json');
  const r = spawnSync(process.execPath,
    [BIN, 'compare', '--baseline', base, '--candidate', cand, '--output', out],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.deepEqual(Object.keys(result),
    ['baseline_summary', 'candidate_summary', 'delta', 'welch', 'decision', 'attribution']);
  assert.equal(result.decision, 'regression');
  assert.equal('adjusted_p_value' in result, false);
});
