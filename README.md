# Perf Regress

性能基准与回归检测服务：基准采集、统计显著性与回归归因。

## 范围

本仓库从零开始实现上述方向的可用工具，不依赖外部同类实现。

## 状态

已实现：基准采集子命令 `perf-regress collect`、套件批量采集子命令
`perf-regress collect-suite`、比较子命令 `perf-regress compare`
与套件比较子命令 `perf-regress compare-suite`、系列回归定位子命令
`perf-regress compare-series`，以及交错 A/B 采集与即时比较子命令
`perf-regress ab`、多场景交错 A/B 套件子命令
`perf-regress ab-suite`、配对交错 A/B 子命令
`perf-regress ab-paired`、多场景配对交错 A/B 套件子命令
`perf-regress ab-paired-suite`（零依赖 Node.js）。
另有供程序化调用的回归分组归因库 `lib/regression-attribution.js`
（Mann-Whitney U + Holm，纯函数、不读写文件、不新增子命令）。

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

node bin/perf-regress.js compare-series \
  --manifest <manifest.json> \
  --output <系列结果.json> \
  [--alpha <显著性水平>] \
  [--min-change-percent <阈值百分比>]

node bin/perf-regress.js ab \
  --baseline-command '<基线命令>' \
  --candidate-command '<候选命令>' \
  --runs <统计次数> \
  --warmup <预热次数> \
  --timeout-ms <单次超时毫秒> \
  --output <结果.json> \
  [--alpha <显著性水平>] \
  [--min-change-percent <阈值百分比>]

node bin/perf-regress.js ab-suite \
  --manifest <manifest.json> \
  --output <套件结果.json> \
  [--alpha <显著性水平>] \
  [--min-change-percent <阈值百分比>]

node bin/perf-regress.js ab-paired \
  --baseline-command '<基线命令>' \
  --candidate-command '<候选命令>' \
  --runs <统计次数> \
  --warmup <预热次数> \
  --timeout-ms <单次超时毫秒> \
  --output <结果.json> \
  [--alpha <显著性水平>] \
  [--min-change-percent <阈值百分比>]

node bin/perf-regress.js ab-paired-suite \
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
| 0 | 全部成功（collect：samples 数量等于 runs；collect-suite：无测量错误） |
| 2 | 参数无法解析/越界、command/output/manifest 无效、进程无法启动；不创建或改写 output |
| 3 | measure 阶段存在 nonzero_exit 或 timeout（仍写 JSON，出错的执行被跳过） |
| 4 | output 写入失败 |

warmup 阶段的 nonzero_exit/timeout 只记录到 `errors`，不影响退出码；
进程无法启动按 `nonzero_exit` 处理而非 `timeout`，且属退出码 2 的致命错误。
collect-suite 中任一 case 进程无法启动即整体退出 2，不创建或改写 output。

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

按 manifest 顺序批量采集多个基准场景：按 `cases` 顺序逐个采集，case 内先顺序
执行全部 warmup 再顺序执行全部 runs，case 间不并发。超时、启动失败分类、丢弃
stdout/stderr、samples/summary/errors 字段口径均与 collect 相同。

- `--manifest`：套件 manifest JSON（UTF-8），必填，非空。
- `--output`：套件采集结果 JSON 输出文件，必填，非空。
- 参数同时支持 `--key value` 与 `--key=value` 两种写法。

### manifest 格式（UTF-8 JSON）

顶层为对象，`cases` 为非空数组，每项必须含：

- `name`：非空字符串，在 cases 中唯一；
- `command`：被测命令，经系统 shell 执行，非空字符串；
- `runs`：整数，`>= 1`；
- `warmup`：整数，`>= 0`；
- `timeout_ms`：整数，`>= 1`。

未知字段一律忽略。执行前完整校验：参数或清单不合上述口径时 stderr 输出一条
原因、退出码 2，不创建或改写 `--output`。

### 执行与错误口径

- 退出码 0 的执行进入该 case 的 `samples`；
- warmup 的 nonzero_exit/timeout 只记入 `errors`；
- measure 阶段的 nonzero_exit/timeout 跳过该次并记入 `errors`，继续剩余测量；
- 进程无法启动（spawn 失败或 shell 126/127）属致命错误：stderr 报告启动失败、
  退出码 2，不创建或改写 `--output`；
