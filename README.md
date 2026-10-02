# Perf Regress

性能基准与回归检测服务：基准采集、统计显著性与回归归因。

## 范围

本仓库从零开始实现上述方向的可用工具，不依赖外部同类实现。

## 状态

已实现基准采集（`perf-regress collect`）；统计显著性与回归归因将在后续迭代中加入。

## 用法

```sh
perf-regress collect --command "<目标命令>" --runs <次数> [--warmup <次数>] \
    [--timeout-ms <毫秒>] --output <JSON 文件>
```

- 先顺序执行 `warmup` 次预热（缺省 0），再顺序执行 `runs` 次统计执行，不并发。
- 输出为 UTF-8 JSON，顶层固定为 `command`、`runs`、`warmup`、`timeout_ms`、`unit`（`ns`）、`samples`、`summary`、`errors`。
- `samples` 只含计入统计的执行：`index`（从 0 开始）、`started_at`（UTC）、`duration_ns`（单调纳秒耗时）、`exit_code`。
- `summary` 按 `duration_ns` 计算：`count`、`min`、`max`、`mean`、`median`（偶数取中间两值平均）、`p95`（排序后第 ceil(0.95 × count) 项）、`stddev`（总体标准差），浮点保留六位小数。
- `errors` 每项含 `stage`（`warmup`/`measure`）、`index`、`reason`（`nonzero_exit`/`timeout`）、`exit_code`；warmup 异常记录后继续，measure 异常记录后跳过。

结束码：`0` 全部成功；`2` 参数非法或进程无法启动（不创建或改写 output，无法启动按 `nonzero_exit` 归类）；`3` 存在 measure 异常（仍写出 JSON）；`4` output 写入失败。

也可通过 `python3 -m perf_regress collect ...` 调用；测试：`python3 -m unittest discover -s tests`。

## 约定

- 公开行为以 README 与源码为准。
- 后续需求在此基线上增量实现。
