'use strict';

const fs = require('node:fs/promises');
const { parseArgs, EXIT_OK, EXIT_USAGE, EXIT_OUTPUT_ERROR } = require('./collect');

// 回归归因：对一次已判定为回归的比较，按每个分类维度（build/host/scenario 等）
// 独立给出维度值级别的贡献排名与首要归因候选。
//
// 口径（见 README「attribute 子命令」）：
// - 仅纳入在基线侧与候选侧都至少有 3 个观测的维度值；不足者明细标
//   insufficient_samples 并跳过，不影响其他维度值/维度；
// - 每个有效维度值计算两侧中位数差（候选减基线）、合并样本权重（两侧样本数
//   之和）、Mann-Whitney U 双侧 p 值；同一维度内用 Holm 方法校正 p 值；
// - 贡献值 = 样本权重 × 中位数差，维度内按贡献值降序（并列按维度值 UTF-8
//   字节序）输出；
// - 维度值同时满足 贡献值为正、校正后 p 值 < 0.05、贡献值不低于该维度正贡献
//   之和的 30% 才具备首要归因资格；全局最高贡献在 1e-12 精度内并列时，并列者
//   全部列为首要归因候选（按维度值 UTF-8 字节序稳定排序）；
// - 没有任何维度值达到条件时 evidence_status 为 insufficient_evidence（非异常）。

const { round6, mannWhitneyTwoSided } = require('./stats');
const {
  buildCompareResult, decide, DEFAULT_ALPHA, DEFAULT_MIN_CHANGE_PERCENT,
} = require('./compare');

const MIN_GROUP_OBSERVATIONS = 3;
const SIGNIFICANCE = 0.05;
const PRIMARY_SHARE = 0.3;
const TIE_EPSILON = 1e-12;

class InvalidAttributionInputError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = 'InvalidAttributionInputError';
    this.path = path;
  }
}

// 有限数字（不接受布尔/NaN/Infinity/字符串；允许负数，观测量不限于耗时）。
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// 按 UTF-8 字节序比较两个字符串（Buffer 字典序），稳定且与平台区域无关。
function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// 合法标识符直接拼接，其他键名以 JSON 字符串括号表示（与字段路径格式一致）。
function formatKey(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `[${JSON.stringify(key)}]`;
}

// JSON.parse 在当前 V8 上会先合并重复键再调用 reviver，无法借 reviver 检测。
// 改为在 JSON.parse 成功后对原文做一次轻量结构扫描（假定语法合法），返回首个
// 位于某个 samples[i].dimensions 对象内的重复键路径，如
// "samples[0].dimensions.host"；没有则返回 null。其他位置的重复键不视为
// 维度键重复（需求只禁止同一样本同一维度有多个值）。
function findDuplicateDimensionKey(text) {
  let pos = 0;
  const n = text.length;
  let found = null;

  const ws = () => { while (pos < n && /\s/.test(text[pos])) pos++; };

  // 读取并解码一个 JSON 字符串字面量（pos 指向开引号），用于对象键比较：
  // JSON 语义下 "host" 与 "host" 是同一个键，重复判定必须按解码值。
  const parseJsonString = () => {
    pos++; // 开引号
    let out = '';
    while (pos < n) {
      const c = text[pos++];
      if (c === '"') break;
      if (c === '\\') {
        const e = text[pos++];
        if (e === 'u') {
          out += String.fromCharCode(parseInt(text.slice(pos, pos + 4), 16));
          pos += 4;
        } else {
          out += { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e] || e;
        }
      } else {
        out += c;
      }
    }
    return out;
  };

  const skipPrimitive = () => {
    const c = text[pos];
    if (c === '"') { parseJsonString(); return; }
    while (pos < n && !',]}'.includes(text[pos]) && !/\s/.test(text[pos])) pos++;
  };

  const DIM_PATH = /^\$\.samples\[\d+\]\.dimensions$/;

  function parseValue(path) {
    ws();
    const c = text[pos];
    if (c === '{') { parseObject(path); return; }
    if (c === '[') { parseArray(path); return; }
    skipPrimitive();
  }

  function parseObject(path) {
    pos++; // {
    ws();
    if (text[pos] === '}') { pos++; return; }
    const seen = new Set();
    while (true) {
      ws();
      const key = parseJsonString();
      ws();
      pos++; // :
      ws();
      const childPath = path === '$' ? `$.${formatKey(key)}` : `${path}.${formatKey(key)}`;
      if (seen.has(key)) {
        if (found === null && DIM_PATH.test(path)) found = childPath;
      } else {
        seen.add(key);
      }
      parseValue(childPath);
      ws();
      if (text[pos] === ',') { pos++; continue; }
      if (text[pos] === '}') { pos++; break; }
    }
  }

  function parseArray(path) {
    pos++; // [
    ws();
    if (text[pos] === ']') { pos++; return; }
    let idx = 0;
    while (true) {
      parseValue(`${path}[${idx}]`);
      idx++;
      ws();
      if (text[pos] === ',') { pos++; continue; }
      if (text[pos] === ']') { pos++; break; }
    }
  }

  parseValue('$');
  return found === null ? null : found.replace(/^\$\./, '');
}