- 无测量错误时写文件并退出 0；存在测量错误时写完整文件并退出 3；
  `--output` 写入失败退出码 4。

### 输出 JSON（UTF-8）

顶层固定字段：`cases`、`suite_summary`。

- `cases`：按 manifest 顺序排列，每项含 `name`、`command`、`runs`、`warmup`、
  `timeout_ms`、`unit`、`samples`、`summary`、`errors`、`status`；
  `unit` 恒为 `"ns"`，`samples`/`summary`/`errors` 与 collect 口径一致
  （含六位浮点与空样本 summary 口径）。
  - `status`：该 case 无测量错误时为 `ok`，否则为 `measure_errors`
    （仅有 warmup 错误时仍为 `ok`）。
- `suite_summary`：含
  - `total`：case 总数；
  - `ok`：无测量错误的 case 数；
  - `measure_errors`：有测量错误的 case 数；
  - `sample_count`：所有 case 的有效样本总数；
  - `error_count`：所有 case 的错误总数（含 warmup 错误）。

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
  - `mean` 另含 `confidence_interval`：候选均值减基线均值差的双侧 Welch
    区间，字段为 `level`、`lower_ns`、`upper_ns`、`lower_percent`、
    `upper_percent`，数值保留六位小数。
    - `level` 等于 `1 - alpha`（默认 alpha 为 0.05 时即 `0.95`）；
    - `lower_ns` / `upper_ns` 为差值的区间两端
      （差 ± 临界值 t*·sqrt(v1/n1 + v2/n2)，t* 为 t 分布自由度
      (v1/n1 + v2/n2)² / ((v1/n1)²/(n1-1) + (v2/n2)²/(n2-1)) 的双侧分位点）；
    - `lower_percent` / `upper_percent` 由两端**分别**除以基线均值再乘 100，
      因此不围绕点估计对称；基线均值为 0 时两个百分比端点均为 `null`；
    - 两侧方差均为 0 时区间退化为单点：均值相同则两端均为 0，
      均值不同则两端均为候选减基线均值；该退化不改变 Welch 与 decision 口径。
    - alpha 只决定区间 `level`（及端点），不影响 `welch`、`decision`、
      `attribution` 等任何既有字段。
  - `median`、`p95`、`stddev` 不提供 `confidence_interval`。
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
    `delta.mean.confidence_interval` 定义也与 compare 完全相同，`level = 1 - alpha`；
    alpha 只影响该区间，不影响原始 p 值、`adjusted_p_value`、`decision`、
    `suite_summary` 或 `suite_attribution`；
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

## compare-series 子命令

按 manifest 为每个 case 固定一条 baseline，对其有序候选序列逐个按 compare
口径重算，全部候选（跨所有 case）的原始 p 值统一做一次
Benjamini–Hochberg（BH）多重比较校正，输出逐 case 的候选结果、回归起点、
候选序列趋势分析、套件汇总、套件归因与跨 case 时间线汇总，用于定位候选
序列相对固定 baseline 的回归起点及其持续/暂态形态。

- `--manifest`：系列 manifest JSON（UTF-8），必填，非空。
- `--output`：系列结果 JSON 输出文件，必填，非空。
- `--alpha`：显著性水平，`0 < alpha < 1`，缺省 `0.05`。
- `--min-change-percent`：回归/改进判定的变化幅度阈值（百分比），`>= 0`，缺省 `5`。
- 参数同时支持 `--key value` 与 `--key=value` 两种写法。

### manifest 格式（UTF-8 JSON）

顶层为对象，`cases` 为非空数组，每项必须含：

- `name`：非空字符串，在 cases 中唯一；
- `baseline`：固定基线 collect JSON 路径，非空字符串；
- `candidates`：候选 collect JSON 路径的非空有序数组，每项为非空字符串；
  数组顺序即候选序列顺序（输出 `index` 从 0 起）。
  相对路径按 manifest 文件所在目录解析。

manifest、case、字段、路径、文件或输入样本不合上述口径时，stderr 输出一条原因、
退出码 2，不创建或改写 `--output`；每个 baseline/候选的样本校验沿用 compare
（每侧至少 2 个有效样本，case 内 baseline 与每个候选的 `command` 一致），
collect 报告的 errors 不参与统计。成功退出码 0；结果序列化或 `--output`
写入失败退出码 4。

