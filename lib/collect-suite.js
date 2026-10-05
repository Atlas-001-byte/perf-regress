'use strict';

const fs = require('node:fs/promises');
const {
  parseArgs,
  executeCase,
  emptySummary,
  computeSummary,
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

// 读取并校验 collect-suite manifest：UTF-8 JSON 对象，cases 为非空数组；
// 每项 name 非空且唯一，command 非空，runs >= 1、warmup >= 0、timeout_ms >= 1
// 均为整数，未知字段忽略。返回 { cases } 或 { error }。
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
    if (typeof item.command !== 'string' || item.command === '') {
      return { error: `${where} (${item.name}) 的 command 必须为非空字符串` };
    }
    const intField = (key, min) => {
      if (!Number.isSafeInteger(item[key])) {
        return `${where} (${item.name}) 的 ${key} 必须为整数，实际为: ${JSON.stringify(item[key])}`;
      }
      if (item[key] < min) {
        return `${where} (${item.name}) 的 ${key} 必须为 >= ${min} 的整数，实际为: ${item[key]}`;
      }
      return null;
    };
    for (const e of [
      intField('runs', 1),
      intField('warmup', 0),
      intField('timeout_ms', 1),
    ]) {
      if (e) return { error: e };
    }
    names.add(item.name);
    cases.push({
      name: item.name,
      command: item.command,
      runs: item.runs,
      warmup: item.warmup,
      timeout_ms: item.timeout_ms,
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

  // 执行前完整校验：manifest 不合法直接退出 2，不创建或改写 output。
  const manifestR = await loadManifest(manifestPath);
  if (manifestR.error) {
    return fail(manifestR.error);
  }

  // 按 cases 顺序采集，case 内先 warmup 后 runs，case 间不并发。
  const caseReports = [];
  for (const c of manifestR.cases) {
    const { samples, errors, fatal } = await executeCase(
      c.command, c.runs, c.warmup, c.timeout_ms);
    // 进程无法启动属致命错误：stderr 已由 executeCase 报告，不创建或改写 output。
    if (fatal) {
      return EXIT_USAGE;
    }
    const summary = samples.length === 0
      ? emptySummary()
      : computeSummary(samples.map((s) => s.duration_ns));
    const hasMeasureErrors = errors.some((e) => e.stage === 'measure');
    caseReports.push({
      name: c.name,
      command: c.command,
      runs: c.runs,
      warmup: c.warmup,
      timeout_ms: c.timeout_ms,
      unit: 'ns',
      samples,
      summary,
      errors,
      status: hasMeasureErrors ? 'measure_errors' : 'ok',
    });
  }

  const suiteSummary = {
    total: caseReports.length,
    ok: caseReports.filter((c) => c.status === 'ok').length,
    measure_errors: caseReports.filter((c) => c.status === 'measure_errors').length,
    sample_count: caseReports.reduce((n, c) => n + c.samples.length, 0),
    error_count: caseReports.reduce((n, c) => n + c.errors.length, 0),
  };

  const report = {
    cases: caseReports,
    suite_summary: suiteSummary,
  };

  let payload;
  try {
    payload = JSON.stringify(report, null, 2) + '\n';
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

  return suiteSummary.measure_errors > 0 ? EXIT_MEASURE_ERROR : EXIT_OK;
}

module.exports = {
  collectSuite,
  loadManifest,
};
