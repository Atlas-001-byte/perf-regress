'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { computeSummary } = require('./stats');

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_MEASURE_ERROR = 3;
const EXIT_OUTPUT_ERROR = 4;

const KNOWN_KEYS = new Set(['command', 'runs', 'warmup', 'timeout-ms', 'output']);

// 解析 --key value / --key=value 形式的参数。
// knownKeys 为允许的参数名集合，缺省为 collect 的参数集。
// 返回 { values, error }；无法解析时 error 为说明字符串。
function parseArgs(tokens, knownKeys = KNOWN_KEYS) {
  const values = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('--')) {
      return { values, error: `无法解析的参数: ${token}` };
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    let key;
    let value;
    if (eq >= 0) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
      if (i + 1 >= tokens.length) {
        return { values, error: `参数 --${key} 缺少取值` };
      }
      value = tokens[++i];
    }
    if (!key) {
      return { values, error: `无法解析的参数: ${token}` };
    }
    if (!knownKeys.has(key)) {
      return { values, error: `未知参数: --${key}` };
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return { values, error: `参数 --${key} 重复指定` };
    }
    values[key] = value;
  }
  return { values, error: null };
}

function parsePositiveIntOption(values, key, { min, required }) {
  if (!Object.prototype.hasOwnProperty.call(values, key)) {
    if (required) return { error: `缺少必填参数 --${key}` };
    return { value: undefined };
  }
  const raw = values[key];
  // 仅接受十进制整数写法
  if (!/^-?\d+$/.test(raw)) {
    return { error: `参数 --${key} 必须为整数，实际为: ${raw}` };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    return { error: `参数 --${key} 必须为 >= ${min} 的整数，实际为: ${raw}` };
  }
  return { value };
}

// 顺序执行一次目标命令。
// 返回 { startedAt, durationNs, exitCode, reason }
// reason 为 null 表示正常退出（exitCode 可能非零，由调用方按阶段处理），
// 或为 'timeout'；进程无法启动时抛错（error.code 通常为 ENOENT/EAGAIN）。
function runOnce(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // 非 Windows 下使子 shell 成为新进程组组长，超时可整组清理，避免遗留孙进程。
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      reject(err);
      return;
    }

    // 丢弃被测命令输出，保持本工具 stdout/stderr 干净，同时排空管道避免反压。
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});

    const startedAt = new Date();
    const startHr = process.hrtime.bigint();
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== 'win32') {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // 进程可能已退出
      }
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationNs = Number(process.hrtime.bigint() - startHr);
      if (timedOut) {
        resolve({ startedAt, durationNs, exitCode: null, reason: 'timeout' });
        return;
      }
      // 被信号终止（非本工具超时）同样记为 nonzero_exit，exit_code 以 null 表示无可用退出码。
      resolve({ startedAt, durationNs, exitCode: code, signal, reason: null });
    });
  });
}

function emptySummary() {
  return {
    count: 0,
    min: null,
    max: null,
    mean: null,
    median: null,
    p95: null,
    stddev: null,
  };
}

// shell 下 127=命令未找到、126=命令不可执行，均属"进程无法启动"。
function isStartupExitCode(code) {
  return code === 126 || code === 127;
}

// 启动失败：按 nonzero_exit 记录（而非 timeout）到 stderr；
// 按约定整体退出码 2，且不创建或改写 output。
function reportStartupFailure(stage, index, exitCode) {
  const record = { stage, index, reason: 'nonzero_exit', exit_code: exitCode };
  process.stderr.write(`perf-regress: 进程无法启动 ${JSON.stringify(record)}\n`);
}