### 输出 JSON（UTF-8）

顶层固定字段：`cases`、`suite_summary`、`suite_attribution`、`timeline_summary`。

- `cases`：按 manifest 顺序排列，每项含 `name`、`command`、`baseline_summary`、
  `candidates`、`first_regression_index`、`trend_analysis`。
  - `baseline_summary`：固定 baseline 按 collect summary 七项口径重算的结果；
  - `candidates`：与 manifest `candidates` 同序，每项在 compare-suite case
    输出的统计字段上增加 `candidate`、`index`，字段顺序为 `candidate`、`index`、
    `baseline_summary`、`candidate_summary`、`delta`、`welch`、
    `adjusted_p_value`、`decision`、`attribution`；
    `candidate` 回显 manifest 中该候选的路径串，`index` 为其在序列中的下标
    （从 0 起）；统计量、Welch（含零方差与基线均值 0 的退化情形）、
    delta、归因口径与 compare 完全一致，baseline 为该 case 的固定 baseline；
    每个候选的 `delta.mean.confidence_interval` 定义也与 compare 完全相同，
    `level = 1 - alpha`；alpha 只影响该区间，不影响 p 值、BH 校正、
    `decision`、`first_regression_index`、`suite_summary` 或
    `suite_attribution`；
  - `adjusted_p_value`：对全部候选的原始 p 值统一按 compare-suite 的 BH
    口径校正（m 为全部候选总数）后映回各候选，保留六位小数；
  - `decision`：沿用 compare 四类值，以 `adjusted_p_value <= alpha` 判显著，
    再按 mean 百分比与阈值选择；
  - `first_regression_index`：候选序列中首个 `decision` 为 `regression`
    的 `index`；没有任何 regression 时为 `null`。
  - `trend_analysis`：该 case 候选序列的趋势分析，固定含
    `regression_runs`、`persistent_regression_start_index`、
    `transient_regression_runs`、`attribution_transitions`、`case_attribution`。
    - `regression_runs`：候选序列中连续 `regression` 的最大段，按序列顺序
      排列，每段依次含 `start_index`、`end_index`、`extends_to_end`
      （`end_index` 是否为序列最后一个 `index`）；无 regression 时为 `[]`；
    - `persistent_regression_start_index`：`extends_to_end` 为 `true` 的段
      （持续段，至多一个）的 `start_index`；无持续段时为 `null`；
    - `transient_regression_runs`：其余（未延伸到末尾的）段，每项含
      `start_index`、`end_index`、`recovery_index`（段后首个 `index`，
      即 `end_index + 1`）；无暂态段时为 `[]`；
    - `attribution_transitions`：相邻候选 `attribution.dominant_factor`
      发生变化的列表，每项含 `from_index`、`to_index`、`from_factor`、
      `to_factor`（`none` 与其他因子间的双向变化均计入）；无变化时为 `[]`；
    - `case_attribution`：有持续段时，取该段各候选归因百分比
      （`central_tendency_percent`、`tail_latency_percent`、
      `variability_percent`）的中位数（`null` 按正无穷参与比较，中位数为
      正无穷时写 `null`），`dominant_factor` 取三个中位数中的最大正值，
      平手按 central_tendency / tail_latency / variability 顺序，
      无正值为 `none`；无持续段时四项均为 `null`。
- `suite_summary`：含 `total_cases`、`total_candidates` 与四类计数
  （`regression`、`improvement`、`no_material_change`、`not_significant`，
  统计全部候选）及 `suite_decision`；`suite_decision` 按优先级取候选 decision：
  `regression` > `improvement` > `no_material_change` > `not_significant`。
- `suite_attribution`：聚合全部候选（跨所有 case），口径与 compare-suite
  完全一致：三个百分比取各候选对应归因百分比的中位数，`null` 按正无穷参与
  比较，中位数为正无穷时写 `null`；`dominant_factor` 按 compare 归因顺序
  取三个中位数中的最大正值，平手按该顺序，无正值为 `none`。
