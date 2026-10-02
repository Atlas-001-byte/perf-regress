"""基准采集核心逻辑：顺序执行命令并汇总耗时统计。"""

from __future__ import annotations

import json
import math
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone

# 结束码约定
EXIT_OK = 0
EXIT_USAGE = 2        # 参数非法或进程无法启动
EXIT_MEASURE_ERROR = 3  # 存在 measure 阶段异常（仍写出 JSON）
EXIT_WRITE_ERROR = 4  # output 写入失败

UNIT = "ns"

REASON_NONZERO_EXIT = "nonzero_exit"
REASON_TIMEOUT = "timeout"

STAGE_WARMUP = "warmup"
STAGE_MEASURE = "measure"


class _SpawnFailure(Exception):
    """进程无法启动（按 nonzero_exit 归类，而非超时）。"""


class _RunResult:
    __slots__ = ("started_at", "duration_ns", "exit_code", "timed_out")

    def __init__(self, started_at, duration_ns, exit_code, timed_out):
        self.started_at = started_at
        self.duration_ns = duration_ns
        self.exit_code = exit_code
        self.timed_out = timed_out


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _execute_once(command: str, timeout_ms: int) -> _RunResult:
    """执行一次命令，返回开始时刻、单调纳秒耗时与退出码。"""
    started_at = _utc_now_iso()
    start_ns = time.monotonic_ns()
    try:
        proc = subprocess.run(
            command,
            shell=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout_ms / 1000.0,
        )
    except subprocess.TimeoutExpired:
        duration_ns = time.monotonic_ns() - start_ns
        # 超时被强制终止，无有效退出码
        return _RunResult(started_at, duration_ns, None, True)
    except OSError as exc:
        # 进程无法启动：归类为 nonzero_exit 的致命错误，而非超时
        raise _SpawnFailure(str(exc)) from exc
    duration_ns = time.monotonic_ns() - start_ns
    return _RunResult(started_at, duration_ns, proc.returncode, False)


def summarize(samples) -> dict:
    """按 duration_ns 计算固定字段的摘要统计。

    median 对偶数样本取中间两值平均；p95 取排序后第 ceil(0.95 × count) 项；
    stddev 为总体标准差；浮点保留六位小数。
    """
    count = len(samples)
    if count == 0:
        return {
            "count": 0,
            "min": None,
            "max": None,
            "mean": None,
            "median": None,
            "p95": None,
            "stddev": None,
        }
    durations = sorted(s["duration_ns"] for s in samples)
    if count % 2 == 1:
        median = durations[count // 2]
    else:
        median = (durations[count // 2 - 1] + durations[count // 2]) / 2
    p95 = durations[math.ceil(0.95 * count) - 1]
    return {
        "count": count,
        "min": durations[0],
        "max": durations[-1],
        "mean": round(statistics.fmean(durations), 6),
        "median": round(median, 6),
        "p95": p95,
        "stddev": round(statistics.pstdev(durations), 6),
    }


def collect(command: str, runs: int, warmup: int, timeout_ms: int, output: str) -> int:
    """执行基准采集并写出 JSON，返回进程结束码。"""
    if (
        runs < 1
        or warmup < 0
        or timeout_ms < 1
        or not command
        or not output
    ):
        print(
            "perf-regress: 参数非法：要求 runs >= 1、warmup >= 0、"
            "timeout-ms >= 1，且 command 与 output 非空",
            file=sys.stderr,
        )
        return EXIT_USAGE

    errors = []
    samples = []

    def run_stage(stage, count):
        for index in range(count):
            result = _execute_once(command, timeout_ms)
            if result.timed_out:
                errors.append(
                    {
                        "stage": stage,
                        "index": index,
                        "reason": REASON_TIMEOUT,
                        "exit_code": None,
                    }
                )
                continue
            if result.exit_code != 0:
                errors.append(
                    {
                        "stage": stage,
                        "index": index,
                        "reason": REASON_NONZERO_EXIT,
                        "exit_code": result.exit_code,
                    }
                )
                continue
            if stage == STAGE_MEASURE:
                samples.append(
                    {
                        "index": index,
                        "started_at": result.started_at,
                        "duration_ns": result.duration_ns,
                        "exit_code": result.exit_code,
                    }
                )

    try:
        # 先顺序执行 warmup，再顺序执行 runs，不并发
        run_stage(STAGE_WARMUP, warmup)
        run_stage(STAGE_MEASURE, runs)
    except _SpawnFailure as exc:
        # 进程无法启动：不创建或改写 output
        print(
            f"perf-regress: 进程无法启动（{REASON_NONZERO_EXIT}）：{exc}",
            file=sys.stderr,
        )
        return EXIT_USAGE

    document = {
        "command": command,
        "runs": runs,
        "warmup": warmup,
        "timeout_ms": timeout_ms,
        "unit": UNIT,
        "samples": samples,
        "summary": summarize(samples),
        "errors": errors,
    }

    try:
        with open(output, "w", encoding="utf-8") as fh:
            json.dump(document, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    except OSError as exc:
        print(f"perf-regress: 无法写入 output：{exc}", file=sys.stderr)
        return EXIT_WRITE_ERROR

    if any(err["stage"] == STAGE_MEASURE for err in errors):
        return EXIT_MEASURE_ERROR
    return EXIT_OK