// 解析请求文本：先 JSON.parse 取值，再扫描重复维度键。
// 返回 { value, duplicatePath }。
function parseRequestJson(text) {
  const value = JSON.parse(text);
  const duplicatePath = findDuplicateDimensionKey(text);
  return { value, duplicatePath };
}

// 中位数：偶数个取中间两值平均（与 collect/compare 口径一致）。
function medianOf(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// 维度内 Holm 校正：m 个原始 p 升序后记 p_(j)（j 从 1 起），
// q_(j) = min(1, min over k>=j (m-k+1)·p_(k))，映回原顺序。
// 平局先按 p 值，再按维度值 UTF-8 字节序保证稳定（同值再按维度名）。
function holmAdjust(entries) {
  const m = entries.length;
  const order = entries.map((entry, i) => i).sort((i, j) => {
    const a = entries[i];
    const b = entries[j];
    if (a.p !== b.p) return a.p - b.p;
    const byValue = compareUtf8(a.value, b.value);
    if (byValue !== 0) return byValue;
    return compareUtf8(a.dimension, b.dimension);
  });
  const adjusted = new Array(m);
  let running = Infinity;
  for (let pos = m - 1; pos >= 0; pos--) {
    const idx = order[pos];
    // pos（0-based）对应位次 j = pos+1，Holm 乘数为 m-j+1 = m-pos。
    running = Math.min(running, (m - pos) * entries[idx].p);
    adjusted[idx] = Math.min(1, running);
  }
  return adjusted;
}

// 校验并归因。payload 为 parseRequestJson 解析出的请求对象；
// duplicatePath 为原文扫描出的首个重复维度键路径（无则 null）。非法时抛
// InvalidAttributionInputError，异常信息以字段路径开头：先必填的顶层标识，
// 再按 samples 下标顺序逐样本（side -> value -> dimensions 重复键 -> 各维度
// 键值），因此多类问题并存时报出的总是输入顺序中最早的字段路径。
function computeAttribution(payload, duplicatePath = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new InvalidAttributionInputError('$', '请求体必须为 JSON 对象');
  }

  if (typeof payload.metric !== 'string' || payload.metric === '') {
    throw new InvalidAttributionInputError('metric', '字段缺失或不是非空字符串');
  }
  if (typeof payload.comparison !== 'string' || payload.comparison === '') {
    throw new InvalidAttributionInputError('comparison', '字段缺失或不是非空字符串');
  }

  let reqAlpha = DEFAULT_ALPHA;
  if (payload.alpha !== undefined) {
    if (!isFiniteNumber(payload.alpha) || !(payload.alpha > 0 && payload.alpha < 1)) {
      throw new InvalidAttributionInputError('alpha', '必须满足 0 < alpha < 1');
    }
    reqAlpha = payload.alpha;
  }
  let reqMinChangePercent = DEFAULT_MIN_CHANGE_PERCENT;
  if (payload.min_change_percent !== undefined) {
    if (!isFiniteNumber(payload.min_change_percent) || payload.min_change_percent < 0) {
      throw new InvalidAttributionInputError('min_change_percent', '必须为不小于 0 的数字');
    }
    reqMinChangePercent = payload.min_change_percent;
  }

  if (!Array.isArray(payload.samples)) {
    throw new InvalidAttributionInputError('samples', '字段缺失或不是数组');
  }

  let anyDimensionValue = false;
  // 形如 samples[3].dimensions.host -> 3
  const dupMatch = duplicatePath
    ? /^samples\[(\d+)\]\.dimensions\.(.*)$/.exec(duplicatePath) : null;
  const dupIndex = dupMatch ? Number(dupMatch[1]) : -1;
  for (let i = 0; i < payload.samples.length; i++) {
    const samplePath = `samples[${i}]`;
    const sample = payload.samples[i];
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
      throw new InvalidAttributionInputError(samplePath, '样本必须为对象');
    }
    if (sample.side !== 'baseline' && sample.side !== 'candidate') {
      throw new InvalidAttributionInputError(`${samplePath}.side`,
        '字段缺失或不是 "baseline" / "candidate"');
    }
    if (!('value' in sample) || !isFiniteNumber(sample.value)) {
      throw new InvalidAttributionInputError(`${samplePath}.value`, '样本值必须是有限数字');
    }
    if (i === dupIndex) {
      throw new InvalidAttributionInputError(duplicatePath,
        '维度键重复：每个样本在一个维度中只能有一个维度值');
    }
    if (sample.dimensions !== undefined && sample.dimensions !== null) {
      const dimPath = `${samplePath}.dimensions`;
      if (typeof sample.dimensions !== 'object' || Array.isArray(sample.dimensions)) {
        throw new InvalidAttributionInputError(dimPath, '必须为维度名到维度值的对象');
      }
      for (const name of Object.keys(sample.dimensions)) {
        const v = sample.dimensions[name];
        if (typeof v !== 'string') {
          throw new InvalidAttributionInputError(`${dimPath}.${formatKey(name)}`,
            '维度值必须是字符串');
        }
        anyDimensionValue = true;
      }
    }
  }

  // 汇总两侧观测（保持输入顺序）。
  const sideValues = { baseline: [], candidate: [] };
  // dimName -> Map(value -> { baseline: [], candidate: [] })
  const dims = new Map();
  for (const sample of payload.samples) {
    sideValues[sample.side].push(sample.value);
    if (sample.dimensions && typeof sample.dimensions === 'object') {
      for (const [name, value] of Object.entries(sample.dimensions)) {
        let groups = dims.get(name);
        if (!groups) {
          groups = new Map();
          dims.set(name, groups);
        }
        let group = groups.get(value);
        if (!group) {
          group = { baseline: [], candidate: [] };
          groups.set(value, group);
        }
        group[sample.side].push(sample.value);
      }
    }
  }

  if (sideValues.baseline.length < 2 || sideValues.candidate.length < 2) {
    throw new InvalidAttributionInputError('samples',
      '基线侧与候选侧都必须至少含 2 个样本');
  }
  if (!anyDimensionValue) {
    throw new InvalidAttributionInputError('samples', '整个请求没有任何有效维度值');
  }

  // 原比较结论：按 compare 口径用同一批样本重算（不采用外部 summary），
  // 与归因计算相互独立；归因不改变任何阈值或既有字段。
  const baselineInput = { durations: sideValues.baseline };
  const candidateInput = { durations: sideValues.candidate };
  const compared = buildCompareResult(baselineInput, candidateInput, reqAlpha);
  const decisionResult = decide(
    compared.welch.p_value, reqAlpha,
    compared.delta.mean.percent, reqMinChangePercent,
  );

  // 各维度独立归因。
  const dimensionResults = [];
  // 跨维度通过三道门的资格行，供全局取最高与并列判定。
  const eligibleRows = [];

  for (const [dimension, groups] of dims) {
    const effective = [];
    const insufficient = [];
    for (const [value, group] of groups) {
      if (group.baseline.length >= MIN_GROUP_OBSERVATIONS
        && group.candidate.length >= MIN_GROUP_OBSERVATIONS) {
        effective.push({ value, group });
      } else {
        insufficient.push({ value, group });
      }
    }

    const rows = effective.map(({ value, group }) => {
      const baselineMedian = medianOf(group.baseline);
      const candidateMedian = medianOf(group.candidate);
      const medianDiff = candidateMedian - baselineMedian;
      const weight = group.baseline.length + group.candidate.length;
      const contribution = weight * medianDiff;
      const p = mannWhitneyTwoSided(group.baseline, group.candidate);
      return {
        dimension,
        value,
        baselineCount: group.baseline.length,
        candidateCount: group.candidate.length,
        medianDiff,
        weight,
        contribution,
        p,
      };
    });

    const adjusted = holmAdjust(rows);
    for (let i = 0; i < rows.length; i++) rows[i].adjustedP = adjusted[i];

    const positiveSum = rows.reduce(
      (acc, row) => acc + (row.contribution > 0 ? row.contribution : 0), 0,
    );

    for (const row of rows) {
      const adjustedRounded = round6(row.adjustedP);
      const qualified = row.contribution > 0
        && adjustedRounded < SIGNIFICANCE
        && positiveSum > 0
        && row.contribution >= PRIMARY_SHARE * positiveSum;
      if (qualified) eligibleRows.push(row);
    }

    // 维度内排序：贡献降序；贡献在 1e-12 精度内并列按维度值 UTF-8 字节序
    // （与首要归因的并列口径一致，保证明细顺序与 primary_attributions 协调）。
    rows.sort((a, b) => {
      if (Math.abs(a.contribution - b.contribution) > TIE_EPSILON) {
        return b.contribution - a.contribution;
      }
      return compareUtf8(a.value, b.value);
    });

    // 样本不足的维度值不参与排名/校正，仅在明细末尾按 UTF-8 字节序列出。
    const insufficientRankings = insufficient.map(({ value, group }) => ({
      value,
      baselineCount: group.baseline.length,
      candidateCount: group.candidate.length,
      insufficient: true,
    }));
    insufficientRankings.sort((a, b) => compareUtf8(a.value, b.value));

    dimensionResults.push({ dimension, positiveSum, rows, insufficientRankings });
  }

  // 维度顺序按维度名 UTF-8 字节序稳定排列（与维度首次出现顺序无关）。
  dimensionResults.sort((a, b) => compareUtf8(a.dimension, b.dimension));

  // 全局首要归因：资格行中贡献最高者；与最高在 1e-12（绝对值）内并列者全部保留。
  let primaryRows = [];
  if (eligibleRows.length > 0) {
    const highest = eligibleRows.reduce(
      (m, row) => (row.contribution > m ? row.contribution : m), -Infinity,
    );
    primaryRows = eligibleRows
      .filter((row) => Math.abs(row.contribution - highest) <= TIE_EPSILON);
  }
  const primaryKey = new Set(primaryRows.map((row) => `${row.dimension}\u0000${row.value}`));

  const dimensionsOutput = dimensionResults.map(({
    dimension, positiveSum, rows, insufficientRankings,
  }) => {
    const rankings = rows.map((row) => {
      const isPrimary = primaryKey.has(`${row.dimension}\u0000${row.value}`);
      return {
        value: row.value,
        baseline_count: row.baselineCount,
        candidate_count: row.candidateCount,
        median_diff: round6(row.medianDiff),
        weight: row.weight,
        contribution: round6(row.contribution),
        adjusted_p_value: round6(row.adjustedP),
        evidence: isPrimary
          ? 'primary'
          : eligibleRows.includes(row) ? 'eligible' : 'ranked',
      };
    });
    for (const item of insufficientRankings) {
      rankings.push({
        value: item.value,
        baseline_count: item.baselineCount,
        candidate_count: item.candidateCount,
        median_diff: null,
        weight: null,
        contribution: null,
        adjusted_p_value: null,
        evidence: 'insufficient_samples',
      });
    }
    const primaryCandidates = rankings
      .filter((row) => row.evidence === 'primary')
      .map((row) => row.value);
    return {
      dimension,
      positive_contribution_sum: round6(positiveSum),
      primary_candidates: primaryCandidates,
      rankings,
    };
  });

  // 首要归因列表：按维度值 UTF-8 字节序，同值跨维度再按维度名字节序。
  const primaryAttributions = primaryRows
    .slice()
    .sort((a, b) => {
      const byValue = compareUtf8(a.value, b.value);
      if (byValue !== 0) return byValue;
      return compareUtf8(a.dimension, b.dimension);
    })
    .map((row) => ({
      dimension: row.dimension,
      value: row.value,
      median_diff: round6(row.medianDiff),
      weight: row.weight,
      contribution: round6(row.contribution),
      adjusted_p_value: round6(row.adjustedP),
    }));

  return {
    metric: payload.metric,
    comparison: payload.comparison,
    baseline_summary: compared.baselineSummary,
    candidate_summary: compared.candidateSummary,
    welch: compared.welch,
    decision: decisionResult,
    attribution: {
      evidence_status: primaryAttributions.length > 0
        ? 'primary_attribution' : 'insufficient_evidence',
      dimensions: dimensionsOutput,
      primary_attributions: primaryAttributions,
    },
  };
}