- `timeline_summary`：跨 case 的时间线汇总，固定含
  - `total_cases`：case 总数；
  - `cases_with_persistent_regression`：有持续段（`extends_to_end` 的
    regression 段）的 case 数；兼有持续段与暂态段的 case 只计入本类；
  - `cases_with_only_transient_regression`：有 regression 段但无持续段的
    case 数；
  - `cases_without_regression`：没有任何 regression 段的 case 数；
  - `persistent_regression_start_indices`：按 case 顺序列出有持续段的
    case，每项含 `name`、`start_index`（即该 case 的
    `persistent_regression_start_index`）；
  - `suite_dominant_factor`：取各 case `case_attribution.dominant_factor`
    非 `null` 值中频次最高者，平手按
    central_tendency / tail_latency / variability / none 顺序；
    没有任何非 `null` 值时为 `none`。

## ab 子命令

交错 A/B 基准采集与即时比较：基线与候选在同批交替测量，减少时间漂移对
比较的影响。

- `--baseline-command` / `--candidate-command`：基线/候选命令，经系统 shell
  执行，必填，非空。
- `--runs`：每侧计入统计的执行次数，整数且 `>= 2`，必填。
- `--warmup`：每侧预热次数，整数且 `>= 0`，缺省 `0`。
- `--timeout-ms`：单次执行超时毫秒数，整数且 `>= 1`，必填。
- `--output`：唯一 JSON 输出文件路径，必填，非空。
- `--alpha`：显著性水平，`0 < alpha < 1`，缺省 `0.05`。
- `--min-change-percent`：回归/改进判定阈值（百分比），`>= 0`，缺省 `5`。
- 参数同时支持 `--key value` 与 `--key=value` 两种写法。

执行顺序：先完成全部预热再测量；预热和测量均按轮次交错，每轮先 baseline
后 candidate，全程串行。单次执行、丢弃 stdout/stderr、samples/summary/errors
口径与 collect 相同，`errors` 的 `index` 在本侧从 0 计数。

### 执行与错误口径

- warmup 的 nonzero_exit/timeout 只记入该侧 `errors`；
- measure 阶段的 nonzero_exit/timeout 跳过该次并记入 `errors`，继续剩余测量；
- 进程无法启动（spawn 失败或 shell 126/127）属致命错误：stderr 报告启动失败、
  退出码 2，不创建或改写 `--output`；
- 单侧超时或失败不影响另一侧及后续轮次；
- 参数无法解析/越界时 stderr 输出一条原因、退出码 2，不创建或改写 `--output`；
- 存在 measure 错误或任一侧有效样本（exit_code 为 0）少于 2 时，写完整 JSON
  并退出码 3；无这些问题时退出码 0；`--output` 写入失败退出码 4。

### 输出 JSON（UTF-8）

顶层固定字段：`baseline`、`candidate`、`comparison`。

- `baseline` / `candidate`：各含 `command`、`runs`、`warmup`、`timeout_ms`、
  `unit`、`samples`、`summary`、`errors`，口径与 collect 输出一致
  （`unit` 恒为 `"ns"`）。
- `comparison`：两侧都至少有两个 exit_code 为 0 的样本时，为 compare 输出
  口径的对象，含 `baseline_summary`、`candidate_summary`、`delta`、`welch`、
  `decision`、`attribution`（Welch 双侧检验与现有阈值产生四类决策），
  其 `delta.mean.confidence_interval` 定义与 compare 完全相同、
  `level = 1 - alpha`；否则为 `null`（此时不含任何区间字段）。

## ab-suite 子命令

多场景交错 A/B：按 manifest 顺序串行执行多个 ab 场景，逐 case 沿用 ab 的
交错口径（先两侧全部预热，再两侧交错测量，每轮先 baseline_command 后
candidate_command，输出丢弃），并对具可比性的 case 统一做
Benjamini–Hochberg（BH）多重比较校正，输出逐 case 结果、套件汇总与套件归因。

- `--manifest`：套件 manifest JSON（UTF-8），必填，非空。
- `--output`：套件结果 JSON 输出文件，必填，非空。
- `--alpha`：显著性水平，`0 < alpha < 1`，缺省 `0.05`。
- `--min-change-percent`：回归/改进判定的变化幅度阈值（百分比），`>= 0`，缺省 `5`。
- 参数同时支持 `--key value` 与 `--key=value` 两种写法。