async function collect(tokens) {
  const { values, error: parseError } = parseArgs(tokens);
  if (parseError) {
    process.stderr.write(`perf-regress: ${parseError}\n`);
    return EXIT_USAGE;
  }

  const command = values.command;
  const output = values.output;
  if (command === undefined || command === '') {
    process.stderr.write('perf-regress: --command 不能为空\n');
    return EXIT_USAGE;
  }
  if (output === undefined || output === '') {
    process.stderr.write('perf-regress: --output 不能为空\n');
    return EXIT_USAGE;
  }

  const runsR = parsePositiveIntOption(values, 'runs', { min: 1, required: true });
  if (runsR.error) {
    process.stderr.write(`perf-regress: ${runsR.error}\n`);
    return EXIT_USAGE;
  }
  const warmupR = parsePositiveIntOption(values, 'warmup', { min: 0, required: false });
  if (warmupR.error) {
    process.stderr.write(`perf-regress: ${warmupR.error}\n`);
    return EXIT_USAGE;
  }
  const timeoutR = parsePositiveIntOption(values, 'timeout-ms', { min: 1, required: true });
  if (timeoutR.error) {
    process.stderr.write(`perf-regress: ${timeoutR.error}\n`);
    return EXIT_USAGE;
  }

  const runs = runsR.value;
  const warmup = warmupR.value === undefined ? 0 : warmupR.value;
  const timeoutMs = timeoutR.value;

  const outcome = await executeCase({ command, runs, warmup, timeoutMs });
  if (outcome.fatal) {
    return EXIT_USAGE;
  }

  const report = {
    command,
    runs,
    warmup,
    timeout_ms: timeoutMs,
    unit: 'ns',
    samples: outcome.samples,
    summary: outcome.summary,
    errors: outcome.errors,
  };

  return writeReport(output, report, () =>
    (outcome.errors.some((e) => e.stage === 'measure') ? EXIT_MEASURE_ERROR : EXIT_OK));
}

// 顺序执行一个 case：先 warmup 后 measure，全程不并发。
// 返回 { fatal, samples, errors, summary }：
// fatal=true 表示进程无法启动（调用方已向 stderr 报告，按退出码 2 处理，不写 output）；
// 否则 samples/errors/summary 为 collect 口径的采集结果。
async function executeCase({ command, runs, warmup, timeoutMs }) {
  const samples = [];
  const errors = [];

  // 先顺序预热：异常记录后继续；但进程无法启动属致命错误（退出码 2，不写 output）。
  for (let index = 0; index < warmup; index++) {
    let result;
    try {
      result = await runOnce(command, timeoutMs);
    } catch {
      reportStartupFailure('warmup', index, null);
      return { fatal: true, samples, errors, summary: null };
    }
    if (result.reason === 'timeout') {
      errors.push({ stage: 'warmup', index, reason: 'timeout', exit_code: null });
    } else if (isStartupExitCode(result.exitCode)) {
      reportStartupFailure('warmup', index, result.exitCode);
      return { fatal: true, samples, errors, summary: null };
    } else if (result.exitCode !== 0) {
      errors.push({ stage: 'warmup', index, reason: 'nonzero_exit', exit_code: result.exitCode });
    }
  }

  // 再顺序采集：异常记录后跳过该次；进程无法启动则致命（退出码 2，不写 output）。
  for (let index = 0; index < runs; index++) {
    let result;
    try {
      result = await runOnce(command, timeoutMs);
    } catch {
      reportStartupFailure('measure', index, null);
      return { fatal: true, samples, errors, summary: null };
    }
    if (result.reason === 'timeout') {
      errors.push({ stage: 'measure', index, reason: 'timeout', exit_code: null });
      continue;
    }
    if (isStartupExitCode(result.exitCode)) {
      reportStartupFailure('measure', index, result.exitCode);
      return { fatal: true, samples, errors, summary: null };
    }
    if (result.exitCode !== 0) {
      errors.push({ stage: 'measure', index, reason: 'nonzero_exit', exit_code: result.exitCode });
      continue;
    }
    samples.push({
      index,
      started_at: result.startedAt.toISOString(),
      duration_ns: result.durationNs,
      exit_code: result.exitCode,
    });
  }

  const summary = samples.length === 0
    ? emptySummary()
    : computeSummary(samples.map((s) => s.duration_ns));
  return { fatal: false, samples, errors, summary };
}

// 序列化并以 UTF-8 写入 output。成功返回 successCode()；
// 序列化或写盘失败时 stderr 报告并返回退出码 4。
async function writeReport(output, report, successCode) {
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

  return successCode();
}

module.exports = {
  collect,
  executeCase,
  writeReport,
  parseArgs,
  parsePositiveIntOption,
  runOnce,
  emptySummary,
  isStartupExitCode,
  reportStartupFailure,
  computeSummary,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_MEASURE_ERROR,
  EXIT_OUTPUT_ERROR,
};
