'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { round6 } = require('./stats');
const { parseArgs, EXIT_OK, EXIT_USAGE, EXIT_OUTPUT_ERROR } = require('./collect');
const {
  loadInput,
  buildCompareResult,
  decide,
  parseNumberOption,
  DEFAULT_ALPHA,
  DEFAULT_MIN_CHANGE_PERCENT,
} = require('./compare');

const KNOWN_KEYS = new Set(['manifest', 'output', 'alpha', 'min-change-percent']);

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// Benjamini–Hochberg 校正：m 个 p 值升序后记 p_(1)<=...<=p_(m)，
// q_(i) = min(1, min over j>=i (m*p_(j)/j))，再映回原序，保留六位小数。
function benjaminiHochberg(pValues) {
  const m = pValues.length;
  const order = Array.from({ length: m }, (_, i) => i)
    .sort((a, b) => pValues[a] - pValues[b]);
  const adjusted = new Array(m);
  let running = 1;
  // 从最大秩向最小秩扫描，累积 min
  for (let rank = m; rank >= 1; rank--) {
    const index = order[rank - 1];
    running = Math.min(running, (m * pValues[index]) / rank);
    adjusted[index] = round6(Math.min(1, running));
  }
  return adjusted;
}

// 多项归因百分比的中位数：null 按正无穷参与比较；结果为正无穷时写回 null。
function medianPercent(values) {
  const sorted = values
    .map((v) => (v === null ? Infinity : v))
    .sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  const median = n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return median === Infinity ? null : round6(median);
}

// suite 归因的 dominant_factor，口径与 compare 相同：
// central_tendency > tail_latency > variability，取最大正值，无正值为 none。
function dominantFactor(central, tail, variability) {
  const entries = [
    ['central_tendency', central],
    ['tail_latency', tail],
    ['variability', variability],
  ];
  let dominant = null;
  let best = 0;
  for (const [name, percent] of entries) {
    const effective = percent === null ? Infinity : percent;
    if (effective > 0 && effective > best) {
      best = effective;
      dominant = name;
    }
  }
  return dominant === null ? 'none' : dominant;
}

// 读取并校验 manifest：UTF-8 JSON 对象，cases 为非空数组；
// 每项 name 非空且唯一，baseline/candidate 非空。
// 相对路径按 manifest 所在目录解析。返回 { manifestDir, cases } 或 { error }。
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
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `manifest cases[${i}] 必须为对象` };
    }
    if (typeof item.name !== 'string' || item.name === '') {
      return { error: `manifest cases[${i}] 的 name 必须为非空字符串` };
    }
    if (names.has(item.name)) {
      return { error: `manifest cases 中 name 重复: ${item.name}` };
    }
    if (typeof item.baseline !== 'string' || item.baseline === '') {
      return { error: `manifest cases[${i}] (${item.name}) 的 baseline 必须为非空字符串` };
    }
    if (typeof item.candidate !== 'string' || item.candidate === '') {
      return { error: `manifest cases[${i}] (${item.name}) 的 candidate 必须为非空字符串` };
    }
    names.add(item.name);
    cases.push({
      name: item.name,
      baselinePath: path.resolve(manifestDir, item.baseline),
      candidatePath: path.resolve(manifestDir, item.candidate),
    });
  }
  return { manifestDir, cases };
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

  // 全部校验通过后才写 output：manifest 校验与每对输入的加载/校验先行。
  const manifestR = await loadManifest(manifestPath);
  if (manifestR.error) {
    return fail(manifestR.error);
  }

  const loaded = [];
  for (const c of manifestR.cases) {
    const baseline = await loadInput(c.baselinePath, `case "${c.name}" 的 baseline`);
    if (baseline.error) {
      return fail(baseline.error);
    }
    const candidate = await loadInput(c.candidatePath, `case "${c.name}" 的 candidate`);
    if (candidate.error) {
      return fail(candidate.error);
    }
    if (baseline.command !== candidate.command) {
      return fail(`case "${c.name}" 两份输入的 command 不一致`);
    }
    loaded.push({ name: c.name, command: baseline.command, baseline, candidate });
  }

  // 按 compare 口径重算每个 case，并汇总原始 p 值做 BH 校正。
  const computed = loaded.map((entry) => {
    const result = buildCompareResult(entry.baseline, entry.candidate);
    return { name: entry.name, command: entry.command, ...result };
  });
  const adjusted = benjaminiHochberg(computed.map((c) => c.welch.p_value));

  const counts = {
    regression: 0,
    improvement: 0,
    no_material_change: 0,
    not_significant: 0,
  };
  const caseResults = computed.map((c, i) => {
    const adjustedPValue = adjusted[i];
    const decision = decide(adjustedPValue, alpha, c.delta.mean.percent, minChangePercent);
    counts[decision] += 1;
    return {
      name: c.name,
      command: c.command,
      baseline_summary: c.baselineSummary,
      candidate_summary: c.candidateSummary,
      delta: c.delta,
      welch: c.welch,
      adjusted_p_value: adjustedPValue,
      decision,
      attribution: c.attribution,
    };
  });

  // 优先级：regression > improvement > no_material_change > not_significant
  const suiteDecision = counts.regression > 0 ? 'regression'
    : counts.improvement > 0 ? 'improvement'
      : counts.no_material_change > 0 ? 'no_material_change'
        : 'not_significant';

  const suiteSummary = {
    total: caseResults.length,
    regression: counts.regression,
    improvement: counts.improvement,
    no_material_change: counts.no_material_change,
    not_significant: counts.not_significant,
    suite_decision: suiteDecision,
  };

  const suiteAttribution = {
    central_tendency_percent: medianPercent(
      caseResults.map((c) => c.attribution.central_tendency_percent)),
    tail_latency_percent: medianPercent(
      caseResults.map((c) => c.attribution.tail_latency_percent)),
    variability_percent: medianPercent(
      caseResults.map((c) => c.attribution.variability_percent)),
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
  compareSuite,
  benjaminiHochberg,
  medianPercent,
};