// attribute 子命令入口：attribute --request <归因请求.json> --output <结果.json>。
// 参数/输入无效时 stderr 输出一条原因（含首个问题字段路径）、退出码 2，
// 不创建或改写 --output；输出写入失败退出码 4；成功退出码 0。
async function attribute(tokens) {
  const KNOWN = new Set(['request', 'output']);
  const { values, error: parseError } = parseArgs(tokens, KNOWN);
  if (parseError) {
    process.stderr.write(`perf-regress: ${parseError}\n`);
    return EXIT_USAGE;
  }
  const requestPath = values.request;
  const output = values.output;
  if (requestPath === undefined || requestPath === '') {
    process.stderr.write('perf-regress: --request 不能为空\n');
    return EXIT_USAGE;
  }
  if (output === undefined || output === '') {
    process.stderr.write('perf-regress: --output 不能为空\n');
    return EXIT_USAGE;
  }

  let text;
  try {
    text = await fs.readFile(requestPath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `perf-regress: 无法读取 --request 文件 ${requestPath}: ${err.message}\n`,
    );
    return EXIT_USAGE;
  }

  let payload;
  let duplicatePath = null;
  try {
    ({ value: payload, duplicatePath } = parseRequestJson(text));
  } catch {
    process.stderr.write(
      `perf-regress: 归因请求文件不是合法 JSON: ${requestPath}\n`,
    );
    return EXIT_USAGE;
  }

  let result;
  try {
    result = computeAttribution(payload, duplicatePath);
  } catch (err) {
    if (err instanceof InvalidAttributionInputError) {
      process.stderr.write(`perf-regress: 归因输入无效: ${err.message}\n`);
      return EXIT_USAGE;
    }
    throw err;
  }

  let outText;
  try {
    outText = JSON.stringify(result, null, 2) + '\n';
  } catch (err) {
    process.stderr.write(`perf-regress: 结果序列化失败: ${err.message}\n`);
    return EXIT_OUTPUT_ERROR;
  }
  try {
    await fs.writeFile(output, outText, 'utf8');
  } catch (err) {
    process.stderr.write(
      `perf-regress: 无法写入 --output ${output}: ${err.message}\n`,
    );
    return EXIT_OUTPUT_ERROR;
  }
  return EXIT_OK;
}

module.exports = {
  attribute,
  computeAttribution,
  parseRequestJson,
  holmAdjust,
  compareUtf8,
  medianOf,
  InvalidAttributionInputError,
  MIN_GROUP_OBSERVATIONS,
  SIGNIFICANCE,
  PRIMARY_SHARE,
  TIE_EPSILON,
};
