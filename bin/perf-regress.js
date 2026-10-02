#!/usr/bin/env node
'use strict';

const { collect, EXIT_USAGE } = require('../lib/collect');

const USAGE = `Usage: perf-regress collect --command <cmd> --runs <n> --warmup <n> \
--timeout-ms <ms> --output <path>

顺序执行目标命令进行基准采集，结果以 UTF-8 JSON 写入 --output。

选项：
  --command <cmd>     被测命令（通过 /bin/sh -c 执行），必填
  --runs <n>          计入统计的执行次数，>= 1，必填
  --warmup <n>        预热次数，>= 0，缺省 0
  --timeout-ms <ms>   单次执行超时（毫秒），>= 1，必填
  --output <path>     唯一 JSON 输出文件，必填

退出码：
  0  全部成功
  2  参数错误或进程无法启动（不创建或改写 output）
  3  measure 阶段存在被跳过的异常（仍写 output）
  4  output 写入失败
`;

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (subcommand === undefined || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (subcommand !== 'collect') {
    process.stderr.write(`perf-regress: 未知子命令: ${subcommand}\n\n${USAGE}`);
    process.exit(EXIT_USAGE);
  }

  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const code = await collect(rest);
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`perf-regress: 未预期错误: ${err.stack || err.message}\n`);
  process.exit(1);
});
