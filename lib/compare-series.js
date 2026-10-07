'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { computeSummary } = require('./stats');
const { parseArgs, EXIT_OK, EXIT_USAGE, EXIT_OUTPUT_ERROR } = require('./collect');
const {
  loadInput,
  buildCompareResult,
  decide,
  parseNumberOption,
  DEFAULT_ALPHA,
  DEFAULT_MIN_CHANGE_PERCENT,
} = require('./compare');
const {
  benjaminiHochberg,
  medianPercent,
  dominantFactor,
} = require('./compare-suite');

const KNOWN_KEYS = new Set(['manifest', 'output', 'alpha', 'min-change-percent']);

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// 读取并校验 compare-series manifest：UTF-8 JSON 对象，cases 为非空数组；
// 每项 name 非空且唯一，baseline 非空，candidates 非空有序（非空字符串数组）。
// 相对路径按 manifest 所在目录解析；candidate 原始路径串保留用于输出回显。
// 返回 { cases } 或 { error }。
async function loadManifest(manifestPath) {
  let text;
  try {
    text = await fs.readFile(manifestPath, 'utf8');
  } catch (err) {
    return { error: `无法读取 manifest 文件 ${manifestPath}: ${err.message}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { error: `manifest 文件不是合法 JSON: ${manifestPath}` };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { error: 'manifest 结构无效: 顶层须为对象' };
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    return { error: 'manifest cases 必须为非空数组' };
  }

  const manifestDir = path.dirname(path.resolve(manifestPath));
  const cases = [];
  const names = new Set();
  for (let i = 0; i < manifest.cases.length; i++) {
    const item = manifest.cases[i];
    const where = `manifest cases[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `${where} 必须为对象` };
    }
    if (typeof item.name !== 'string' || item.name === '') {
      return { error: `${where} 的 name 必须为非空字符串` };
    }
    if (names.has(item.name)) {
      return { error: `manifest cases 中 name 重复: ${item.name}` };
    }
    if (typeof item.baseline !== 'string' || item.baseline === '') {
      return { error: `${where} (${item.name}) 的 baseline 必须为非空字符串` };
    }
    if (!Array.isArray(item.candidates) || item.candidates.length === 0) {
      return { error: `${where} (${item.name}) 的 candidates 必须为非空数组` };
    }
    const candidates = [];
    for (let j = 0; j < item.candidates.length; j++) {
      const cp = item.candidates[j];
      if (typeof cp !== 'string' || cp === '') {
        return { error: `${where} (${item.name}) 的 candidates[${j}] 必须为非空字符串` };
      }
      candidates.push({ ref: cp, path: path.resolve(manifestDir, cp) });
    }
    names.add(item.name);
    cases.push({
      name: item.name,
      baselineRef: item.baseline,
      baselinePath: path.resolve(manifestDir, item.baseline),
      candidates,
    });
  }
  return { cases };
}

// 单 case 的趋势分析：基于候选序列的 decision 与 attribution.dominant_factor。
// regression_runs 为连续 regression 的最大段，依次含 start_index、end_index、
// extends_to_end（end_index 是否为序列最后一个 index）；
// extends_to_end 的段为持续段（至多一个），其 start_index 写入
// persistent_regression_start_index，否则为 null；其余段为暂态段，写入
// transient_regression_runs 并附 recovery_index（段后首个 index，即 end_index + 1）。
// attribution_transitions 列相邻候选 dominant_factor 的变化（含 none 双向）。
// case_attribution 仅在有持续段时取该段各候选归因百分比的中位数
// （null 按正无穷，正无穷中位数写 null），dominant_factor 平手按
// central_tendency / tail_latency / variability 顺序、无正值为 none；
// 无持续段时四项均为 null。
function buildTrendAnalysis(candidateReports) {
  const lastIndex = candidateReports.length - 1;
  const regressionRuns = [];
  let runStart = null;
  for (let i = 0; i < candidateReports.length; i++) {
    if (candidateReports[i].decision === 'regression') {
      if (runStart === null) {
        runStart = i;
      }
    } else if (runStart !== null) {
      regressionRuns.push({
        start_index: runStart,
        end_index: i - 1,
        extends_to_end: i - 1 === lastIndex,
      });
      runStart = null;
    }
  }
  if (runStart !== null) {
    regressionRuns.push({
      start_index: runStart,
      end_index: lastIndex,
      extends_to_end: true,
    });
  }

  const persistentRun = regressionRuns.find((r) => r.extends_to_end) || null;
  const transientRuns = regressionRuns
    .filter((r) => !r.extends_to_end)
    .map((r) => ({
      start_index: r.start_index,
      end_index: r.end_index,
      recovery_index: r.end_index + 1,
    }));

  const transitions = [];
  for (let i = 0; i + 1 < candidateReports.length; i++) {
    const fromFactor = candidateReports[i].attribution.dominant_factor;
    const toFactor = candidateReports[i + 1].attribution.dominant_factor;
    if (fromFactor !== toFactor) {
      transitions.push({
        from_index: i,
        to_index: i + 1,
        from_factor: fromFactor,
        to_factor: toFactor,
      });
    }
  }

  let caseAttribution;
  if (persistentRun) {
    const segment = candidateReports.slice(
      persistentRun.start_index, persistentRun.end_index + 1);
    caseAttribution = {
      central_tendency_percent: medianPercent(
        segment.map((c) => c.attribution.central_tendency_percent)),
      tail_latency_percent: medianPercent(
        segment.map((c) => c.attribution.tail_latency_percent)),
      variability_percent: medianPercent(
        segment.map((c) => c.attribution.variability_percent)),
    };
    caseAttribution.dominant_factor = dominantFactor(
      caseAttribution.central_tendency_percent,
      caseAttribution.tail_latency_percent,
      caseAttribution.variability_percent);
  } else {
    caseAttribution = {
      central_tendency_percent: null,
      tail_latency_percent: null,
      variability_percent: null,
      dominant_factor: null,
    };
  }

  return {
    regression_runs: regressionRuns,
    persistent_regression_start_index: persistentRun ? persistentRun.start_index : null,
    transient_regression_runs: transientRuns,
    attribution_transitions: transitions,
    case_attribution: caseAttribution,
  };
}

