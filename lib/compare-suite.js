'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { round6 } = require('./stats');
const { parseArgs, EXIT_OK, EXIT_USAGE, EXIT_OUTPUT_ERROR } = require('./collect');
const {
  loadInput,
  parseNumberOption,
  computeComparison,
  decideFromPValue,
  buildAttribution,
  DEFAULT_ALPHA,
  DEFAULT_MIN_CHANGE_PERCENT,
} = require('./compare');

const KNOWN_KEYS = new Set(['manifest', 'output', 'alpha', 'min-change-percent']);

const DECISION_ORDER = ['regression', 'improvement', 'no_material_change', 'not_significant'];

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// Benjamini-Hochberg 校正：m 个 p_value 升序后
// q_(i) = min(1, min over j>=i (m * p_(j) / j))，映回原序，保留六位小数。
function adjustPValues(pValues) {
  const m = pValues.length;
  const order = pValues.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const adjusted = new Array(m);
  let best = 1;
  for (let rank = m; rank >= 1; rank--) {
    const [p, index] = order[rank - 1];
    best = Math.min(best, (m * p) / rank, 1);
    adjusted[index] = round6(best);
  }
  return adjusted;
}

// 中位数；调用方已将 null 映射为 Infinity。
function medianOf(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// 套件归因：对 compare 三个百分比字段逐字段取各 case 的中位数
// （null 按正无穷参与比较，中位数为正无穷时写回 null），
// dominant_factor 沿用 compare 归因口径。
function buildSuiteAttribution(cases) {
  const medianPercent = {};
  for (const key of ['central_tendency_percent', 'tail_latency_percent', 'variability_percent']) {
    const values = cases.map((c) => {
      const v = c.attribution[key];
      return v === null ? Infinity : v;
    });
    const median = medianOf(values);
    medianPercent[key] = median === Infinity ? null : round6(median);
  }
  return buildAttribution({
    mean: { percent: medianPercent.central_tendency_percent },
    p95: { percent: medianPercent.tail_latency_percent },
    stddev: { percent: medianPercent.variability_percent },
  });
}

// 读取并校验 manifest，返回 { caseDefs } 或 { error }。
// caseDefs 每项含 name 与已按 manifest 目录解析的绝对路径。
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
    return { error: 'manifest 的 cases 须为非空数组' };
  }
  const manifestDir = path.dirname(manifestPath);
  const seen = new Set();
  const caseDefs = [];
  for (let i = 0; i < manifest.cases.length; i++) {
    const c = manifest.cases[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      return { error: `manifest cases[${i}] 须为对象` };
    }
    if (typeof c.name !== 'string' || c.name === '') {
      return { error: `manifest cases[${i}] 的 name 须为非空字符串` };
    }
    if (seen.has(c.name)) {
      return { error: `manifest case 名称重复: ${c.name}` };
    }
    seen.add(c.name);
    if (typeof c.baseline !== 'string' || c.baseline === '') {
      return { error: `manifest case ${c.name} 的 baseline 须为非空字符串` };
    }
    if (typeof c.candidate !== 'string' || c.candidate === '') {
      return { error: `manifest case ${c.name} 的 candidate 须为非空字符串` };
    }
    caseDefs.push({
      name: c.name,
      baseline: path.resolve(manifestDir, c.baseline),
      candidate: path.resolve(manifestDir, c.candidate),
    });
  }
  return { caseDefs };
}

async function compareSuite(tokens) {
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

  const manifestR = await loadManifest(manifestPath);
  if (manifestR.error) {
    return fail(manifestR.error);
  }

  // 逐 case 校验输入（口径同 compare），全部通过后才计算与写输出。
  const loaded = [];
  for (const def of manifestR.caseDefs) {
    const baseline = await loadInput(def.baseline, `case ${def.name} 的 baseline`);
    if (baseline.error) {
      return fail(baseline.error);
    }
    const candidate = await loadInput(def.candidate, `case ${def.name} 的 candidate`);
    if (candidate.error) {
      return fail(candidate.error);
    }
    if (baseline.command !== candidate.command) {
      return fail(`case ${def.name} 的两份输入 command 不一致`);
    }
    loaded.push({ def, baseline, candidate });
  }

  const comparisons = loaded.map(({ baseline, candidate }) =>
    computeComparison(baseline, candidate, alpha, minChangePercent));
  const adjusted = adjustPValues(comparisons.map((c) => c.welch.p_value));

  const cases = loaded.map(({ def, baseline }, i) => {
    const comparison = comparisons[i];
    const adjustedP = adjusted[i];
    return {
      name: def.name,
      command: baseline.command,
      ...comparison,
      decision: decideFromPValue(adjustedP, alpha, comparison.delta.mean.percent, minChangePercent),
      adjusted_p_value: adjustedP,
    };
  });

  const counts = { regression: 0, improvement: 0, no_material_change: 0, not_significant: 0 };
  for (const c of cases) {
    counts[c.decision] += 1;
  }
  let suiteDecision = 'not_significant';
  for (const d of DECISION_ORDER) {
    if (counts[d] > 0) {
      suiteDecision = d;
      break;
    }
  }
  const suiteSummary = { total: cases.length, ...counts, suite_decision: suiteDecision };

  const result = {
    cases,
    suite_summary: suiteSummary,
    suite_attribution: buildSuiteAttribution(cases),
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

module.exports = { compareSuite };