### manifest 格式（UTF-8 JSON）

顶层为对象，`cases` 为非空数组，每项必须含：

- `name`：非空字符串，在 cases 中唯一；
- `baseline_command` / `candidate_command`：基线/候选命令，经系统 shell
  执行，非空字符串；
- `runs`：每侧计入统计的执行次数，整数且 `>= 2`（沿用 ab 口径）；
- `warmup`：每侧预热次数，整数且 `>= 0`；
- `timeout_ms`：单次执行超时毫秒数，整数且 `>= 1`。

未知字段一律忽略。执行前完整校验：参数或清单不合上述口径时 stderr 输出一条
原因、退出码 2，不创建或改写 `--output`。

### 执行与错误口径

- case 按 manifest 顺序串行，case 间不并发；
- warmup 的 nonzero_exit/timeout 只记入该侧 `errors`；
- measure 的 nonzero_exit/timeout 跳过该次并记入 `errors`，继续剩余测量；
- 单侧异常不影响另一侧、后续轮次与后续 case；
- 进程无法启动（spawn 失败或 shell 126/127）属致命错误：stderr 报告启动失败、
  退出码 2，不创建或改写 `--output`（即使此前已有 case 执行完成）；
- 存在普通测量错误，或任一 case 任一侧有效样本（exit_code 为 0）少于 2 时，
  写完整 JSON 并退出 3；否则退出 0；`--output` 写入失败退出码 4。

### 输出 JSON（UTF-8）

顶层固定字段：`cases`、`suite_summary`、`suite_attribution`。

- `cases`：按 manifest 顺序排列，每项在 ab 顶层口径上增加
  `name`、`adjusted_p_value`、`decision`，其余字段不变，即字段顺序为
  `name`、`baseline`、`candidate`、`comparison`、`adjusted_p_value`、
  `decision`；`baseline`/`candidate` 与 ab 完全一致。
  - `comparison` 非 null 时与 ab 的 `comparison` 完全一致（其 `decision`
    以原始 p 值按 compare 口径判定，`delta.mean.confidence_interval`
    同样为 `level = 1 - alpha` 的 Welch 区间，alpha 不改变 p 值、
    BH 校正、decision、suite_summary、suite_attribution）；
  - `adjusted_p_value` 与顶层 `decision` 沿用 compare-suite 的 BH 校正口径：
    仅对 `comparison` 非 null 的 case 的原始 p 值做 BH 校正，以
    `adjusted_p_value <= alpha` 判显著，再按 mean 百分比与
    `--min-change-percent` 选择四类 decision；
  - `comparison` 为 null 时 `adjusted_p_value` 与 `decision` 均为 `null`。
- `suite_summary`：含
  - `total`：case 总数；
  - `comparable`：`comparison` 非 null 的 case 数；
  - `incomplete`：`comparison` 为 null 的 case 数；
  - `suite_decision`：只统计非 null comparison，按优先级
    `regression` > `improvement` > `no_material_change` >
    `not_significant`；没有具可比性 case 时为 `incomplete`。
- `suite_attribution`：只汇总 `comparison` 非 null 的 case，口径与
  compare-suite 完全一致：三个百分比取各 case 对应归因百分比的中位数
  （`null` 按正无穷参与比较，中位数为正无穷时写 `null`），
  `dominant_factor` 取三个中位数中的最大正值，平手按
  central_tendency / tail_latency / variability 顺序，无正值为 `none`；
  没有具可比性 case 时三项百分比均为 `null`、`dominant_factor` 为 `none`。

## ab-paired 子命令

配对交错 A/B：执行口径与 ab 完全相同（先全部预热，再逐轮先 baseline 后
candidate，全程串行，输出丢弃），但比较时按轮次配对——同一轮两侧均退出 0
才构成一对，对逐对差值（候选减基线）做配对 t 检验与回归判定，进一步消除
轮次间环境漂移的影响。

- `--baseline-command` / `--candidate-command`：基线/候选命令，经系统 shell
  执行，必填，非空。
