'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  benjaminiHochberg,
} = require('../lib/compare-suite');
const { welchTest } = require('../lib/stats');
const {
  analyzeTrend,
  attributionTransitions,
  caseAttribution,
  suiteDominantFactor,
} = require('../lib/compare-series');

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

// 构造只带 dominant_factor 的伪候选报告。
function factorCand(factor) {
  return { attribution: { dominant_factor: factor } };
}

// 构造只带三项归因百分比的伪候选报告。
function attrCand(central, tail, variability) {
  return {
    attribution: {
      central_tendency_percent: central,
      tail_latency_percent: tail,
      variability_percent: variability,
    },
  };
}

test('analyzeTrend：连续 regression 切分，持续段与暂态段及 recovery_index', () => {
  assert.deepEqual(analyzeTrend([]), {
    regressionRuns: [], transientRuns: [], persistentStart: null,
  });
  assert.deepEqual(analyzeTrend(['not_significant', 'improvement']), {
    regressionRuns: [], transientRuns: [], persistentStart: null,
  });
  // 单候选 regression 即持续到末尾
  assert.deepEqual(analyzeTrend(['regression']), {
    regressionRuns: [{ start_index: 0, end_index: 0, extends_to_end: true }],
    transientRuns: [],
    persistentStart: 0,
  });
  // 段后恢复 -> 暂态，recovery_index 为段后首个 index
  assert.deepEqual(analyzeTrend(['regression', 'not_significant']), {
    regressionRuns: [{ start_index: 0, end_index: 0, extends_to_end: false }],
    transientRuns: [{ start_index: 0, end_index: 0, recovery_index: 1 }],
    persistentStart: null,
  });
  // 暂态段后再出现持续段：两段都在 regression_runs，只有末段写起点
  assert.deepEqual(
    analyzeTrend(['regression', 'not_significant', 'regression', 'regression']),
    {
      regressionRuns: [
        { start_index: 0, end_index: 0, extends_to_end: false },
        { start_index: 2, end_index: 3, extends_to_end: true },
      ],
      transientRuns: [{ start_index: 0, end_index: 0, recovery_index: 1 }],
      persistentStart: 2,
    });
  // 长暂态段 recovery_index 指向 end_index + 1；末尾另起一段为持续
  assert.deepEqual(
    analyzeTrend(['regression', 'regression', 'not_significant', 'regression']),
    {
      regressionRuns: [
        { start_index: 0, end_index: 1, extends_to_end: false },
        { start_index: 3, end_index: 3, extends_to_end: true },
      ],
      transientRuns: [{ start_index: 0, end_index: 1, recovery_index: 2 }],
      persistentStart: 3,
    });
});

test('attributionTransitions：相邻 dominant_factor 变化（含 none 双向），无变化为 []', () => {
  assert.deepEqual(attributionTransitions([factorCand('none')]), []);
  assert.deepEqual(
    attributionTransitions([
      factorCand('none'),
      factorCand('central_tendency'),
      factorCand('tail_latency'),
      factorCand('tail_latency'),
      factorCand('none'),
    ]),
    [
      { from_index: 0, to_index: 1,
        from_factor: 'none', to_factor: 'central_tendency' },
      { from_index: 1, to_index: 2,
        from_factor: 'central_tendency', to_factor: 'tail_latency' },
      { from_index: 3, to_index: 4,
        from_factor: 'tail_latency', to_factor: 'none' },
    ]);
});