// 套件级时间线汇总：计数分持续、仅暂态、无回归三类（兼有持续与暂态的 case
// 只计入持续）；persistent_regression_start_indices 按 case 序列出持续段起点；
// suite_dominant_factor 取各 case 非 null dominant_factor 中频次最高者，
// 平手按 central_tendency / tail_latency / variability / none 顺序，无值为 none。
function buildTimelineSummary(caseReports) {
  let persistent = 0;
  let onlyTransient = 0;
  let withoutRegression = 0;
  const startIndices = [];
  const factorCounts = new Map();
  for (const c of caseReports) {
    const trend = c.trend_analysis;
    if (trend.persistent_regression_start_index !== null) {
      persistent += 1;
      startIndices.push({
        name: c.name,
        start_index: trend.persistent_regression_start_index,
      });
    } else if (trend.regression_runs.length > 0) {
      onlyTransient += 1;
    } else {
      withoutRegression += 1;
    }
    const factor = trend.case_attribution.dominant_factor;
    if (factor !== null) {
      factorCounts.set(factor, (factorCounts.get(factor) || 0) + 1);
    }
  }
  let suiteDominantFactor = 'none';
  let bestCount = 0;
  for (const factor of ['central_tendency', 'tail_latency', 'variability', 'none']) {
    const count = factorCounts.get(factor) || 0;
    if (count > bestCount) {
      bestCount = count;
      suiteDominantFactor = factor;
    }
  }
  return {
    total_cases: caseReports.length,
    cases_with_persistent_regression: persistent,
    cases_with_only_transient_regression: onlyTransient,
    cases_without_regression: withoutRegression,
    persistent_regression_start_indices: startIndices,
    suite_dominant_factor: suiteDominantFactor,
  };
}

