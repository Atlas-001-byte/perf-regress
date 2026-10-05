'use strict';

const fs = require('node:fs/promises');
const {
  parseArgs,
  parsePositiveIntOption,
  runOnce,
  emptySummary,
  computeSummary,
  isStartupExitCode,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_MEASURE_ERROR,
  EXIT_OUTPUT_ERROR,
} = require('./collect');
const {
  buildCompareResult,
  decide,
  parseNumberOption,
  DEFAULT_ALPHA,
  DEFAULT_MIN_CHANGE_PERCENT,
} = require('./compare');

const KNOWN_KEYS = new Set([
  'baseline-command',
  'candidate-command',
  'runs',
  'warmup',
  'timeout-ms',
  'output',
  'alpha',
  'min-change-percent',
]);

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// 启动失败：按 nonzero_exit 记录到 stderr（含所属侧）；
// 按约定整体退出码 2，且不创建或改写 output。
function reportStartupFailure(side, stage, index, exitCode) {
  const record = { side, stage, index, reason: 'nonzero_exit', exit_code: exitCode };
  process.stderr.write(`perf-regress: 进程无法启动 ${JSON.stringify(record)}\n`);
}

// 交错执行两侧命令：先按轮次完成全部预热，再按轮次交错测量，
// 每轮先 baseline 后 candidate，全程串行。
// warmup 的 nonzero_exit/timeout 只记录；measure 的同类错误跳过该次后继续；
// 单侧异常不影响另一侧及后续轮次。
// 返回 { baseline, candidate, fatal }：两侧各含 { samples, errors }，
// errors 的 index 在本侧从 0 计数；fatal=true 表示进程无法启动
// （spawn 抛错或 shell 126/127），已向 stderr 报告，调用方须以退出码 2
// 终止且不得写 output。
async function executeInterleaved(baselineCommand, candidateCommand, runs, warmup, timeoutMs) {
  const sides = {
    baseline: { command: baselineCommand, samples: [], errors: [] },
    candidate: { command: candidateCommand, samples: [], errors: [] },
  };
  const order = ['baseline', 'candidate'];

  const runSide = async (sideName, stage, index) => {
    const side = sides[sideName];
    let result;
    try {
      result = await runOnce(side.command, timeoutMs);
    } catch {
      reportStartupFailure(sideName, stage, index, null);
      return false;
    }
    if (result.reason === 'timeout') {
      side.errors.push({ stage, index, reason: 'timeout', exit_code: null });
      return true;
    }
    if (isStartupExitCode(result.exitCode)) {
      reportStartupFailure(sideName, stage, index, result.exitCode);
      return false;
    }
    if (result.exitCode !== 0) {
      side.errors.push({ stage, index, reason: 'nonzero_exit', exit_code: result.exitCode });
      return true;
    }
    if (stage === 'measure') {
      side.samples.push({
        index,
        started_at: result.startedAt.toISOString(),
        duration_ns: result.durationNs,
        exit_code: result.exitCode,
      });
    }
    return true;
  };

  for (let index = 0; index < warmup; index++) {
    for (const sideName of order) {
      if (!(await runSide(sideName, 'warmup', index))) {
        return { baseline: sides.baseline, candidate: sides.candidate, fatal: true };
      }
    }
  }
  for (let index = 0; index < runs; index++) {
    for (const sideName of order) {
      if (!(await runSide(sideName, 'measure', index))) {
        return { baseline: sides.baseline, candidate: sides.candidate, fatal: true };
      }
    }
  }
  return { baseline: sides.baseline, candidate: sides.candidate, fatal: false };
}

// 一侧的 collect 口径报告：command/runs/warmup/timeout_ms/unit/samples/summary/errors。
function buildSideReport(command, runs, warmup, timeoutMs, side) {
  return {
    command,
    runs,
    warmup,
    timeout_ms: timeoutMs,
    unit: 'ns',
    samples: side.samples,
    summary: side.samples.length === 0
      ? emptySummary()
      : computeSummary(side.samples.map((s) => s.duration_ns)),
    errors: side.errors,
  };
}

async function ab(tokens) {
  const { values, error: parseError } = parseArgs(tokens, KNOWN_KEYS);
  if (parseError) {
    return fail(parseError);
  }

  const baselineCommand = values['baseline-command'];
  const candidateCommand = values['candidate-command'];
  const output = values.output;
  if (baselineCommand === undefined || baselineCommand === '') {
    return fail('--baseline-command 不能为空');
  }
  if (candidateCommand === undefined || candidateCommand === '') {
    return fail('--candidate-command 不能为空');
  }
  if (output === undefined || output === '') {
    return fail('--output 不能为空');
  }

  const runsR = parsePositiveIntOption(values, 'runs', { min: 2, required: true });
  if (runsR.error) {
    return fail(runsR.error);
  }
  const warmupR = parsePositiveIntOption(values, 'warmup', { min: 0, required: false });
  if (warmupR.error) {
    return fail(warmupR.error);
  }
  const timeoutR = parsePositiveIntOption(values, 'timeout-ms', { min: 1, required: true });
  if (timeoutR.error) {
    return fail(timeoutR.error);
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

  const runs = runsR.value;
  const warmup = warmupR.value === undefined ? 0 : warmupR.value;
  const timeoutMs = timeoutR.value;
  const alpha = alphaR.value;
  const minChangePercent = minChangeR.value;

  const { baseline, candidate, fatal } = await executeInterleaved(
    baselineCommand, candidateCommand, runs, warmup, timeoutMs);
  // 进程无法启动属致命错误：stderr 已报告，不创建或改写 output。
  if (fatal) {
    return EXIT_USAGE;
  }

  const baselineReport = buildSideReport(baselineCommand, runs, warmup, timeoutMs, baseline);
  const candidateReport = buildSideReport(candidateCommand, runs, warmup, timeoutMs, candidate);

  // 两侧都至少有两个 exit_code 为 0 的样本时，按 compare 口径给出比较结果。
  const baselineDurations = baselineReport.samples.map((s) => s.duration_ns);
  const candidateDurations = candidateReport.samples.map((s) => s.duration_ns);
  let comparison = null;
  if (baselineDurations.length >= 2 && candidateDurations.length >= 2) {
    const {
      baselineSummary, candidateSummary, delta, welch, attribution,
    } = buildCompareResult(
      { command: baselineCommand, durations: baselineDurations },
      { command: candidateCommand, durations: candidateDurations },
    );
    comparison = {
      baseline_summary: baselineSummary,
      candidate_summary: candidateSummary,
      delta,
      welch,
      decision: decide(welch.p_value, alpha, delta.mean.percent, minChangePercent),
      attribution,
    };
  }

  const report = {
    baseline: baselineReport,
    candidate: candidateReport,
    comparison,
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

  const hasMeasureErrors = baselineReport.errors.some((e) => e.stage === 'measure')
    || candidateReport.errors.some((e) => e.stage === 'measure');
  const insufficientSamples = baselineDurations.length < 2 || candidateDurations.length < 2;
  return hasMeasureErrors || insufficientSamples ? EXIT_MEASURE_ERROR : EXIT_OK;
}

module.exports = {
  ab,
  executeInterleaved,
  buildSideReport,
};
