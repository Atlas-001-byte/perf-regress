'use strict';

const fs = require('node:fs/promises');
const {
  parseArgs,
  parsePositiveIntOption,
  runOnce,
  emptySummary,
  computeSummary,
  isStartupExitCode,
  reportStartupFailure,
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
  'baseline-command', 'candidate-command',
  'runs', 'warmup', 'timeout-ms', 'output',
  'alpha', 'min-change-percent',
]);

function fail(message) {
  process.stderr.write(`perf-regress: ${message}\n`);
  return EXIT_USAGE;
}

// 交错执行基线与候选：先完成全部预热再测量，预热和测量按轮次交错，
// 每轮先 baseline 后 candidate，全程串行。
// 每侧口径与 collect 的 executeCase 一致：warmup 的 nonzero_exit/timeout 只记录，
// measure 的同类错误跳过该次后继续；errors 的 index 在本侧从 0 计数。
// 返回 { baseline, candidate, fatal }：fatal=true 表示进程无法启动
// （spawn 抛错或 shell 126/127），已向 stderr 报告，调用方须以退出码 2 终止
// 且不得写 output；单侧超时或失败不影响另一侧及后续轮次。
async function executeInterleaved(baselineCommand, candidateCommand, runs, warmup, timeoutMs) {
  const baseline = { samples: [], errors: [] };
  const candidate = { samples: [], errors: [] };

  // 执行单侧一次；返回 true 表示进程无法启动（致命）。
  async function runSide(side, command, stage, index) {
    let result;
    try {
      result = await runOnce(command, timeoutMs);
    } catch {
      reportStartupFailure(stage, index, null);
      return true;
    }
    if (result.reason === 'timeout') {
      side.errors.push({ stage, index, reason: 'timeout', exit_code: null });
      return false;
    }
    if (isStartupExitCode(result.exitCode)) {
      reportStartupFailure(stage, index, result.exitCode);
      return true;
    }
    if (result.exitCode !== 0) {
      side.errors.push({ stage, index, reason: 'nonzero_exit', exit_code: result.exitCode });
      return false;
    }
    if (stage === 'measure') {
      side.samples.push({
        index,
        started_at: result.startedAt.toISOString(),
        duration_ns: result.durationNs,
        exit_code: result.exitCode,
      });
    }
    return false;
  }

  for (let index = 0; index < warmup; index++) {
    if (await runSide(baseline, baselineCommand, 'warmup', index)) return { fatal: true };
    if (await runSide(candidate, candidateCommand, 'warmup', index)) return { fatal: true };
  }
  for (let index = 0; index < runs; index++) {
    if (await runSide(baseline, baselineCommand, 'measure', index)) return { fatal: true };
    if (await runSide(candidate, candidateCommand, 'measure', index)) return { fatal: true };
  }
  return { baseline, candidate, fatal: false };
}

function sideReport(command, runs, warmup, timeoutMs, side) {
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

  const result = await executeInterleaved(
    baselineCommand, candidateCommand, runs, warmup, timeoutMs);
  // 进程无法启动属致命错误：stderr 已报告，不创建或改写 output。
  if (result.fatal) {
    return EXIT_USAGE;
  }

  const baselineDurations = result.baseline.samples
    .filter((s) => s.exit_code === 0)
    .map((s) => s.duration_ns);
  const candidateDurations = result.candidate.samples
    .filter((s) => s.exit_code === 0)
    .map((s) => s.duration_ns);

  // 两侧都至少有两个有效样本时按 compare 口径给出比较结果，否则为 null。
  let comparison = null;
  if (baselineDurations.length >= 2 && candidateDurations.length >= 2) {
    const {
      baselineSummary, candidateSummary, delta, welch, attribution,
    } = buildCompareResult(
      { durations: baselineDurations },
      { durations: candidateDurations },
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
    baseline: sideReport(baselineCommand, runs, warmup, timeoutMs, result.baseline),
    candidate: sideReport(candidateCommand, runs, warmup, timeoutMs, result.candidate),
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

  const hasMeasureErrors = result.baseline.errors.some((e) => e.stage === 'measure')
    || result.candidate.errors.some((e) => e.stage === 'measure');
  const tooFewSamples = baselineDurations.length < 2 || candidateDurations.length < 2;
  return hasMeasureErrors || tooFewSamples ? EXIT_MEASURE_ERROR : EXIT_OK;
}

module.exports = {
  ab,
  executeInterleaved,
};
