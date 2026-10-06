'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { EXIT_OK, EXIT_USAGE, EXIT_OUTPUT_ERROR, parseArgs } = require('./collect');
const {
  loadInput,
  buildCompareResult,
  decide,
  parseNumberOption,
  DEFAULT_ALPHA,
  DEFAULT_MIN_CHANGE_PERCENT,
} = require('./compare');
const { benjaminiHochberg, medianPercent, dominantFactor } = require('./compare-suite');

const KNOWN_KEYS = new Set(['manifest', 'output', 'alpha', 'min-change-percent']);

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// 读取并校验 series manifest：UTF-8 JSON 对象，cases 为非空数组；
// 每项 name 非空且唯一，baseline 非空，candidates 为非空有序数组（元素非空字符串）。
// 相对路径按 manifest 所在目录解析。返回 { cases } 或 { error }。
async function loadSeriesManifest(manifestPath) {
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
    const label = `manifest cases[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `${label} 必须为对象` };
    }
    if (typeof item.name !== 'string' || item.name === '') {
      return { error: `${label} 的 name 必须为非空字符串` };
    }
    if (names.has(item.name)) {
      return { error: `manifest cases 中 name 重复: ${item.name}` };
    }
    if (typeof item.baseline !== 'string' || item.baseline === '') {
      return { error: `${label} (${item.name}) 的 baseline 必须为非空字符串` };
    }
    if (!Array.isArray(item.candidates) || item.candidates.length === 0) {
      return { error: `${label} (${item.name}) 的 candidates 必须为非空数组` };
    }
    const candidatePaths = [];
    for (let j = 0; j < item.candidates.length; j++) {
      const candidate = item.candidates[j];
      if (typeof candidate !== 'string' || candidate === '') {
        return { error: `${label} (${item.name}) candidates[${j}] 必须为非空字符串` };
      }
      candidatePaths.push(path.resolve(manifestDir, candidate));
    }
    names.add(item.name);
    cases.push({
      name: item.name,
      baselinePath: path.resolve(manifestDir, item.baseline),
      candidatePaths,
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

  // 全部校验通过后才写 output：manifest 校验与每份输入的加载/校验先行。
  const manifestR = await loadSeriesManifest(manifestPath);
  if (manifestR.error) {
    return fail(manifestR.error);
  }

  // loaded：每个 case 含 baseline 与按序排列的 candidates；同时拍平全部候选，
  // 供跨 case 的统一 BH 校正使用。
  const loaded = [];
  const flatComparisons = [];
  for (const c of manifestR.cases) {
    const baseline = await loadInput(c.baselinePath, `case "${c.name}" 的 baseline`);
    if (baseline.error) {
      return fail(baseline.error);
    }
    const candidates = [];
    for (let j = 0; j < c.candidatePaths.length; j++) {
      const candidatePath = c.candidatePaths[j];
      const candidate = await loadInput(
        candidatePath, `case "${c.name}" 的 candidates[${j}]`);
      if (candidate.error) {
        return fail(candidate.error);
      }
      if (baseline.command !== candidate.command) {
        return fail(`case "${c.name}" candidates[${j}] 与 baseline 的 command 不一致`);
      }
      const result = buildCompareResult(baseline, candidate);
      candidates.push(result);
      flatComparisons.push({ caseName: c.name, index: j, ...result });
    }
    loaded.push({ name: c.name, command: baseline.command, candidates });
  }

  // 原始 p 值跨所有 case 的全部候选统一做 BH 校正。
  const adjusted = benjaminiHochberg(flatComparisons.map((c) => c.welch.p_value));

  const counts = {
    regression: 0,
    improvement: 0,
    no_material_change: 0,
    not_significant: 0,
  };
  let flatCursor = 0;
  const caseResults = loaded.map((entry) => {
    let firstRegressionIndex = null;
    const candidateResults = entry.candidates.map((c, j) => {
      const adjustedPValue = adjusted[flatCursor++];
      const decision = decide(adjustedPValue, alpha, c.delta.mean.percent, minChangePercent);
      counts[decision] += 1;
      if (decision === 'regression' && firstRegressionIndex === null) {
        firstRegressionIndex = j;
      }
      return {
        candidate: c.candidateSummary,
        index: j,
        delta: c.delta,
        welch: c.welch,
        adjusted_p_value: adjustedPValue,
        decision,
        attribution: c.attribution,
      };
    });
    return {
      name: entry.name,
      command: entry.command,
      baseline_summary: entry.candidates[0].baselineSummary,
      candidates: candidateResults,
      first_regression_index: firstRegressionIndex,
    };
  });

  // 优先级：regression > improvement > no_material_change > not_significant
  const suiteDecision = counts.regression > 0 ? 'regression'
    : counts.improvement > 0 ? 'improvement'
      : counts.no_material_change > 0 ? 'no_material_change'
        : 'not_significant';

  const totalCandidates = flatComparisons.length;
  const suiteSummary = {
    total_cases: caseResults.length,
    total_candidates: totalCandidates,
    regression: counts.regression,
    improvement: counts.improvement,
    no_material_change: counts.no_material_change,
    not_significant: counts.not_significant,
    suite_decision: suiteDecision,
  };

  // suite 归因聚合全部候选（不区分 case），口径与 compare-suite 一致。
  const suiteAttribution = {
    central_tendency_percent: medianPercent(
      flatComparisons.map((c) => c.attribution.central_tendency_percent)),
    tail_latency_percent: medianPercent(
      flatComparisons.map((c) => c.attribution.tail_latency_percent)),
    variability_percent: medianPercent(
      flatComparisons.map((c) => c.attribution.variability_percent)),
  };
  suiteAttribution.dominant_factor = dominantFactor(
    suiteAttribution.central_tendency_percent,
    suiteAttribution.tail_latency_percent,
    suiteAttribution.variability_percent);

  const result = {
    cases: caseResults,
    suite_summary: suiteSummary,
    suite_attribution: suiteAttribution,
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
  loadSeriesManifest,
};
