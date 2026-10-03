'use strict';

const fs = require('node:fs/promises');
const { parseArgs, EXIT_OK, EXIT_USAGE, EXIT_OUTPUT_ERROR } = require('./collect');
const { computeSummary, welchTTest, round6 } = require('./stats');

const KNOWN_KEYS = new Set(['baseline', 'candidate', 'output', 'alpha', 'min-change-percent']);

const DEFAULT_ALPHA = 0.05;
const DEFAULT_MIN_CHANGE_PERCENT = 5;

function usageError(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// 十进制数值写法（允许科学计数法）
const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function parseNumberOption(values, key, fallback) {
  if (!Object.prototype.hasOwnProperty.call(values, key)) {
    return { value: fallback };
  }
  const raw = values[key];
  if (!NUMBER_RE.test(raw)) {
    return { error: `参数 --${key} 必须为数值，实际为: ${raw}` };
  }
  return { value: Number(raw) };
}

// 读取 collect JSON，提取 exit_code 为 0 的 duration_ns。
// 返回 { command, durations } 或 { error }。
async function loadDurations(filePath, label) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    return { error: `无法读取 ${label} 文件 ${filePath}: ${err.message}` };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { error: `${label} 文件不是合法 JSON: ${filePath}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { error: `${label} 文件不是 collect 结果 JSON: ${filePath}` };
  }
  if (doc.unit !== 'ns') {
    return { error: `${label} 文件 unit 必须为 "ns"，实际为: ${JSON.stringify(doc.unit)}` };
  }
  if (typeof doc.command !== 'string') {
    return { error: `${label} 文件缺少字符串 command 字段: ${filePath}` };
  }
  if (!Array.isArray(doc.samples)) {
    return { error: `${label} 文件缺少 samples 数组: ${filePath}` };
  }
  const durations = [];
  for (const sample of doc.samples) {
    if (!sample || sample.exit_code !== 0) continue;
    if (!Number.isSafeInteger(sample.duration_ns) || sample.duration_ns < 0) {
      return { error: `${label} 文件存在非法 duration_ns（须为非负安全整数）: ${filePath}` };
    }
    durations.push(sample.duration_ns);
  }
  if (durations.length < 2) {
    return { error: `${label} 有效样本（exit_code 为 0）不足 2 个: ${filePath}` };
  }
  return { command: doc.command, durations };
}

// 候选减基线的 ns 差与百分比；基线为 0 时：候选同为 0 记 0，否则百分比为 null。
function deltaOf(base, candidate) {
  const ns = round6(candidate - base);
  let percent;
  if (base === 0) {
    percent = candidate === 0 ? 0 : null;
  } else {
    percent = round6(((candidate - base) / base) * 100);
  }
  return { ns, percent };
}

// dominant_factor 的候选顺序（平手时取靠前者）
const FACTOR_ORDER = ['central_tendency_percent', 'tail_latency_percent', 'variability_percent'];

function attributionOf(delta) {
  const attribution = {
    central_tendency_percent: delta.mean.percent,
    tail_latency_percent: delta.p95.percent,
    variability_percent: delta.stddev.percent,
  };
  let dominant = 'none';
  let best = 0;
  for (const key of FACTOR_ORDER) {
    const value = attribution[key];
    if (value !== null && value > best) {
      best = value;
      dominant = key;
    }
  }
  attribution.dominant_factor = dominant;
  return attribution;
}

function decide(significant, meanPercent, minChangePercent) {
  if (!significant) return 'not_significant';
  // 基线均值为 0 而候选显著更大（百分比无法表示，视为达到阈值）
  if (meanPercent === null) return 'regression';
  if (meanPercent >= minChangePercent) return 'regression';
  if (meanPercent <= -minChangePercent) return 'improvement';
  return 'no_material_change';
}

async function compare(tokens) {
  const { values, error: parseError } = parseArgs(tokens, KNOWN_KEYS);
  if (parseError) return usageError(parseError);

  for (const key of ['baseline', 'candidate', 'output']) {
    if (!values[key]) return usageError(`--${key} 不能为空`);
  }

  const alphaR = parseNumberOption(values, 'alpha', DEFAULT_ALPHA);
  if (alphaR.error) return usageError(alphaR.error);
  if (!(alphaR.value > 0 && alphaR.value < 1)) {
    return usageError(`参数 --alpha 必须满足 0 < alpha < 1，实际为: ${values.alpha}`);
  }
  const minChangeR = parseNumberOption(values, 'min-change-percent', DEFAULT_MIN_CHANGE_PERCENT);
  if (minChangeR.error) return usageError(minChangeR.error);
  if (!(minChangeR.value >= 0)) {
    return usageError(`参数 --min-change-percent 必须 >= 0，实际为: ${values['min-change-percent']}`);
  }

  const base = await loadDurations(values.baseline, '--baseline');
  if (base.error) return usageError(base.error);
  const cand = await loadDurations(values.candidate, '--candidate');
  if (cand.error) return usageError(cand.error);
  if (base.command !== cand.command) {
    return usageError('两份输入的 command 不一致');
  }

  // 按 collect summary 七项口径，仅用 exit_code 为 0 的 duration_ns 重算
  const baselineSummary = computeSummary(base.durations);
  const candidateSummary = computeSummary(cand.durations);

  const delta = {
    mean: deltaOf(baselineSummary.mean, candidateSummary.mean),
    median: deltaOf(baselineSummary.median, candidateSummary.median),
    p95: deltaOf(baselineSummary.p95, candidateSummary.p95),
    stddev: deltaOf(baselineSummary.stddev, candidateSummary.stddev),
  };

  const welch = welchTTest(base.durations, cand.durations);
  const significant = welch.p_value <= alphaR.value;

  const report = {
    baseline_summary: baselineSummary,
    candidate_summary: candidateSummary,
    delta,
    welch,
    decision: decide(significant, delta.mean.percent, minChangeR.value),
    attribution: attributionOf(delta),
  };

  let payload;
  try {
    payload = JSON.stringify(report, null, 2) + '\n';
  } catch (err) {
    process.stderr.write(`perf-regress: 结果序列化失败: ${err.message}\n`);
    return EXIT_OUTPUT_ERROR;
  }

  try {
    await fs.writeFile(values.output, payload, 'utf8');
  } catch (err) {
    process.stderr.write(`perf-regress: 无法写入 --output ${values.output}: ${err.message}\n`);
    return EXIT_OUTPUT_ERROR;
  }

  return EXIT_OK;
}

module.exports = {
  compare,
  loadDurations,
  deltaOf,
  attributionOf,
  decide,
  DEFAULT_ALPHA,
  DEFAULT_MIN_CHANGE_PERCENT,
};
