'use strict';

const fs = require('node:fs/promises');
const {
  parseArgs,
  executeCase,
  writeReport,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_MEASURE_ERROR,
  EXIT_OUTPUT_ERROR,
} = require('./collect');

const KNOWN_KEYS = new Set(['manifest', 'output']);

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// 校验 manifest 中的整数字段：必须存在且为 >= min 的安全整数。
function manifestInt(item, field, i, name, min) {
  const v = item[field];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) {
    return {
      error: `manifest cases[${i}] (${name}) 的 ${field} 必须为 >= ${min} 的整数，实际为: ${JSON.stringify(v)}`,
    };
  }
  return { value: v };
}

// 读取并校验 manifest：UTF-8 JSON 对象，cases 为非空数组；
// 每项含唯一非空 name、非空 command，以及 runs >= 1、warmup >= 0、timeout_ms >= 1。
// 未知字段忽略。返回 { cases } 或 { error }。
async function loadCollectManifest(manifestPath) {
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
    if (typeof item.command !== 'string' || item.command === '') {
      return { error: `manifest cases[${i}] (${item.name}) 的 command 必须为非空字符串` };
    }
    const runsR = manifestInt(item, 'runs', i, item.name, 1);
    if (runsR.error) return { error: runsR.error };
    const warmupR = manifestInt(item, 'warmup', i, item.name, 0);
    if (warmupR.error) return { error: warmupR.error };
    const timeoutR = manifestInt(item, 'timeout_ms', i, item.name, 1);
    if (timeoutR.error) return { error: timeoutR.error };
    names.add(item.name);
    cases.push({
      name: item.name,
      command: item.command,
      runs: runsR.value,
      warmup: warmupR.value,
      timeoutMs: timeoutR.value,
    });
  }
  return { cases };
}

async function collectSuite(tokens) {
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

  // 执行前完整校验：manifest 未通过时不启动任何进程、不创建或改写 output。
  const manifestR = await loadCollectManifest(manifestPath);
  if (manifestR.error) {
    return fail(manifestR.error);
  }

  // 按 cases 顺序采集：case 内先顺序 warmup 再顺序 runs，case 间也不并发。
  const caseResults = [];
  let anyMeasureError = false;
  for (const c of manifestR.cases) {
    const outcome = await executeCase({
      command: c.command,
      runs: c.runs,
      warmup: c.warmup,
      timeoutMs: c.timeoutMs,
    });
    // 进程无法启动：executeCase 已向 stderr 报告，整体退出码 2，不创建或改写 output。
    if (outcome.fatal) {
      return EXIT_USAGE;
    }
    const status = outcome.errors.some((e) => e.stage === 'measure')
      ? 'measure_errors'
      : 'ok';
    if (status === 'measure_errors') {
      anyMeasureError = true;
    }
    caseResults.push({
      name: c.name,
      command: c.command,
      runs: c.runs,
      warmup: c.warmup,
      timeout_ms: c.timeoutMs,
      unit: 'ns',
      samples: outcome.samples,
      summary: outcome.summary,
      errors: outcome.errors,
      status,
    });
  }

  const suiteSummary = {
    total: caseResults.length,
    ok: caseResults.filter((c) => c.status === 'ok').length,
    measure_errors: caseResults.filter((c) => c.status === 'measure_errors').length,
    sample_count: caseResults.reduce((n, c) => n + c.samples.length, 0),
    error_count: caseResults.reduce((n, c) => n + c.errors.length, 0),
  };

  const result = {
    cases: caseResults,
    suite_summary: suiteSummary,
  };

  // 无论是否存在测量错误都写完整文件；写入失败退出码 4。
  return writeReport(output, result, () =>
    (anyMeasureError ? EXIT_MEASURE_ERROR : EXIT_OK));
}

module.exports = {
  collectSuite,
  loadCollectManifest,
};