async function compareSeries(tokens) {
  const { values, error: parseError } = parseArgs(tokens, KNOWN_KEYS);
  if (parseError) {
    return fail(parseError);
  }

  const manifestPath = values.manifest;
  const output = values.output;
  if (manifestPath === undefined || manifestPath === '') {
    return fail('--manifest 不能为空');
  }
  if (output === undefined || output === '') {
    return fail('--output 不能为空');
  }

  const alphaR = parseNumberOption(values, 'alpha', {
    defaultValue: DEFAULT_ALPHA,
    check: (v) => v > 0 && v < 1,
    describe: '满足 0 < alpha < 1',
  });
  if (alphaR.error) {
    return fail(alphaR.error);
  }
  const minChangeR = parseNumberOption(values, 'min-change-percent', {
    defaultValue: DEFAULT_MIN_CHANGE_PERCENT,
    check: (v) => v >= 0,
    describe: '为不小于 0 的数',
  });
  if (minChangeR.error) {
    return fail(minChangeR.error);
  }
  const alpha = alphaR.value;
  const minChangePercent = minChangeR.value;

  // 全部校验通过后才写 output：manifest 校验与 baseline/每个候选的加载/校验先行。
  const manifestR = await loadManifest(manifestPath);
  if (manifestR.error) {
    return fail(manifestR.error);
  }

  // 按 cases 顺序加载：每 case 先 baseline 再按 candidates 顺序逐个加载校验；
  // case 内 command 一致、样本沿用 compare 口径（每侧至少 2 个有效样本）。
  const loaded = [];
  for (const c of manifestR.cases) {
    const baseline = await loadInput(c.baselinePath, `case "${c.name}" 的 baseline`);
    if (baseline.error) {
      return fail(baseline.error);
    }
    const candidateInputs = [];
    for (let j = 0; j < c.candidates.length; j++) {
      const candidate = await loadInput(
        c.candidates[j].path, `case "${c.name}" 的 candidates[${j}]`);
      if (candidate.error) {
        return fail(candidate.error);
      }
      if (candidate.command !== baseline.command) {
        return fail(`case "${c.name}" candidates[${j}] 与 baseline 的 command 不一致`);
      }
      candidateInputs.push(candidate);
    }
    loaded.push({ spec: c, baseline, candidateInputs });
  }

  // 按 compare 口径重算每个 case 的每个候选；全部候选的原始 p 值汇总后
  // 统一做一次 BH 校正（跨所有 case）。
  const slots = [];
  for (const entry of loaded) {
    for (let index = 0; index < entry.candidateInputs.length; index++) {
      const result = buildCompareResult(
        entry.baseline, entry.candidateInputs[index], alpha);
      slots.push({ caseName: entry.spec.name, index, result });
    }
  }
  const adjusted = benjaminiHochberg(slots.map((s) => s.result.welch.p_value));

  const counts = {
    regression: 0,
    improvement: 0,
    no_material_change: 0,
    not_significant: 0,
  };
  // 每 case 的候选按 index 顺序生成报告项，cursor 对应全局 BH 校正序号。
  let cursor = 0;
  const caseReports = loaded.map((entry) => {
    const baselineSummary = computeSummary(entry.baseline.durations);
    const candidateReports = entry.candidateInputs.map((_, index) => {
      const c = slots[cursor].result;
      const adjustedPValue = adjusted[cursor];
      cursor += 1;
      const decision = decide(adjustedPValue, alpha, c.delta.mean.percent, minChangePercent);
      counts[decision] += 1;
      return {
        candidate: entry.spec.candidates[index].ref,
        index,
        baseline_summary: c.baselineSummary,
        candidate_summary: c.candidateSummary,
        delta: c.delta,
        welch: c.welch,
        adjusted_p_value: adjustedPValue,
        decision,
        attribution: c.attribution,
      };
    });

    // first_regression_index：候选序列中首个 decision 为 regression 的 index，否则 null。
    let firstRegressionIndex = null;
    for (const cr of candidateReports) {
      if (cr.decision === 'regression') {
        firstRegressionIndex = cr.index;
        break;
      }
    }

    return {
      name: entry.spec.name,
      command: entry.baseline.command,
      baseline_summary: baselineSummary,
      candidates: candidateReports,
      first_regression_index: firstRegressionIndex,
      trend_analysis: buildTrendAnalysis(candidateReports),
    };
  });

  // 优先级：regression > improvement > no_material_change > not_significant
  const suiteDecision = counts.regression > 0 ? 'regression'
    : counts.improvement > 0 ? 'improvement'
      : counts.no_material_change > 0 ? 'no_material_change'
        : 'not_significant';

  // suite_attribution 聚合全部候选（跨所有 case），规则沿用 compare-suite：
  // 各候选对应归因百分比的中位数（null 按正无穷，正无穷中位数写 null），
  // dominant_factor 取三个中位数中的最大正值，平手按顺序，无正值为 none。
  const allCandidates = caseReports.flatMap((c) => c.candidates);
  const suiteAttribution = {
    central_tendency_percent: medianPercent(
      allCandidates.map((c) => c.attribution.central_tendency_percent)),
    tail_latency_percent: medianPercent(
      allCandidates.map((c) => c.attribution.tail_latency_percent)),
    variability_percent: medianPercent(
      allCandidates.map((c) => c.attribution.variability_percent)),
  };
  suiteAttribution.dominant_factor = dominantFactor(
    suiteAttribution.central_tendency_percent,
    suiteAttribution.tail_latency_percent,
    suiteAttribution.variability_percent);

  const suiteSummary = {
    total_cases: caseReports.length,
    total_candidates: allCandidates.length,
    regression: counts.regression,
    improvement: counts.improvement,
    no_material_change: counts.no_material_change,
    not_significant: counts.not_significant,
    suite_decision: suiteDecision,
  };

  const result = {
    cases: caseReports,
    suite_summary: suiteSummary,
    suite_attribution: suiteAttribution,
    timeline_summary: buildTimelineSummary(caseReports),
  };

  let payload;
  try {
    payload = JSON.stringify(result, null, 2) + '\n';
  } catch (err) {
    process.stderr.write(`perf-regress: 结果序列化失败: ${err.message}\n`);
    return EXIT_OUTPUT_ERROR;
  }

  try {
    await fs.writeFile(output, payload, 'utf8');
  } catch (err) {
    process.stderr.write(`perf-regress: 无法写入 --output ${output}: ${err.message}\n`);
    return EXIT_OUTPUT_ERROR;
  }

  return EXIT_OK;
}

module.exports = {
  compareSeries,
  loadManifest,
  buildTrendAnalysis,
  buildTimelineSummary,
};
