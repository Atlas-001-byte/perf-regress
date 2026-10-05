# Perf Regress

性能基准与回归检测服务：基准采集、统计显著性与回归归因。

## 范围

本仓库从零开始实现上述方向的可用工具，不依赖外部同类实现。

## 状态

已实现：基准采集子命令 `perf-regress collect`、批量采集子命令
`perf-regress collect-suite`、比较子命令 `perf-regress compare`
与套件比较子命令 `perf-regress compare-suite`（零依赖 Node.js）。

## 用法

需要 Node.js（无第三方依赖）：

```sh
node bin/perf-regress.js collect \
  --command '<被测命令>' \
  --runs <统计次数> \
  --warmup <预热次数> \
  --timeout-ms <单次超时毫秒> \
  --output <结果.json>

node bin/perf-regress.js collect-suite \
  --manifest <manifest.json> \
  --output <套件采集结果.json>

node bin/perf-regress.js compare \
  --baseline <基线.json> \
  --candidate <候选.json> \
  --output <比较结果.json> \
  [--alpha <显著性水平>] \
  [--min-change-percent <阈值百分比>]

node bin/perf-regress.js compare-suite \
  --manifest <manifest.json> \
  --output <套件结果.json> \
  [--alpha <显著性水平>] \
  [--min-change-percent <阈值百分比>]
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

## collect-suite 子命令

按 manifest 顺序批量采集多个 case：case 间不并发，case 内先顺序执行全部
warmup、再顺序执行全部 runs。每次执行沿用 collect 的超时、启动失败分类与
丢弃 stdout/stderr 语义；`samples`、`summary`、`errors` 的字段口径与 collect
完全一致。

- `--manifest`：套件 manifest JSON，必填，非空。
- `--output`：套件采集结果 JSON 输出文件，必填，非空。
- 参数同时支持 `--key value` 与 `--key=value` 两种写法。

### manifest 格式（UTF-8 JSON）

顶层为对象，`cases` 为非空数组，每项必须含：

- `name`：非空字符串，在 cases 中唯一；
- `command`：被测命令，经系统 shell 执行，非空字符串；
- `runs`：计入统计的执行次数，整数且 `>= 1`；
- `warmup`：预热次数，整数且 `>= 0`；
- `timeout_ms`：单次执行超时毫秒数，整数且 `>= 1`。

未知字段一律忽略。manifest 不是合法 JSON、顶层不是对象、cases 不是非空数组、
任一 case 字段不合上述口径（含 name 重复）时，stderr 输出一条原因、退出码 2，
不创建或改写 `--output`。

执行语义（按 cases 顺序）：

- warmup 的 nonzero_exit/timeout 只记入该 case 的 `errors`，不影响 `status`；
- measure 的 nonzero_exit/timeout 跳过本次并记入 `errors`，继续该 case 剩余测量；
- 任一执行进程无法启动（spawn 失败或 shell 退出码 126/127）时，stderr 报告启动
  失败、整体退出码 2，且不创建或改写 `--output`。

### 输出 JSON（UTF-8）

顶层固定字段：`cases`、`suite_summary`。

- `cases`：按 manifest 顺序排列，每项含 `name`、`command`、`runs`、`warmup`、
  `timeout_ms`、`unit`、`samples`、`summary`、`errors`、`status`，`unit` 恒为
  `"ns"`；其中 `samples`/`summary`/`errors` 与 collect 口径一致（含六位浮点与
  空样本 summary 为全 `null`）。
  - `status`：该 case 无 measure 阶段错误时为 `ok`，否则为 `measure_errors`
    （warmup 错误不影响 status）。
- `suite_summary`：含 `total`、`ok`、`measure_errors`、`sample_count`、
  `error_count`，依次为 case 总数、无测量错误的 case 数、有测量错误的 case 数、
  全部 case 有效样本总数、全部 case 错误总数。

退出码：无测量错误写文件后退出 0；存在 measure 阶段错误时仍写完整文件、退出 3；
进程无法启动退出 2（不写 output）；`--output` 写入失败退出 4。

## compare 子命令

比较两份 collect JSON 中同一命令的基线与候选样本，输出显著性、回归判定与变化归因。

- `--baseline` / `--candidate`：两份 collect 输出 JSON，必填。
- `--output`：比较结果 JSON 输出文件，必填。
- `--alpha`：显著性水平，`0 < alpha < 1`，缺省 `0.05`。
- `--min-change-percent`：回归/改进判定的变化幅度阈值（百分比），`>= 0`，缺省 `5`。

比较口径：

- 只使用 `samples` 中 `exit_code` 为 0 的样本的 `duration_ns`，
  按 collect summary 七项口径重算两边 summary（不采用输入文件中的 summary）。
- 输入无效时 stderr 输出一条原因、退出码 2，不创建或改写 `--output`：
  每边有效样本至少 2 个；`duration_ns` 须为非负安全整数；`unit` 须为 `"ns"`；
  两份输入的 `command` 须完全一致；文件须为合法 JSON。
- 成功退出码 0；`--output` 写入失败退出码 4。

### 输出 JSON（UTF-8）

顶层固定字段：`baseline_summary`、`candidate_summary`、`delta`、`welch`、`decision`、`attribution`。

- `baseline_summary` / `candidate_summary`：与 collect summary 相同的七项。
- `delta`：`mean`、`median`、`p95`、`stddev` 四项，每项含
  `ns`（候选减基线差）与 `percent`（相对基线百分比）。
  基线为 0 且候选为 0 时 `percent` 为 0；仅基线为 0 时 `percent` 为 `null`。
- `welch`：双侧 Welch t 检验，含 `t_statistic`、`degrees_of_freedom`、`p_value`，
  浮点保留六位小数；`p_value <= alpha` 为显著。
  两边方差均为 0 时：均值相同三者依次为 `0`、`null`、`1`；
  均值不同依次为 `null`、`null`、`0`。
- `decision`：四选一 —
  - `regression`：显著且 mean 增幅达到 `--min-change-percent`；
  - `improvement`：显著且 mean 降幅达到 `--min-change-percent`；
  - `no_material_change`：显著但未达阈值；
  - `not_significant`：不显著。
  基线均值为 0 而候选非 0（`percent` 为 `null`）时视为达到阈值的增加。
- `attribution`：`central_tendency_percent`、`tail_latency_percent`、
  `variability_percent` 分别对应 mean、p95、stddev 的变化百分比；
  `dominant_factor` 取三者中最大正向项（`central_tendency` / `tail_latency` /
  `variability`），平手按此顺序，百分比为 `null` 视为无穷大正向，
  无正向值为 `none`。

## compare-suite 子命令

按 manifest 批量比较多对 collect JSON：每对输入按 compare 口径重算并做
Benjamini–Hochberg（BH）多重比较校正，输出逐 case 结果、套件汇总与套件归因。

- `--manifest`：套件 manifest JSON，必填，非空。
- `--output`：套件结果 JSON 输出文件，必填，非空。
- `--alpha`：显著性水平，`0 < alpha < 1`，缺省 `0.05`。
- `--min-change-percent`：回归/改进判定的变化幅度阈值（百分比），`>= 0`，缺省 `5`。
- 参数同时支持 `--key value` 与 `--key=value` 两种写法。

### manifest 格式（UTF-8 JSON）

顶层为对象，`cases` 为非空数组，每项必须含：

- `name`：非空字符串，在 cases 中唯一；
- `baseline` / `candidate`：基线/候选 collect JSON 路径，非空字符串；
  相对路径按 manifest 文件所在目录解析。

manifest、case、字段、路径、文件或输入样本不合上述口径时，stderr 输出一条原因、
退出码 2，不创建或改写 `--output`；每个 case 的样本校验沿用 compare
（每侧至少 2 个有效样本，同场景 `command` 一致）。成功退出码 0；
`--output` 写入失败退出码 4。

### 输出 JSON（UTF-8）

顶层固定字段：`cases`、`suite_summary`、`suite_attribution`。

- `cases`：按 manifest 顺序排列，每项在 compare 输出口径上增加
  `adjusted_p_value`，字段为 `name`、`command`、`baseline_summary`、
  `candidate_summary`、`delta`、`welch`、`adjusted_p_value`、`decision`、
  `attribution`。
  - 统计量、Welch（含零方差与基线均值 0 的退化情形）、归因口径与 compare 完全一致；
  - `adjusted_p_value`：m 个原始 p 值升序后记 p_(1)<=...<=p_(m)，按
    q_(i) = min(1, min over j>=i (m·p_(j)/j)) 计算后映回原序，保留六位小数；
  - `decision`：沿用 compare 四类值，但以 `adjusted_p_value <= alpha` 判显著，
    再按 mean 百分比与阈值选择。
- `suite_summary`：含 `total` 与四类计数（`regression`、`improvement`、
  `no_material_change`、`not_significant`）及 `suite_decision`；
  `suite_decision` 按优先级取 case decision：
  `regression` > `improvement` > `no_material_change` > `not_significant`。
- `suite_attribution`：`central_tendency_percent`、`tail_latency_percent`、
  `variability_percent` 取各 case 对应百分比（compare 三个字段）的中位数，
  `null` 按正无穷参与比较，中位数为正无穷时写 `null`；
  `dominant_factor` 按 compare 归因顺序取三个中位数中的最大正值，
  平手按该顺序，无正值为 `none`。

## 约定

- 公开行为以 README 与源码为准。
- 后续需求在此基线上增量实现。
- 测试：`node --test`（使用内置 `node:test`，无第三方依赖）。
