#!/usr/bin/env node
'use strict';

const { collect, EXIT_USAGE } = require('../lib/collect');
const { collectSuite } = require('../lib/collect-suite');
const { compare } = require('../lib/compare');
const { compareSuite } = require('../lib/compare-suite');
const { ab } = require('../lib/ab');
const { abSuite } = require('../lib/ab-suite');

const USAGE = `Usage: perf-regress collect --command <cmd> --runs <n> --warmup <n> \
--timeout-ms <ms> --output <path>
       perf-regress collect-suite --manifest <path> --output <path>
       perf-regress compare --baseline <path> --candidate <path> --output <path> \
[--alpha <a>] [--min-change-percent <p>]
       perf-regress compare-suite --manifest <path> --output <path> \
[--alpha <a>] [--min-change-percent <p>]
       perf-regress ab --baseline-command <cmd> --candidate-command <cmd> \
--runs <n> --warmup <n> --timeout-ms <ms> --output <path> \
[--alpha <a>] [--min-change-percent <p>]
       perf-regress ab-suite --manifest <path> --output <path> \
[--alpha <a>] [--min-change-percent <p>]

collect：顺序执行目标命令进行基准采集，结果以 UTF-8 JSON 写入 --output。
collect-suite：按 manifest 顺序批量采集多个基准场景，含逐 case 结果与套件汇总。
compare：比较两份 collect JSON，输出显著性、回归判定与变化归因。
compare-suite：按 manifest 批量比较多对 collect JSON，含 BH 校正与套件级汇总。
ab：基线与候选同批交替测量（先全部预热再测量，每轮先 baseline 后 candidate），
    输出两侧采集结果与即时比较。
ab-suite：按 manifest 对多个场景逐 case 做交错 A/B 测量与比较，
    含 BH 校正与套件级汇总。

collect 选项：
  --command <cmd>     被测命令（通过 /bin/sh -c 执行），必填
  --runs <n>          计入统计的执行次数，>= 1，必填
  --warmup <n>        预热次数，>= 0，缺省 0
  --timeout-ms <ms>   单次执行超时（毫秒），>= 1，必填
  --output <path>     唯一 JSON 输出文件，必填

collect-suite 选项：
  --manifest <path>   套件 manifest JSON（UTF-8，含非空 cases），必填
  --output <path>     套件采集结果 JSON 输出文件，必填

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

ab 选项：
  --baseline-command <cmd>     基线命令（通过 /bin/sh -c 执行），必填
  --candidate-command <cmd>    候选命令（通过 /bin/sh -c 执行），必填
  --runs <n>                   每侧计入统计的执行次数，>= 2，必填
  --warmup <n>                 每侧预热次数，>= 0，缺省 0
  --timeout-ms <ms>            单次执行超时（毫秒），>= 1，必填
  --output <path>              唯一 JSON 输出文件，必填
  --alpha <a>                  显著性水平，0 < a < 1，缺省 0.05
  --min-change-percent <p>     回归/改进判定阈值（百分比），>= 0，缺省 5

ab-suite 选项：
  --manifest <path>            套件 manifest JSON（含非空 cases，每项含 name、
                               baseline_command、candidate_command、runs、
                               warmup、timeout_ms），必填
  --output <path>              套件 A/B 结果 JSON 输出文件，必填
  --alpha <a>                  显著性水平，0 < a < 1，缺省 0.05
  --min-change-percent <p>     回归/改进判定阈值（百分比），>= 0，缺省 5

退出码：
  0  成功
  2  参数错误或输入无效（collect/collect-suite/ab/ab-suite 含进程无法启动；不创建或改写 output）
  3  collect/collect-suite：measure 阶段存在被跳过的异常（仍写 output）；
     ab：存在 measure 错误或任一侧有效样本少于 2（仍写 output）；
     ab-suite：存在 measure 错误或任一 case 任一侧有效样本少于 2（仍写 output）
  4  output 写入失败
`;

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (subcommand === undefined || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (subcommand !== 'collect' && subcommand !== 'collect-suite'
    && subcommand !== 'compare'
    && subcommand !== 'compare-suite'
    && subcommand !== 'ab'
    && subcommand !== 'ab-suite') {
    process.stderr.write(`perf-regress: 未知子命令: ${subcommand}\n\n${USAGE}`);
    process.exit(EXIT_USAGE);
  }

  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const code = subcommand === 'collect' ? await collect(rest)
    : subcommand === 'collect-suite' ? await collectSuite(rest)
      : subcommand === 'compare' ? await compare(rest)
        : subcommand === 'compare-suite' ? await compareSuite(rest)
          : subcommand === 'ab' ? await ab(rest)
            : await abSuite(rest);
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`perf-regress: 未预期错误: ${err.stack || err.message}\n`);
  process.exit(1);
});