test('caseAttribution：无持续段四项 null；有持续段取段内中位数与平手顺序', () => {
  assert.deepEqual(caseAttribution([attrCand(10, 20, 30)], null), {
    central_tendency_percent: null,
    tail_latency_percent: null,
    variability_percent: null,
    dominant_factor: null,
  });

  // 偶数段取中间两值平均：[10,20] -> 15
  const seg2 = [attrCand(10, 10, 0), attrCand(20, 20, 0)];
  assert.deepEqual(caseAttribution(seg2, 0), {
    central_tendency_percent: 15,
    tail_latency_percent: 15,
    variability_percent: 0,
    dominant_factor: 'central_tendency', // central 与 tail 平手 -> central
  });

  // 三候选中位数；central 与 tail 中位均 10 平手按顺序取 central
  const segTail = [
    attrCand(5, 0, 0),
    attrCand(10, 10, 0),
    attrCand(20, 20, 0),
  ];
  assert.deepEqual(caseAttribution(segTail, 0), {
    central_tendency_percent: 10,
    tail_latency_percent: 10,
    variability_percent: 0,
    dominant_factor: 'central_tendency', // 10 平手仍按顺序取 central
  });
  const segTailWins = [
    attrCand(0, 10, 5),
    attrCand(5, 20, 0),
    attrCand(2, 30, 3),
  ];
  // central 中位 5，tail 中位 20，variability 中位 3 -> tail
  assert.equal(caseAttribution(segTailWins, 0).dominant_factor, 'tail_latency');
  // variability 最大
  const segVar = [attrCand(5, 5, 10), attrCand(0, 0, 20)];
  assert.equal(caseAttribution(segVar, 0).dominant_factor, 'variability');
  // 无正值 -> none
  const segNone = [attrCand(-5, -2, 0), attrCand(0, -3, -8)];
  const noneAttr = caseAttribution(segNone, 0);
  assert.equal(noneAttr.dominant_factor, 'none');

  // null 按正无穷参与中位数：[10,20,null] 中位 20；[null,null] 中位 null
  assert.equal(caseAttribution(
    [attrCand(10, 0, 0), attrCand(20, 0, 0), attrCand(null, 0, 0)], 0)
    .central_tendency_percent, 20);
  const infAttr = caseAttribution(
    [attrCand(null, 0, 0), attrCand(null, 0, 0)], 0);
  assert.equal(infAttr.central_tendency_percent, null);
  assert.equal(infAttr.dominant_factor, 'central_tendency');
});

test('suiteDominantFactor：非 null 值多数决，平手按固定顺序，全 null 为 none', () => {
  const caseWith = (factor) => ({ case_attribution: { dominant_factor: factor } });
  assert.equal(suiteDominantFactor([caseWith(null), caseWith(null)]), 'none');
  assert.equal(suiteDominantFactor([caseWith('none')]), 'none');
  assert.equal(
    suiteDominantFactor([caseWith('central_tendency'), caseWith('none'),
      caseWith('none')]),
    'none'); // none 两票
  assert.equal(
    suiteDominantFactor([caseWith('central_tendency'),
      caseWith('central_tendency'), caseWith('tail_latency')]),
    'central_tendency');
  // 三类各一票平手 -> central
  assert.equal(
    suiteDominantFactor([caseWith('central_tendency'),
      caseWith('tail_latency'), caseWith('variability')]),
    'central_tendency');
  // tail 与 variability 平手 -> tail
  assert.equal(
    suiteDominantFactor([caseWith('variability'), caseWith('tail_latency')]),
    'tail_latency');
});

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
  assert.deepEqual(Object.keys(result), ['cases', 'timeline_summary']);
  assert.equal(result.cases.length, 2);

  assert.deepEqual(result.cases.map((c) => c.name), ['alpha', 'beta']);
  for (const c of result.cases) {
    assert.deepEqual(Object.keys(c),
      ['name', 'command', 'baseline_summary', 'candidates',
        'trend_analysis', 'case_attribution']);
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
  // 零方差相同均值：区间两端 0
  assert.deepEqual(alpha.candidates[0].delta.mean.confidence_interval, {
    level: 0.95, lower_ns: 0, upper_ns: 0, lower_percent: 0, upper_percent: 0,
  });
  // 零方差均值不同：区间退化为单点 20ns / 20%
  assert.deepEqual(alpha.candidates[1].delta.mean.confidence_interval, {
    level: 0.95, lower_ns: 20, upper_ns: 20, lower_percent: 20, upper_percent: 20,
  });

  // alpha：regression 仅在末尾 index 1 -> 单段持续到末尾
  assert.deepEqual(Object.keys(alpha.trend_analysis),
    ['regression_runs', 'persistent_regression_start_index',
      'transient_regression_runs', 'attribution_transitions']);
  assert.deepEqual(alpha.trend_analysis.regression_runs,
    [{ start_index: 1, end_index: 1, extends_to_end: true }]);
  assert.equal(alpha.trend_analysis.persistent_regression_start_index, 1);
  assert.deepEqual(alpha.trend_analysis.transient_regression_runs, []);
  assert.deepEqual(alpha.trend_analysis.attribution_transitions, [
    { from_index: 0, to_index: 1,
      from_factor: 'none', to_factor: 'central_tendency' },
  ]);
  // 持续段只含 index 1：三项取该候选百分比，central 与 tail 平手取 central
  assert.deepEqual(alpha.case_attribution, {
    central_tendency_percent: 20,
    tail_latency_percent: 20,
    variability_percent: 0,
    dominant_factor: 'central_tendency',
  });

  assert.equal(beta.candidates[0].index, 0);
  assert.equal(beta.candidates[0].candidate, 'b-c0.json');
  assert.equal(beta.candidates[0].decision, 'improvement');
  assert.equal(beta.candidates[0].delta.mean.percent, -16.666667);
  // 退化单点区间 -20ns，百分比两端同为 -16.666667
  assert.deepEqual(beta.candidates[0].delta.mean.confidence_interval, {
    level: 0.95, lower_ns: -20, upper_ns: -20,
    lower_percent: -16.666667, upper_percent: -16.666667,
  });
  // beta：improvement 不算 regression -> 无任何段，case_attribution 四项 null
  assert.deepEqual(beta.trend_analysis, {
    regression_runs: [],
    persistent_regression_start_index: null,
    transient_regression_runs: [],
    attribution_transitions: [],
  });
  assert.deepEqual(beta.case_attribution, {
    central_tendency_percent: null,
    tail_latency_percent: null,
    variability_percent: null,
    dominant_factor: null,
  });

  // timeline_summary：alpha 持续、beta 无回归；起点按 case 序
  assert.deepEqual(Object.keys(result.timeline_summary), [
    'total_cases',
    'cases_with_persistent_regression',
    'cases_with_only_transient_regression',
    'cases_without_regression',
    'persistent_regression_start_indices',
    'suite_dominant_factor',
  ]);
  assert.deepEqual(result.timeline_summary, {
    total_cases: 2,
    cases_with_persistent_regression: 1,
    cases_with_only_transient_regression: 0,
    cases_without_regression: 1,
    persistent_regression_start_indices: [
      { name: 'alpha', start_index: 1 },
    ],
    suite_dominant_factor: 'central_tendency',
  });
});