- `--runs`：每侧计入统计的执行次数，整数且 `>= 2`，必填。
- `--warmup`：每侧预热次数，整数且 `>= 0`，缺省 `0`。
- `--timeout-ms`：单次执行超时毫秒数，整数且 `>= 1`，必填。
- `--output`：唯一 JSON 输出文件路径，必填，非空。
- `--alpha`：显著性水平，`0 < alpha < 1`，缺省 `0.05`。
- `--min-change-percent`：回归/改进判定阈值（百分比），`>= 0`，缺省 `5`。
- 参数同时支持 `--key value` 与 `--key=value` 两种写法。

### 执行与错误口径

- 与 ab 一致：warmup 的 nonzero_exit/timeout 只记入该侧 `errors`；measure
  阶段的 nonzero_exit/timeout 跳过该次并记入 `errors`，继续剩余测量；
  单侧异常不影响另一侧及后续轮次；
- 进程无法启动（spawn 失败或 shell 126/127）属致命错误：stderr 报告启动失败、
  退出码 2，不创建或改写 `--output`；
- 参数无法解析/越界时 stderr 输出一条原因、退出码 2，不创建或改写 `--output`；
- 存在 measure 错误或完整 pairs 少于 2 时，写完整 JSON 并退出码 3；
  无这些问题时退出码 0；`--output` 写入失败退出码 4。

### 输出 JSON（UTF-8）

顶层固定字段：`baseline`、`candidate`、`paired`。

- `baseline` / `candidate`：与 ab 完全一致的逐侧采集报告（`command`、
  `runs`、`warmup`、`timeout_ms`、`unit`、`samples`、`summary`、`errors`）。
- `paired`：配对比较结果，含 `pairs`、`summary`、`t_test`、
  `confidence_interval`、`decision`、`attribution`。
  - `pairs`：完整对（同轮两侧均退出 0），按轮次排列，每项含 `index`
    （轮次序号）、`baseline_duration_ns`、`candidate_duration_ns`、
    `delta_ns`（候选减基线）；
  - `summary`：对 `delta_ns` 的五项汇总 `count`、`mean`、`median`、
    `p95`、`stddev`（口径与 collect summary 相同，浮点保留六位小数）；
    空样本时除 `count` 外均为 `null`；
  - `t_test`：双侧配对 t 检验，含 `t_statistic`、`degrees_of_freedom`、
    `p_value`；`t_statistic = mean / (sample_stddev / sqrt(count))`
    （sample_stddev 为无偏样本标准差），`degrees_of_freedom = count - 1`；
    差值零方差时退化口径与 Welch 一致：均值差为 0 三者依次为
    `0`、`null`、`1`，均值差非 0 依次为 `null`、`null`、`0`；
  - `confidence_interval`：配对均值差的双侧 `1 - alpha` 区间，字段为
    `level`、`lower_ns`、`upper_ns`、`lower_percent`、`upper_percent`；
    百分比端点由两端分别除以成对基线均值再乘 100，基线均值为 0 时两个
    百分比端点为 `null`；差值零方差时区间退化为单点；
  - `decision`：沿用 compare 四类值，以 `t_test.p_value <= alpha` 判显著，
    再按 mean 百分比（成对候选均值相对成对基线均值）与
    `--min-change-percent` 选择；基线均值为 0 而候选非 0 视为达到阈值的增加；
  - `attribution`：对成对样本按 compare 口径给出的归因
    （`central_tendency_percent`、`tail_latency_percent`、
    `variability_percent`、`dominant_factor`）；
  - 完整 pairs 少于 2 时 `t_test`、`confidence_interval`、`decision`
    均为 `null`（`summary.count` 仍为完整对数）；无任何完整对时
    `attribution` 三项百分比均为 `null`、`dominant_factor` 为 `none`。

## ab-paired-suite 子命令

多场景配对交错 A/B：按 manifest 顺序串行执行多个 ab-paired 场景，逐 case
沿用 ab-paired 的交错配对口径（先两侧全部预热，再两侧交错测量，每轮先
baseline_command 后 candidate_command，同轮两侧均退出 0 才配成一对，输出丢弃），
并对完整 pairs 不少于 2 的可比较 case 统一做 Benjamini–Hochberg（BH）多重比较
校正，输出逐 case 结果、套件汇总与套件归因。

