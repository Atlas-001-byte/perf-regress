# Perf Regress

性能基准与回归检测服务：基准采集、统计显著性与回归归因。

## 范围

本仓库从零开始实现上述方向的可用工具，不依赖外部同类实现。

## 状态

已实现：基准采集子命令 `perf-regress collect` 与回归比较子命令
`perf-regress compare`（零依赖 Node.js）。

## 用法

需要 Node.js（无第三方依赖）：

```sh
node bin/perf-regress.js collect \
  --command '<被测命令>' \
  --runs <统计次数> \
  --warmup <预热次数> \
  --timeout-ms <单次超时毫秒> \
  --output <结果.json>

node bin/perf-regress.js compare \
  --baseline <基线.json> \
  --candidate <候选.json> \
  --output <比较结果.json> \
  [--alpha 0.05] [--min-change-percent 5]
```

- `--command`：被测命令，经系统 shell 执行，必填，非空。
- `--runs`：计入统计的执行次数，整数且 `>= 1`，必填。
- `--warmup`：预热次数，整数且 `>= 0`，缺省 `0`。
- `--timeout-ms`：单次执行超时毫秒数，整数且 `>= 1`，必填。
- `--output`：唯一 JSON 输出文件路径，必填，非空。

执行顺序：先顺序执行全部 warmup，再顺序执行全部 runs，全程不并发。
被测命令的 stdout/stderr 被丢弃。

### 退出码

| 码 | 含义 |
|----|------|
| 0 | 全部成功（samples 数量等于 runs） |
| 2 | 参数无法解析/越界、command 或 output 为空、进程无法启动；不创建或改写 output |
| 3 | measure 阶段存在 nonzero_exit 或 timeout（仍写 JSON，出错的执行被跳过） |
| 4 | output 写入失败 |

warmup 阶段的 nonzero_exit/timeout 只记录到 `errors`，不影响退出码；
进程无法启动按 `nonzero_exit` 处理而非 `timeout`，且属退出码 2 的致命错误。

### 输出 JSON（UTF-8）

顶层固定字段：`command`、`runs`、`warmup`、`timeout_ms`、`unit`、`samples`、`summary`、`errors`，其中 `unit` 恒为 `"ns"`。

- `samples`：仅含计入统计（退出码 0）的执行，按执行顺序排列：
  - `index`：从 0 开始的原始执行序号（被跳过的序号不出现在 samples 中）
  - `started_at`：UTC 开始时刻（ISO 8601，`Z` 结尾）
  - `duration_ns`：单调时钟纳秒耗时
  - `exit_code`：退出码
- `summary`：按 `duration_ns` 计算，固定含 `count`、`min`、`max`、`mean`、
  `median`、`p95`、`stddev`。
  - `median`：偶数样本取中间两值平均；
  - `p95`：排序后第 `ceil(0.95 * count)` 项；
  - `stddev`：总体标准差；浮点字段保留六位小数。
  - 无有效样本时 `count` 为 0，其余统计字段为 `null`。
- `errors`：每项含 `stage`（`warmup` / `measure`）、`index`、
  `reason`（`nonzero_exit` / `timeout`）、`exit_code`（timeout 时为 `null`）。

### compare

`compare` 读取两份 collect JSON，比较同一命令的基线与候选样本。

- `--baseline` / `--candidate`：两份 collect 输出文件，必填。
- `--output`：比较结果 JSON 输出文件，必填。
- `--alpha`：显著性水平，`0 < alpha < 1`，缺省 `0.05`。
- `--min-change-percent`：回归/改进判定的变化阈值（百分比），`>= 0`，缺省 `5`。

输入校验（任一不满足即退出码 2，stderr 输出一条原因，不创建或改写 `--output`）：

- 仅使用 `samples` 中 `exit_code` 为 0 的样本的 `duration_ns`；
- 每边有效样本至少 2 个，且 `duration_ns` 均为非负安全整数；
- 两份输入的 `unit` 均为 `"ns"`，`command` 完全一致。

比较结果固定含六个顶层字段：

- `baseline_summary` / `candidate_summary`：按 collect summary 七项口径
  （`count`、`min`、`max`、`mean`、`median`、`p95`、`stddev`）对有效样本重算。
- `delta`：`mean`、`median`、`p95`、`stddev` 四项，每项含
  `ns`（候选减基线差值）与 `percent`（相对基线百分比，六位小数）。
  基线为 0 时：候选同为 0 记 `percent: 0`，仅基线为 0 记 `percent: null`。
- `welch`：双侧 Welch t 检验，含 `t_statistic`（候选减基线方向）、
  `degrees_of_freedom`、`p_value`，浮点保留六位小数；
  `p_value <= alpha` 判定为显著。两边样本方差均为 0 时：
  均值相同为 `{0, null, 1}`，均值不同为 `{null, null, 0}`。
- `decision`：`regression`（显著增加且达到阈值）、`improvement`
  （显著减少且达到阈值）、`no_material_change`（显著但未达阈值）、
  `not_significant`（不显著）。阈值按 `delta.mean.percent` 判定。
- `attribution`：`central_tendency_percent`、`tail_latency_percent`、
  `variability_percent` 分别对应 mean、p95、stddev 的变化百分比；
  `dominant_factor` 取三者中最大正向项的字段名，平手按上述顺序，
  无正向值时为 `none`。

退出码：成功 `0`；参数或输入无效 `2`；`--output` 写入失败 `4`。

## 约定

- 公开行为以 README 与源码为准。
- 后续需求在此基线上增量实现。
- 测试：`node --test`（使用内置 `node:test`，无第三方依赖）。