test('暂态段恢复后再持续：兼有两类只计持续，case_attribution 只取持续段中位数', () => {
  const dir = tempDir();
  writeCollect(dir, 'base.json', [100, 100, 100]);
  writeCollect(dir, 'c0.json', [120, 120, 120]); // reg 暂态
  writeCollect(dir, 'c1.json', [100, 100, 100]); // 恢复
  writeCollect(dir, 'c2.json', [120, 120, 120]); // 持续段起点
  writeCollect(dir, 'c3.json', [130, 130, 130]);
  const manifest = writeManifest(dir, 'm.json', [
    { name: 's', baseline: 'base.json',
      candidates: ['c0.json', 'c1.json', 'c2.json', 'c3.json'] },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const c = readJson(out).cases[0];
  assert.deepEqual(c.trend_analysis.regression_runs, [
    { start_index: 0, end_index: 0, extends_to_end: false },
    { start_index: 2, end_index: 3, extends_to_end: true },
  ]);
  assert.equal(c.trend_analysis.persistent_regression_start_index, 2);
  assert.deepEqual(c.trend_analysis.transient_regression_runs, [
    { start_index: 0, end_index: 0, recovery_index: 1 },
  ]);
  // 持续段 [c2(+20%), c3(+30%)]：mean/p95 中位 25，stddev 0
  assert.deepEqual(c.case_attribution, {
    central_tendency_percent: 25,
    tail_latency_percent: 25,
    variability_percent: 0,
    dominant_factor: 'central_tendency',
  });
  const summary = readJson(out).timeline_summary;
  assert.deepEqual(summary, {
    total_cases: 1,
    cases_with_persistent_regression: 1,
    cases_with_only_transient_regression: 0,
    cases_without_regression: 0,
    persistent_regression_start_indices: [{ name: 's', start_index: 2 }],
    suite_dominant_factor: 'central_tendency',
  });
});

test('仅暂态回归：recovery_index 为段后首个 index，起点写 null，归因为 null', () => {
  const dir = tempDir();
  writeCollect(dir, 'base.json', [100, 100, 100]);
  writeCollect(dir, 'c0.json', [100, 100, 100]);
  writeCollect(dir, 'c1.json', [120, 120, 120]);
  writeCollect(dir, 'c2.json', [100, 100, 100]);
  const manifest = writeManifest(dir, 'm.json', [
    { name: 's', baseline: 'base.json',
      candidates: ['c0.json', 'c1.json', 'c2.json'] },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const c = readJson(out).cases[0];
  assert.deepEqual(c.trend_analysis, {
    regression_runs: [{ start_index: 1, end_index: 1, extends_to_end: false }],
    persistent_regression_start_index: null,
    transient_regression_runs: [
      { start_index: 1, end_index: 1, recovery_index: 2 },
    ],
    attribution_transitions: [
      { from_index: 0, to_index: 1,
        from_factor: 'none', to_factor: 'central_tendency' },
      { from_index: 1, to_index: 2,
        from_factor: 'central_tendency', to_factor: 'none' },
    ],
  });
  assert.deepEqual(c.case_attribution, {
    central_tendency_percent: null,
    tail_latency_percent: null,
    variability_percent: null,
    dominant_factor: null,
  });
  const summary = readJson(out).timeline_summary;
  assert.equal(summary.cases_with_persistent_regression, 0);
  assert.equal(summary.cases_with_only_transient_regression, 1);
  assert.equal(summary.cases_without_regression, 0);
  assert.deepEqual(summary.persistent_regression_start_indices, []);
  assert.equal(summary.suite_dominant_factor, 'none');
});

test('attribution_transitions 记录非 regression 相邻候选的 factor 变化（none 双向）', () => {
  const dir = tempDir();
  // 零方差：持平 p=1 none；+3% 显著但未达 5% -> no_material_change，
  // 归因 central_tendency；再持平。全程无 regression。
  writeCollect(dir, 'base.json', [100, 100]);
  writeCollect(dir, 'c0.json', [100, 100]);
  writeCollect(dir, 'c1.json', [103, 103]);
  writeCollect(dir, 'c2.json', [100, 100]);
  const manifest = writeManifest(dir, 'm.json', [
    { name: 's', baseline: 'base.json',
      candidates: ['c0.json', 'c1.json', 'c2.json'] },
  ]);
  const out = path.join(dir, 'out.json');
  const r = runCli(['--manifest', manifest, '--output', out]);
  assert.equal(r.status, 0, r.stderr);

  const c = readJson(out).cases[0];
  assert.deepEqual(c.candidates.map((x) => x.decision),
    ['not_significant', 'no_material_change', 'not_significant']);
  assert.deepEqual(c.trend_analysis.regression_runs, []);
  assert.equal(c.trend_analysis.persistent_regression_start_index, null);
  assert.deepEqual(c.trend_analysis.transient_regression_runs, []);
  assert.deepEqual(c.trend_analysis.attribution_transitions, [
    { from_index: 0, to_index: 1,
      from_factor: 'none', to_factor: 'central_tendency' },
    { from_index: 1, to_index: 2,
      from_factor: 'central_tendency', to_factor: 'none' },
  ]);
  const summary = readJson(out).timeline_summary;
  assert.equal(summary.cases_without_regression, 1);
  assert.equal(summary.suite_dominant_factor, 'none');
});

test('多 case：起点按 case 序，suite_dominant_factor 多数决与平手顺序', () => {
  const dir = tempDir();
  // alpha：持续，central_tendency（零方差整体平移，mean/p95 同幅平手取 central）
  writeCollect(dir, 'a-base.json', [100, 100, 100]);
  writeCollect(dir, 'a-c0.json', [120, 120, 120]);
  // beta：持续，variability 占优（基线零方差，候选出现散布 -> stddev 百分比 null=正无穷）
  writeCollect(dir, 'b-base.json', [100, 100, 100]);
  writeCollect(dir, 'b-c0.json', [120, 120, 124]);
  // gamma：无回归
  writeCollect(dir, 'g-base.json', [100, 100, 100]);
  writeCollect(dir, 'g-c0.json', [100, 100, 100]);

  const run = (cases) => {
    const m = writeManifest(dir, `m-${Math.random()}.json`, cases);
    const o = path.join(dir, `o-${Math.random()}.json`);
    const rr = runCli(['--manifest', m, '--output', o]);
    assert.equal(rr.status, 0, rr.stderr);
    return readJson(o);
  };

  const cases = [
    { name: 'alpha', baseline: 'a-base.json', candidates: ['a-c0.json'] },
    { name: 'beta', baseline: 'b-base.json', candidates: ['b-c0.json'] },
    { name: 'gamma', baseline: 'g-base.json', candidates: ['g-c0.json'] },
  ];
  const result = run(cases);
  const [alpha, beta, gamma] = result.cases;
  assert.equal(alpha.candidates[0].decision, 'regression');
  assert.equal(alpha.case_attribution.dominant_factor, 'central_tendency');
  assert.equal(beta.candidates[0].decision, 'regression');
  assert.equal(beta.case_attribution.dominant_factor, 'variability');
  assert.equal(gamma.case_attribution.dominant_factor, null);

  const summary = result.timeline_summary;
  assert.equal(summary.total_cases, 3);
  assert.equal(summary.cases_with_persistent_regression, 2);
  assert.equal(summary.cases_with_only_transient_regression, 0);
  assert.equal(summary.cases_without_regression, 1);
  assert.deepEqual(summary.persistent_regression_start_indices, [
    { name: 'alpha', start_index: 0 },
    { name: 'beta', start_index: 0 },
  ]);
  // central 与 variability 各一票平手 -> 按顺序 central_tendency
  assert.equal(summary.suite_dominant_factor, 'central_tendency');

  // variability 两票对 central 一票 -> 多数决为 variability
  const majority = run([
    cases[0], cases[1],
    { name: 'beta2', baseline: 'b-base.json', candidates: ['b-c0.json'] },
  ]);
  assert.equal(majority.timeline_summary.suite_dominant_factor, 'variability');
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
  assert.equal(g.trend_analysis.persistent_regression_start_index, null);
  assert.deepEqual(g.trend_analysis.regression_runs, []);
  assert.deepEqual(g.trend_analysis.transient_regression_runs, []);
  assert.deepEqual(g.case_attribution, {
    central_tendency_percent: null,
    tail_latency_percent: null,
    variability_percent: null,
    dominant_factor: null,
  });

  const h = result.cases[1];
  assert.equal(h.candidates[0].adjusted_p_value, globalAdjusted[3]);
  assert.equal(h.candidates[0].adjusted_p_value, 0);
  assert.equal(h.candidates[0].decision, 'regression');
  assert.deepEqual(h.trend_analysis.regression_runs,
    [{ start_index: 0, end_index: 0, extends_to_end: true }]);
  assert.equal(h.trend_analysis.persistent_regression_start_index, 0);

  assert.deepEqual(result.timeline_summary, {
    total_cases: 2,
    cases_with_persistent_regression: 1,
    cases_with_only_transient_regression: 0,
    cases_without_regression: 1,
    persistent_regression_start_indices: [{ name: 'h', start_index: 0 }],
    suite_dominant_factor: 'central_tendency',
  });
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
  assert.deepEqual(result.timeline_summary.persistent_regression_start_indices, [
    { name: 'a', start_index: 0 },
    { name: 'b', start_index: 0 },
  ]);
  assert.equal(result.timeline_summary.total_cases, 2);
  assert.equal(result.timeline_summary.cases_with_persistent_regression, 2);
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
  const res1 = readJson(out1);
  assert.equal(res1.cases[0].candidates[0].decision, 'no_material_change');
  assert.equal(res1.cases[0].trend_analysis.persistent_regression_start_index, null);
  assert.deepEqual(res1.cases[0].trend_analysis.regression_runs, []);

  const out2 = path.join(dir, 'out2.json');
  const r2 = runCli(['--manifest', manifest, '--output', out2,
    '--min-change-percent=2']);
  assert.equal(r2.status, 0, r2.stderr);
  const res2 = readJson(out2);
  assert.equal(res2.cases[0].candidates[0].decision, 'regression');
  assert.deepEqual(res2.cases[0].trend_analysis.regression_runs,
    [{ start_index: 0, end_index: 0, extends_to_end: true }]);
  assert.equal(res2.cases[0].trend_analysis.persistent_regression_start_index, 0);
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
  assert.equal('timeline_summary' in result, false);
  assert.equal('trend_analysis' in result.cases[0], false);
});