- `--manifest`：套件 manifest JSON（UTF-8），必填，非空，格式与 ab-suite 相同。
- `--output`：套件结果 JSON 输出文件，必填，非空。
- `--alpha`：显著性水平，`0 < alpha < 1`，缺省 `0.05`。
- `--min-change-percent`：回归/改进判定的变化幅度阈值（百分比），`>= 0`，缺省 `5`。
- 参数同时支持 `--key value` 与 `--key=value` 两种写法。

manifest 校验口径（非空唯一 `name`、非空 `baseline_command`/`candidate_command`、
`runs >= 2`、`warmup >= 0`、`timeout_ms >= 1`，未知字段忽略）与 ab-suite 完全一致；
执行与错误口径（case 串行、warmup 错误只记录、measure 错误跳过、进程无法启动
为致命错误退出码 2 且不写 output）也与 ab-suite 相同。

### 输出 JSON（UTF-8）

顶层固定字段：`cases`、`suite_summary`、`suite_attribution`。

- `cases`：按 manifest 顺序排列，每项字段顺序为 `name`、`baseline`、`candidate`、
  `paired`、`adjusted_p_value`、`decision`；`baseline`/`candidate` 与 ab 完全一致，
  `paired` 与 ab-paired 的同名对象完全一致（其 `decision` 以原始配对 p 值按
  compare 口径判定，不受 BH 影响）。
  - 仅完整 pairs 不少于 2 的 case 可比较：`adjusted_p_value` 为其原始
    `paired.t_test.p_value` 经跨可比较 case 的 BH 校正值，顶层 `decision`
    沿用 compare-suite 口径，以 `adjusted_p_value <= alpha` 判显著后再按
    mean 百分比（成对候选均值相对成对基线均值）与 `--min-change-percent` 选择；
  - 完整 pairs 少于 2 的 case 不可比较：`paired` 仍照常写出（含 `pairs` 与
    `summary.count`，但 `t_test`、`confidence_interval`、`paired.decision`
    为 `null`；无完整对时 `attribution` 三项为 `null`、`dominant_factor` 为
    `none`），顶层 `adjusted_p_value` 与 `decision` 均为 `null`，不参与 BH 校正。
- `suite_summary`：字段沿用 compare-suite——`total`、`regression`、`improvement`、
  `no_material_change`、`not_significant`（均只统计可比较 case 的顶层 decision）、
  `suite_decision`；优先级为 `regression` > `improvement` > `no_material_change` >
  `not_significant`；全部 case 不可比较时 `suite_decision` 为 `incomplete`。
- `suite_attribution`：只汇总可比较 case 的 `paired.attribution`，口径与
  compare-suite 完全一致：三个百分比取各 case 对应归因百分比的中位数
  （`null` 按正无穷参与比较，中位数为正无穷时写 `null`），
  `dominant_factor` 取三个中位数中的最大正值，平手按
  central_tendency / tail_latency / variability 顺序，无正值为 `none`；
  全部 case 不可比较时三项百分比均为 `null`、`dominant_factor` 为 `none`。
- 退出码：存在 measure 错误或任一 case 完整 pairs 少于 2 时写完整 JSON 并退出 3；
  否则退出 0；`--output` 写入失败退出码 4。

## 回归分组归因（库 API）

`lib/regression-attribution.js` 在**既有比较结论之上**做增量归因：对一次
已判定的比较，按分类维度（如 `build`、`host`、`scenario`）独立归因，
指出最值得继续排查的样本分组。它是纯函数库：

- 不新增 CLI 子命令，不改变任何现有子命令的入口调用方式、输入输出字段、
  字段顺序、样本筛选口径、显著性判定、回归阈值或无归因时的检测结论；
- 只有调用方显式调用 `attributeRegression` 时才进行归因计算；
- 不执行命令、不读写文件，不新增任何落盘行为。

```js
const {
  attributeRegression,
  InvalidAttributionInputError,
} = require('./lib/regression-attribution');

const result = attributeRegression(request, comparisonRef /* 可选 */);
```

### 请求结构

`request` 为对象：

- `metric`：非空字符串，必须与待归因的原比较一致；
- `comparison`：非空字符串，必须与待归因的原比较一致；
- `decision`：原比较结论，仅原样回显、不参与计算；可省略或为 `null`
  （此时输出 `decision` 为 `null`）；也可经 `comparisonRef.decision` 提供；
