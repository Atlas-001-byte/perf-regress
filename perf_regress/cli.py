"""perf-regress 命令行入口。"""

from __future__ import annotations

import argparse
import sys

from .collect import EXIT_OK, collect

DEFAULT_TIMEOUT_MS = 60000


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="perf-regress",
        description="性能基准与回归检测服务：基准采集、统计显著性与回归归因。",
    )
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    collect_parser = subparsers.add_parser(
        "collect",
        help="顺序执行目标命令，采集耗时样本并输出 JSON 摘要",
    )
    collect_parser.add_argument("--command", required=True, help="要执行的目标命令")
    collect_parser.add_argument(
        "--runs", type=int, required=True, help="计入统计的执行次数（>= 1）"
    )
    collect_parser.add_argument(
        "--warmup", type=int, default=0, help="预热执行次数（>= 0，缺省为 0）"
    )
    collect_parser.add_argument(
        "--timeout-ms",
        type=int,
        default=DEFAULT_TIMEOUT_MS,
        dest="timeout_ms",
        help="单次执行超时毫秒数（>= 1，缺省 %(default)s）",
    )
    collect_parser.add_argument("--output", required=True, help="唯一的 JSON 输出文件")
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    # 参数无法解析时 argparse 以结束码 2 退出，符合约定
    args = parser.parse_args(argv)
    if args.subcommand == "collect":
        return collect(
            command=args.command,
            runs=args.runs,
            warmup=args.warmup,
            timeout_ms=args.timeout_ms,
            output=args.output,
        )
    parser.error(f"未知子命令：{args.subcommand}")  # pragma: no cover
    return EXIT_OK  # pragma: no cover


def entry() -> None:
    sys.exit(main())


if __name__ == "__main__":
    entry()
