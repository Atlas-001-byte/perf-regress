#!/usr/bin/env node
'use strict';

const { collect, EXIT_USAGE } = require('../lib/collect');
const { compare } = require('../lib/compare');
const { compareSuite } = require('../lib/compare-suite');

const USAGE = `Usage: perf-regress collect --command <cmd> --runs <n> --warmup <n> \
--timeout-ms <ms> --output <path>
       perf-regress compare --baseline <path> --candidate <path> --output <path> \
[--alpha <a>] [--min-change-percent <p>]
       perf-regress compare-suite --manifest <path> --output <path> \
[--alpha <a>] [--min-change-percent <p>]

collect：顺序执行目标命令进行基准采集，结果以 UTF-8 JSON 写入 --output。
compare：比较两份 collect JSON，输出显著性、回归判定与变化归因。
compare-suite：按 manifest 批量比较多对 collect JSON，含 BH 校正与套件级汇总。

collect 选项：
  --command <cmd>     被测命令（通过 /bin/sh -c 执行），必填
  --runs <n>          计入统计的执行次数，>= 1，必填
  --warmup <n>        预热次数，>= 0，缺省 0
  --timeout-ms <ms>   单次执行超时（毫秒），>= 1，必填
  --output <path>     唯一 JSON 输出文件，必填

compare 选项：
  --baseline <path>            基线 collect JSON，必填
  --candidate <path>           候选 collect JSON，必填
  --output <path>              比较结果 JSON 输出文件，必填
  --alpha <a>                  显著性水平，0 < a < 1，缺省 0.05
  --min-change-percent <p>     回归/改进判定阈值（百分比），>= 0，缺省 5

compare-suite 选项：
  --manifest <path>            套件 manifest JSON（含非空 cases），必填
  --output <path>              套件比较结果 JSON 输出文件，必填
  --alpha <a>                  显著性水平，0 < a < 1，缺省 0.05
  --min-change-percent <p>     回归/改进判定阈值（百分比），>= 0，缺省 5

退出码：
  0  成功
  2  参数错误或输入无效（collect 含进程无法启动；不创建或改写 output）
  3  collect：measure 阶段存在被跳过的异常（仍写 output）
  4  output 写入失败
`;

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (subcommand === undefined || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (subcommand !== 'collect' && subcommand !== 'compare'
    && subcommand !== 'compare-suite') {
    process.stderr.write(`perf-regress: 未知子命令: ${subcommand}\n\n${USAGE}`);
    process.exit(EXIT_USAGE);
  }

  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const code = subcommand === 'collect' ? await collect(rest)
    : subcommand === 'compare' ? await compare(rest)
      : await compareSuite(rest);
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`perf-regress: 未预期错误: ${err.stack || err.message}\n`);
  process.exit(1);
});