- `samples`：样本数组，每项含
  - `side`：`"baseline"` 或 `"candidate"`；
  - `value`：观测量，必须是有限数字；
  - `dimensions`：可选。该样本在各维度上的分类，支持两种写法：
    - 对象映射：`{ "build": "b1", "host": "h1" }`，每个样本在一个维度中
      只能有一个维度值，维度值必须是有限字符串（空维度名非法）；
    - 键值对数组：`[{ "key": "build", "value": "b1" }, ...]`，
      同一样本内 `key` 重复即“重复维度键”错误。
  - 不携带 `dimensions`（或为 `null`）的样本不参与任何维度归因。

`comparisonRef` 可选，用于携带原比较上下文：其 `metric`、`comparison`
（或 `id`）若为字符串则与请求逐一字面校验，不一致抛
`InvalidAttributionInputError`；`decision` 为字符串时在请求未给定时作为
回显结论。

### 归因口径

- 各维度**独立**归因，维度按其在输入中首次出现的顺序输出。
- 仅纳入某维度值在基线侧和候选侧**都至少有 3 个观测值**的有效值；
  任一侧不足 3 个的维度值被跳过，明细中 `evidence_status` 标为
  `insufficient_samples`，不阻断其他维度值与其他维度。
- 对每个有效值计算：
  - 两侧样本中位数差 `median_diff`（候选中位数 − 基线中位数）；
  - 合并样本权重 `weight = baseline_count + candidate_count`；
  - Mann–Whitney U **双侧** p 值 `p_value`（小样本用精确置换分布，
    并列取平均秩；大样本用含结校正的正态近似）；
  - 同一维度内对各有效值的原始 p 用 **Holm** 方法校正，得
    `adjusted_p_value`（仅含有效值，保留六位小数）；
  - 贡献值 `contribution = weight * median_diff`。
- 明细 `entries` 按**贡献值降序**输出，贡献相同按维度值的 UTF-8 字节序；
  `insufficient_samples` 项排在有效值之后，按维度值 UTF-8 字节序。
  数值字段（`median_diff`、`p_value`、`adjusted_p_value`、`contribution`）
  保留六位小数，`weight`/计数为整数。

### 首要归因与证据状态

某维度值只有同时满足以下三条才标为首要归因（`primary_attribution`）：

1. 贡献值为正；
2. `adjusted_p_value < 0.05`；
3. 贡献值不低于该维度所有正贡献之和的 30%。

若满足条件的最高贡献项在 `1e-12` 精度内并列，则**不擅自挑选**，把并列项
全部列为首要归因候选（`primary_attributions`），并按维度值的 UTF-8 字节序
稳定排序。没有任何维度值达到条件时，该维度与顶层 `evidence_status` 均为
`insufficient_evidence`；这不是异常。任一维度存在首要归因时，顶层
`evidence_status` 为 `primary_attribution`。

### 输出结构

顶层固定字段：`metric`、`comparison`、`decision`、`evidence_status`、
`dimensions`。`dimensions` 每项固定含 `dimension`、`evidence_status`、
`primary_attributions`、`entries`；`entries` 每项固定含 `dimension_value`、
`evidence_status`（`primary_attribution` / `not_primary` /
`insufficient_samples`）、`baseline_count`、`candidate_count`、
`median_diff`、`p_value`、`adjusted_p_value`、`weight`、`contribution`
（`insufficient_samples` 项后五项统计字段为 `null`）。

### 输入错误

下列情形统一抛出 `InvalidAttributionInputError`，错误信息指出**第一个按输入
顺序出现**的具体字段路径（挂在 `err.fieldPath`，如 `samples[0].value`、
`samples[2].dimensions[1].key`）：缺少 `metric`、`comparison`、`side` 或
样本 `value`；存在重复维度键；样本 `value` 不是有限数字；维度值不是有限
字符串；整个请求没有任何有效维度值；`metric`/`comparison` 与原比较不一致。
部分维度值样本不足不属于输入错误。同一输入多次调用产生完全相同的归因顺序、
数值与证据状态。

## 约定

- 公开行为以 README 与源码为准。
- 后续需求在此基线上增量实现。
- 测试：`node --test`（使用内置 `node:test`，无第三方依赖）。
