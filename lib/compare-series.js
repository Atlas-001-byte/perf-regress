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

// 对一条候选 decision 序列切分连续 regression 段。
// regression_runs：每个连续段含 start_index、end_index、extends_to_end
// （段末为序列最后一个候选时为 true，每 case 至多一段）。
// persistent_regression_start_index：仅 extends_to_end 段的起点，否则 null。
// 其余段进 transient_regression_runs，recovery_index 为段后首个候选 index
// （即 end_index + 1）。
function analyzeTrend(decisions) {
  const regressionRuns = [];
  let i = 0;
  while (i < decisions.length) {
    if (decisions[i] !== 'regression') {
      i += 1;
      continue;
    }
    const startIndex = i;
    let endIndex = i;
    while (endIndex + 1 < decisions.length && decisions[endIndex + 1] === 'regression') {
      endIndex += 1;
    }
    regressionRuns.push({
      start_index: startIndex,
      end_index: endIndex,
      extends_to_end: endIndex === decisions.length - 1,
    });
    i = endIndex + 1;
  }

  const transientRuns = [];
  let persistentStart = null;
  for (const run of regressionRuns) {
    if (run.extends_to_end) {
      persistentStart = run.start_index;
    } else {
      transientRuns.push({
        start_index: run.start_index,
        end_index: run.end_index,
        recovery_index: run.end_index + 1,
      });
    }
  }
  return { regressionRuns, transientRuns, persistentStart };
}

// 相邻候选的 dominant_factor 变化点（含与 none 之间的双向变化），无变化时为 []。
function attributionTransitions(candidateReports) {
  const transitions = [];
  for (let k = 1; k < candidateReports.length; k++) {
    const fromFactor = candidateReports[k - 1].attribution.dominant_factor;
    const toFactor = candidateReports[k].attribution.dominant_factor;
    if (fromFactor !== toFactor) {
      transitions.push({
        from_index: k - 1,
        to_index: k,
        from_factor: fromFactor,
        to_factor: toFactor,
      });
    }
  }
  return transitions;
}

// 持续段（extends_to_end 的 regression 段）case 归因：三项百分比取段内候选
// 归因百分比的中位数（中位数口径同 compare-suite），dominant_factor 平手按
// central_tendency、tail_latency、variability、none；无持续段时四项均为 null。
function caseAttribution(candidateReports, persistentStart) {
  if (persistentStart === null) {
    return {
      central_tendency_percent: null,
      tail_latency_percent: null,
      variability_percent: null,
      dominant_factor: null,
    };
  }
  const segment = candidateReports.slice(persistentStart);
  const central = medianPercent(
    segment.map((c) => c.attribution.central_tendency_percent));
  const tail = medianPercent(
    segment.map((c) => c.attribution.tail_latency_percent));
  const variability = medianPercent(
    segment.map((c) => c.attribution.variability_percent));
  return {
    central_tendency_percent: central,
    tail_latency_percent: tail,
    variability_percent: variability,
    dominant_factor: dominantFactor(central, tail, variability),
  };
}

// 套件级 dominant_factor：只统计非 null 的 case 级 dominant_factor（含 none），
// 取出现最多者；平手按 central_tendency、tail_latency、variability、none；
// 没有任何非 null 值（全部 case 无持续段）时为 none。
function suiteDominantFactor(caseReports) {
  const order = ['central_tendency', 'tail_latency', 'variability', 'none'];
  const tally = new Map(order.map((f) => [f, 0]));
  let hasValue = false;
  for (const c of caseReports) {
    const factor = c.case_attribution.dominant_factor;
    if (factor !== null) {
      tally.set(factor, tally.get(factor) + 1);
      hasValue = true;
    }
  }
  if (!hasValue) {
    return 'none';
  }
  let best = order[0];
  for (const f of order) {
    if (tally.get(f) > tally.get(best)) {
      best = f;
    }
  }
  return best;
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
    persistent: 0,
    transientOnly: 0,
    none: 0,
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

    const {
      regressionRuns, transientRuns, persistentStart,
    } = analyzeTrend(candidateReports.map((c) => c.decision));
    if (persistentStart !== null) {
      counts.persistent += 1;
    } else if (transientRuns.length > 0) {
      counts.transientOnly += 1;
    } else {
      counts.none += 1;
    }

    const trendAnalysis = {
      regression_runs: regressionRuns,
      persistent_regression_start_index: persistentStart,
      transient_regression_runs: transientRuns,
      attribution_transitions: attributionTransitions(candidateReports),
    };

    return {
      name: entry.spec.name,
      command: entry.baseline.command,
      baseline_summary: baselineSummary,
      candidates: candidateReports,
      trend_analysis: trendAnalysis,
      case_attribution: caseAttribution(candidateReports, persistentStart),
    };
  });

  // timeline_summary：cases 计数为持续、仅暂态、无回归（兼有暂态与持续的 case
  // 只计持续）；persistent_regression_start_indices 按 case 序只列持续段起点；
  // suite_dominant_factor 看各 case 非 null 的 dominant_factor 取最多者。
  const timelineSummary = {
    total_cases: caseReports.length,
    cases_with_persistent_regression: counts.persistent,
    cases_with_only_transient_regression: counts.transientOnly,
    cases_without_regression: counts.none,
    persistent_regression_start_indices: caseReports
      .filter((c) => c.trend_analysis.persistent_regression_start_index !== null)
      .map((c) => ({
        name: c.name,
        start_index: c.trend_analysis.persistent_regression_start_index,
      })),
    suite_dominant_factor: suiteDominantFactor(caseReports),
  };

  const result = {
    cases: caseReports,
    timeline_summary: timelineSummary,
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
  analyzeTrend,
  attributionTransitions,
  caseAttribution,
  suiteDominantFactor,
};
