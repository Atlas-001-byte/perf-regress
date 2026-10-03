'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'perf-regress.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, 'compare-suite', ...args], { encoding: 'utf8' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-regress-suite-'));
}

// 以给定 duration_ns 列表构造一份 collect JSON 并写入文件。
function writeCollect(dir, name, durations, { command = 'true' } = {}) {
  const samples = durations.map((d, i) => ({
    index: i,
    started_at: '2026-01-01T00:00:00.000Z',
    duration_ns: d,
    exit_code: 0,
  }));
  const report = { command, runs: durations.length, warmup: 0, timeout_ms: 1000,
    unit: 'ns', samples, summary: {}, errors: [] };
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(report));
  return p;
}

function writeManifest(dir, cases, name = 'manifest.json') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify({ cases }));
  return p;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('套件基本输出：顶层三项、cases 按 manifest 顺序、含 adjusted_p_value', () => {
  const dir = tempDir();
  const b1 = writeCollect(dir, 'b1.json', [100, 102, 98, 101, 99]);
  const c1 = writeCollect(dir, 'c1.json', [120, 122, 118, 121, 119]);
  const b2 = writeCollect(dir, 'b2.json', [100, 110, 90, 105, 95, 120, 80]);
  const c2 = writeCollect(dir, 'c2.json', [101, 109, 91, 104, 96, 119, 81]);
  const manifest = writeManifest(dir, [
    { name: 'case-reg', baseline: b1, candidate: c1 },
    { name: 'case-flat', baseline: b2, candidate: c2 },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const result = readJson(out);
  assert.deepEqual(Object.keys(result), ['cases', 'suite_summary', 'suite_attribution']);

  assert.equal(result.cases.length, 2);
  assert.deepEqual(result.cases.map((c) => c.name), ['case-reg', 'case-flat']);
  assert.deepEqual(Object.keys(result.cases[0]),
    ['name', 'command', 'baseline_summary', 'candidate_summary', 'delta',
      'welch', 'decision', 'attribution', 'adjusted_p_value']);
  assert.equal(result.cases[0].command, 'true');

  // BH：adjusted 不小于原始 p
  for (const c of result.cases) {
    assert.ok(c.adjusted_p_value >= c.welch.p_value);
  }

  assert.deepEqual(Object.keys(result.suite_summary),
    ['total', 'regression', 'improvement', 'no_material_change', 'not_significant', 'suite_decision']);
  assert.equal(result.suite_summary.total, 2);
  assert.equal(result.suite_summary.regression, 1);
  assert.equal(result.suite_summary.not_significant, 1);
  assert.equal(result.suite_summary.suite_decision, 'regression');

  assert.deepEqual(Object.keys(result.suite_attribution),
    ['central_tendency_percent', 'tail_latency_percent', 'variability_percent', 'dominant_factor']);
});

test('BH 校正数值：p 为 0/1 退化情形，adjusted 按 q 公式映回原序', () => {
  const dir = tempDir();
  // 零方差不同均值 -> p=0；零方差相同均值 -> p=1
  const b1 = writeCollect(dir, 'b1.json', [100, 100, 100]);
  const c1 = writeCollect(dir, 'c1.json', [101, 101, 101]);
  const b2 = writeCollect(dir, 'b2.json', [50, 50, 50]);
  const c2 = writeCollect(dir, 'c2.json', [50, 50]);
  // 先写 p=1 的 case，验证映回原序而非排序序
  const manifest = writeManifest(dir, [
    { name: 'same', baseline: b2, candidate: c2 },
    { name: 'diff', baseline: b1, candidate: c1 },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const result = readJson(out);
  assert.equal(result.cases[0].welch.p_value, 1);
  assert.equal(result.cases[0].adjusted_p_value, 1);
  assert.equal(result.cases[0].decision, 'not_significant');
  // m=2，p_(1)=0 -> q = min(1, 2*0/1) = 0
  assert.equal(result.cases[1].welch.p_value, 0);
  assert.equal(result.cases[1].adjusted_p_value, 0);
  // 显著但 1% 未达默认 5% 阈值
  assert.equal(result.cases[1].decision, 'no_material_change');

  assert.equal(result.suite_summary.no_material_change, 1);
  assert.equal(result.suite_summary.not_significant, 1);
  assert.equal(result.suite_summary.suite_decision, 'no_material_change');
});

test('decision 以 adjusted_p_value 判定：原始 p 显著但校正后不显著', () => {
  const dir = tempDir();
  // p≈0.028071：原始 p <= 0.05 显著；m=2 时 adjusted = 2p ≈ 0.056142 > 0.05
  const b1 = writeCollect(dir, 'b1.json', [100, 103, 97, 102, 98, 101, 99, 104]);
  const c1 = writeCollect(dir, 'c1.json', [103, 106, 100, 105, 101, 104, 102, 107]);
  // 零方差相同均值 -> p=1
  const b2 = writeCollect(dir, 'b2.json', [50, 50, 50]);
  const c2 = writeCollect(dir, 'c2.json', [50, 50]);
  const manifest = writeManifest(dir, [
    { name: 'mid', baseline: b1, candidate: c1 },
    { name: 'flat', baseline: b2, candidate: c2 },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const result = readJson(out);
  const mid = result.cases[0];
  assert.ok(mid.welch.p_value <= 0.05, `原始 p 应显著: ${mid.welch.p_value}`);
  // q_(1) = min(1, 2*p/1)；q_(2) = min(1, 2*1/2) = 1
  assert.equal(mid.adjusted_p_value, Math.round(Math.min(1, 2 * mid.welch.p_value) * 1e6) / 1e6);
  assert.ok(mid.adjusted_p_value > 0.05);
  assert.equal(mid.decision, 'not_significant');
  assert.equal(result.cases[1].adjusted_p_value, 1);
  assert.equal(result.suite_summary.suite_decision, 'not_significant');
});

test('improvement 优先于 not_significant；regression 优先于 improvement', () => {
  const dir = tempDir();
  const b1 = writeCollect(dir, 'b1.json', [100, 100, 100]);
  const c1 = writeCollect(dir, 'c1.json', [90, 90, 90]); // -10% improvement
  const b2 = writeCollect(dir, 'b2.json', [50, 50, 50]);
  const c2 = writeCollect(dir, 'c2.json', [50, 50]); // not_significant
  const manifest = writeManifest(dir, [
    { name: 'flat', baseline: b2, candidate: c2 },
    { name: 'better', baseline: b1, candidate: c1 },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.cases[1].decision, 'improvement');
  assert.equal(result.suite_summary.improvement, 1);
  assert.equal(result.suite_summary.suite_decision, 'improvement');
});

test('suite_attribution 取中位数：null 按正无穷参与，正无穷写回 null', () => {
  const dir = tempDir();
  // A: central/tail +20%，variability 0；B: +10%；C: 基线全 0 候选非 0 -> null
  const bA = writeCollect(dir, 'bA.json', [100, 100, 100]);
  const cA = writeCollect(dir, 'cA.json', [120, 120, 120]);
  const bB = writeCollect(dir, 'bB.json', [100, 100, 100]);
  const cB = writeCollect(dir, 'cB.json', [110, 110, 110]);
  const bC = writeCollect(dir, 'bC.json', [0, 0, 0]);
  const cC = writeCollect(dir, 'cC.json', [5, 5, 5]);
  const manifest = writeManifest(dir, [
    { name: 'A', baseline: bA, candidate: cA },
    { name: 'B', baseline: bB, candidate: cB },
    { name: 'C', baseline: bC, candidate: cC },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const result = readJson(out);
  // 单 case 校验 C 的归因百分比为 null
  assert.equal(result.cases[2].attribution.central_tendency_percent, null);
  // 中位数：[10, 20, Inf] -> 20；variability [0, 0, 0] -> 0
  assert.equal(result.suite_attribution.central_tendency_percent, 20);
  assert.equal(result.suite_attribution.tail_latency_percent, 20);
  assert.equal(result.suite_attribution.variability_percent, 0);
  assert.equal(result.suite_attribution.dominant_factor, 'central_tendency');
});

test('suite_attribution 中位数为正无穷时写 null；无正值 dominant_factor 为 none', () => {
  const dir = tempDir();
  // 两个 case 基线均全 0、候选非 0 -> 两个 null，中位数 Inf -> null
  const b1 = writeCollect(dir, 'b1.json', [0, 0, 0]);
  const c1 = writeCollect(dir, 'c1.json', [5, 5, 5]);
  const b2 = writeCollect(dir, 'b2.json', [0, 0, 0]);
  const c2 = writeCollect(dir, 'c2.json', [7, 7, 7]);
  const manifest = writeManifest(dir, [
    { name: 'A', baseline: b1, candidate: c1 },
    { name: 'B', baseline: b2, candidate: c2 },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);
  const attr = readJson(out).suite_attribution;
  assert.equal(attr.central_tendency_percent, null);
  assert.equal(attr.tail_latency_percent, null);
  // null 视为无穷大正向 -> dominant 非 none，平手取 central_tendency
  assert.equal(attr.dominant_factor, 'central_tendency');

  // 全部下降：无正向 -> none
  const dir2 = tempDir();
  const b3 = writeCollect(dir2, 'b3.json', [100, 100, 100]);
  const c3 = writeCollect(dir2, 'c3.json', [90, 90, 90]);
  const manifest2 = writeManifest(dir2, [{ name: 'A', baseline: b3, candidate: c3 }]);
  const out2 = path.join(dir2, 'out.json');
  const r2 = runCli(['--manifest', manifest2, '--output', out2]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readJson(out2).suite_attribution.dominant_factor, 'none');
});

test('相对路径按 manifest 所在目录解析；支持 --key=value', () => {
  const dir = tempDir();
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  writeCollect(sub, 'base.json', [100, 100, 100]);
  writeCollect(sub, 'cand.json', [120, 120, 120]);
  const manifest = writeManifest(sub, [{ name: 'rel', baseline: 'base.json', candidate: 'cand.json' }]);
  const out = path.join(dir, 'out.json');
  const r = runCli([`--manifest=${manifest}`, `--output=${out}`, '--alpha=0.05', '--min-change-percent=5']);
  assert.equal(r.status, 0, r.stderr);
  const result = readJson(out);
  assert.equal(result.cases[0].name, 'rel');
  assert.equal(result.cases[0].decision, 'regression');
});

test('输入无效：退出码 2，stderr 一条原因，不创建 output', () => {
  const dir = tempDir();
  const good = writeCollect(dir, 'good.json', [1, 2, 3]);
  const tooFew = writeCollect(dir, 'too-few.json', [1]);
  const otherCmd = writeCollect(dir, 'other.json', [1, 2, 3], { command: 'false' });
  const out = path.join(dir, 'out.json');

  const notJson = path.join(dir, 'not-json.json');
  fs.writeFileSync(notJson, 'not json{');
  const notObject = path.join(dir, 'arr.json');
  fs.writeFileSync(notObject, '[1,2]');
  const emptyCases = path.join(dir, 'empty.json');
  fs.writeFileSync(emptyCases, JSON.stringify({ cases: [] }));
  const noCases = path.join(dir, 'no-cases.json');
  fs.writeFileSync(noCases, JSON.stringify({}));
  const dupName = path.join(dir, 'dup.json');
  fs.writeFileSync(dupName, JSON.stringify({ cases: [
    { name: 'x', baseline: good, candidate: good },
    { name: 'x', baseline: good, candidate: good },
  ] }));
  const emptyName = path.join(dir, 'empty-name.json');
  fs.writeFileSync(emptyName, JSON.stringify({ cases: [
    { name: '', baseline: good, candidate: good },
  ] }));
  const emptyBaseline = path.join(dir, 'empty-baseline.json');
  fs.writeFileSync(emptyBaseline, JSON.stringify({ cases: [
    { name: 'x', baseline: '', candidate: good },
  ] }));
  const missingFile = writeManifest(dir, [
    { name: 'x', baseline: path.join(dir, 'missing.json'), candidate: good },
  ]);
  const fewSamples = writeManifest(dir, [
    { name: 'x', baseline: tooFew, candidate: good },
  ]);
  const cmdMismatch = writeManifest(dir, [
    { name: 'x', baseline: good, candidate: otherCmd },
  ]);
  const goodManifest = writeManifest(dir, [
    { name: 'x', baseline: good, candidate: good },
  ], 'good-manifest.json');

  const argSets = [
    ['--output', out], // 缺 --manifest
    ['--manifest', goodManifest], // 缺 --output
    ['--manifest', path.join(dir, 'no-such.json'), '--output', out],
    ['--manifest', notJson, '--output', out],
    ['--manifest', notObject, '--output', out],
    ['--manifest', emptyCases, '--output', out],
    ['--manifest', noCases, '--output', out],
    ['--manifest', dupName, '--output', out],
    ['--manifest', emptyName, '--output', out],
    ['--manifest', emptyBaseline, '--output', out],
    ['--manifest', missingFile, '--output', out],
    ['--manifest', fewSamples, '--output', out],
    ['--manifest', cmdMismatch, '--output', out],
    ['--manifest', goodManifest, '--output', out, '--alpha', '0'],
    ['--manifest', goodManifest, '--output', out, '--alpha', '1.5'],
    ['--manifest', goodManifest, '--output', out, '--min-change-percent', '-1'],
    ['--manifest', goodManifest, '--output', out, '--bogus', '1'],
  ];
  for (const args of argSets) {
    const r = runCli(args);
    assert.equal(r.status, 2, `应退出码2: ${JSON.stringify(args)}`);
    assert.equal(r.stderr.trim().split('\n').length, 1, `stderr 应仅一条: ${r.stderr}`);
    assert.equal(fs.existsSync(out), false, `不应创建 output: ${JSON.stringify(args)}`);
  }
});

test('输入无效时不改写已存在的 output', () => {
  const dir = tempDir();
  const tooFew = writeCollect(dir, 'too-few.json', [1]);
  const good = writeCollect(dir, 'good.json', [1, 2, 3]);
  const manifest = writeManifest(dir, [{ name: 'x', baseline: tooFew, candidate: good }]);
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(out, 'KEEP-ME');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(out, 'utf8'), 'KEEP-ME');
});

test('output 写入失败：退出码 4', () => {
  const dir = tempDir();
  const baseline = writeCollect(dir, 'base.json', [1, 2, 3]);
  const candidate = writeCollect(dir, 'cand.json', [4, 5, 6]);
  const manifest = writeManifest(dir, [{ name: 'x', baseline, candidate }]);
  const out = path.join(dir, 'no-such-dir', 'nested', 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 4, r.stderr);
});
