/**
 * Builder for the Tianzi lexicon query DSL embedded in a fill-in expression.
 *
 * Docs: https://tianzi.hongbot.icu/howto
 *
 * Query DSL cheat sheet (the part implemented below):
 *   :pattern       拼音       :zhishi, :?.zs
 *   :/pattern/     拼音正则   :/zh.shi/
 *   =len           长度       =4, =>4, =<4, =>=4, =<=4
 *   /path/*        路径       /山东省/济南市/** (** selects all descendants)
 *   #value#        枚举       #地级市#
 *   #start..end    索引       #1110000..1120000
 *   /regex/        正则       /萌萌.+/
 *
 * Segments are ANDed when concatenated and can be joined with `&` / `|`.
 * `!` negates a segment and `@组` selects the schema group that runs it.
 */

import type { LexiconMeta, LexiconSchema } from "../api/lexicons";

export class LexiconQueryError extends Error {
  override readonly name = "LexiconQueryError";
}

export type LengthComparison = "eq" | "gt" | "lt" | "gte" | "lte";

const COMPARISON_SYMBOL: Record<LengthComparison, string> = {
  eq: "",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
};

export type Condition =
  | { kind: "pinyin"; pattern: string }
  | { kind: "pinyinRegex"; pattern: string }
  | { kind: "wordLength"; value: number; comparison: LengthComparison }
  | {
      kind: "path";
      segments: string[];
      /** `children` renders `/*`, `descendants` renders `/**`. */
      depth: "children" | "descendants";
    }
  | { kind: "enumValue"; value: string }
  | { kind: "index"; start: number; end: number }
  | { kind: "regex"; source: string }
  /** Escape hatch for syntax this module does not model yet (e.g. SPos). */
  | { kind: "raw"; dsl: string };

/**
 * Schema types that can run each condition kind. Kinds that are not listed
 * (`index`, `raw`) are not tied to a schema group and are never checked.
 */
const CONDITION_SCHEMA_TYPES: Partial<Record<Condition["kind"], readonly string[]>> = {
  pinyin: ["SPinyin", "SPinyinRegex"],
  pinyinRegex: ["SPinyinRegex"],
  wordLength: ["SWordLength"],
  path: ["SPath"],
  enumValue: ["SEnum"],
  regex: ["SRegex"],
};

const STRUCTURAL_CHARS = /[{}&|!@]/;

function assertValue(value: string, label: string, pattern = STRUCTURAL_CHARS) {
  if (!value) throw new LexiconQueryError(`${label}不能为空`);
  if (pattern.test(value) || value.includes("\n") || value.includes("\r"))
    throw new LexiconQueryError(`${label}含有查询语法保留字符：${value}`);
}

function assertInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0)
    throw new LexiconQueryError(`${label}必须是非负整数`);
}

function pinyin(pattern: string): Condition {
  assertValue(pattern, "拼音模式");
  return { kind: "pinyin", pattern };
}

function pinyinRegex(pattern: string): Condition {
  if (!pattern) throw new LexiconQueryError("拼音正则不能为空");
  // `{}` and `|` belong to the pattern; only the `/` delimiters and line
  // breaks would cut the segment short.
  if (pattern.includes("/") || /[\n\r]/.test(pattern))
    throw new LexiconQueryError(`拼音正则含有保留字符：${pattern}`);
  return { kind: "pinyinRegex", pattern };
}

function wordLength(
  value: number,
  comparison: LengthComparison = "eq",
): Condition {
  assertInteger(value, "长度");
  if (!(comparison in COMPARISON_SYMBOL))
    throw new LexiconQueryError(`未知的长度比较符：${comparison}`);
  return { kind: "wordLength", value, comparison };
}

/**
 * A length condition whose value is a DSL expression, e.g. `=[[3-6>k]]`.
 * The engine evaluates the expression before running the query, so this is
 * kept as raw DSL instead of a number.
 */
function wordLengthExpr(
  dsl: string,
  comparison: LengthComparison = "eq",
): Condition {
  if (!dsl) throw new LexiconQueryError("长度不能为空");
  if (!(comparison in COMPARISON_SYMBOL))
    throw new LexiconQueryError(`未知的长度比较符：${comparison}`);
  return { kind: "raw", dsl: `=${COMPARISON_SYMBOL[comparison]}${dsl}` };
}

function path(
  segments: readonly string[],
  depth: "children" | "descendants" = "children",
): Condition {
  if (segments.length === 0)
    throw new LexiconQueryError("路径至少需要一个节点");
  for (const segment of segments) assertValue(segment, "路径节点", /[{}&|!@/*]/);
  if (depth !== "children" && depth !== "descendants")
    throw new LexiconQueryError(`未知的路径深度：${depth}`);
  return { kind: "path", segments: [...segments], depth };
}

function enumValue(value: string): Condition {
  assertValue(value, "枚举值", /[{}&|!@#]/);
  return { kind: "enumValue", value };
}

function index(start: number, end: number): Condition {
  assertInteger(start, "索引起点");
  assertInteger(end, "索引终点");
  if (start > end) throw new LexiconQueryError("索引起点不能大于终点");
  return { kind: "index", start, end };
}

function regex(source: string): Condition {
  if (!source) throw new LexiconQueryError("正则不能为空");
  // Only an unescaped `/` would terminate the full-match regex early.
  if (/(^|[^\\])(\\\\)*\//.test(source))
    throw new LexiconQueryError(`正则中含未转义的 /：${source}`);
  return { kind: "regex", source };
}

function raw(dsl: string): Condition {
  if (!dsl) throw new LexiconQueryError("原始查询不能为空");
  return { kind: "raw", dsl };
}

/** Condition constructors; every value is checked before it reaches the DSL. */
export const lex = {
  pinyin,
  pinyinRegex,
  wordLength,
  wordLengthExpr,
  path,
  enum: enumValue,
  index,
  regex,
  raw,
} as const;

export interface QuerySegment {
  /** Implicitly ANDed together, rendered by direct concatenation. */
  readonly conditions: readonly Condition[];
  /** Schema group that runs this segment (`@组名`). */
  readonly group?: string;
  /** Prefixes the segment with `!` and wraps it in parentheses. */
  readonly negated?: boolean;
}

/** Groups conditions into one segment, optionally bound to a schema group. */
export function segment(
  conditions: Condition | readonly Condition[],
  options: { group?: string; negated?: boolean } = {},
): QuerySegment {
  const list = Array.isArray(conditions) ? conditions : [conditions as Condition];
  if (list.length === 0)
    throw new LexiconQueryError("查询段至少需要一个条件");
  return {
    conditions: list,
    group: options.group,
    negated: options.negated || undefined,
  };
}

function renderCondition(condition: Condition): string {
  switch (condition.kind) {
    case "pinyin":
      return `:${condition.pattern}`;
    case "pinyinRegex":
      return `:/${condition.pattern}/`;
    case "wordLength":
      return `=${COMPARISON_SYMBOL[condition.comparison]}${condition.value}`;
    case "path":
      return `/${condition.segments.join("/")}/${condition.depth === "descendants" ? "**" : "*"}`;
    case "enumValue":
      return `#${condition.value}#`;
    case "index":
      return `#${condition.start}..${condition.end}`;
    case "regex":
      return `/${condition.source}/`;
    case "raw":
      return condition.dsl;
  }
}

function renderSegment(segment: QuerySegment): string {
  const body = segment.conditions.map(renderCondition).join("");
  // The group annotation goes outside the negation: `!(=2)@词` is accepted,
  // while `!(=2@词)` is rejected by the fill-in engine.
  const core = segment.negated ? `!(${body})` : body;
  return segment.group ? `${core}@${segment.group}` : core;
}

function schemaSupports(schema: LexiconSchema, kind: Condition["kind"]): boolean {
  const required = CONDITION_SCHEMA_TYPES[kind];
  if (!required) return true;
  return required.some((type) => schema.types.includes(type));
}

/** Groups of a lexicon that can run this condition kind, in schema order. */
export function groupsForCondition(
  meta: LexiconMeta,
  kind: Condition["kind"],
): string[] {
  return meta.schemas
    .filter((schema) => schemaSupports(schema, kind))
    .map(({ name }) => name);
}

/** Condition kinds a group can run. `index` is global and never listed. */
export function conditionsForGroup(
  meta: LexiconMeta,
  group: string,
): Condition["kind"][] {
  const schema = meta.schemas.find(({ name }) => name === group);
  if (!schema) return [];
  return (Object.keys(CONDITION_SCHEMA_TYPES) as Condition["kind"][]).filter(
    (kind) => schemaSupports(schema, kind),
  );
}

const CONDITION_LABEL: Record<Condition["kind"], string> = {
  pinyin: "拼音",
  pinyinRegex: "拼音正则",
  wordLength: "长度",
  path: "路径",
  enumValue: "枚举",
  index: "索引",
  regex: "正则",
  raw: "原始",
};

function conditionLabel(kind: Condition["kind"]): string {
  return CONDITION_LABEL[kind];
}

function validateSegment(segment: QuerySegment, meta?: LexiconMeta) {
  if (!meta) return;

  const schema = segment.group
    ? meta.schemas.find(({ name }) => name === segment.group)
    : undefined;
  if (segment.group && !schema)
    throw new LexiconQueryError(
      `词库“${meta.name}”没有组“${segment.group}”；可用组：${meta.schemas
        .map(({ name }) => name)
        .join("、") || "无"}`,
    );

  const needsSchema = segment.conditions.filter(
    (condition) => condition.kind in CONDITION_SCHEMA_TYPES,
  );
  if (needsSchema.length === 0) return;

  if (schema) {
    for (const condition of needsSchema) {
      if (!schemaSupports(schema, condition.kind))
        throw new LexiconQueryError(
          `组“${schema.name}”不支持 ${conditionLabel(condition.kind)} 查询；支持的类型：${schema.types.join("、")}`,
        );
    }
    return;
  }

  for (const condition of needsSchema) {
    if (!meta.schemas.some((schema) => schemaSupports(schema, condition.kind)))
      throw new LexiconQueryError(
        `词库“${meta.name}”不支持 ${conditionLabel(condition.kind)} 查询`,
      );
  }
}

/**
 * Builds one fill-in query. Pass the lexicon meta to have every condition
 * checked against the groups that lexicon actually supports.
 *
 * ```ts
 * const meta = await fetchLexiconMeta("县以上行政区划");
 * const dsl = lexiconQuery(segment(lex.path(["山东省", "济南市"], "descendants")), meta)
 *   .and(segment(lex.enum("地级市"), { group: "类型" }))
 *   .build();
 * // /山东省/济南市/**&#地级市#@类型
 * ```
 */
export class LexiconQueryBuilder {
  readonly #meta: LexiconMeta | undefined;
  #dsl: string;

  constructor(first: QuerySegment, meta?: LexiconMeta) {
    validateSegment(first, meta);
    this.#meta = meta;
    this.#dsl = renderSegment(first);
  }

  /** Joins an AND segment. */
  and(segment: QuerySegment): this {
    validateSegment(segment, this.#meta);
    this.#dsl += `&${renderSegment(segment)}`;
    return this;
  }

  /** Joins an OR segment. */
  or(segment: QuerySegment): this {
    validateSegment(segment, this.#meta);
    this.#dsl += `|${renderSegment(segment)}`;
    return this;
  }

  /** Returns the DSL text that goes inside `{...}`. */
  build(): string {
    return this.#dsl;
  }

  toString(): string {
    return this.#dsl;
  }
}

export function lexiconQuery(
  first: QuerySegment,
  meta?: LexiconMeta,
): LexiconQueryBuilder {
  return new LexiconQueryBuilder(first, meta);
}

/** Wraps a query as a fill-in expression, e.g. `[[词{:zs}]]` or `[[词.拼音{:zs}]]`. */
export function renderExpression(
  name: string,
  query?: LexiconQueryBuilder | string,
  field = "",
  cacheName = "",
): string {
  if (!name) throw new LexiconQueryError("词库名不能为空");
  if (/[[\]{}]/.test(name))
    throw new LexiconQueryError(`词库名含有保留字符：${name}`);
  if (field && /[[\]{}.\n\r]/.test(field))
    throw new LexiconQueryError(`字段名含有保留字符：${field}`);
  const dsl = typeof query === "string" ? query : query?.build() ?? "";
  const target = field ? `${name}.${field}` : name;
  const cache = cacheName ? `>${cacheName}` : "";
  return `[[${target}${dsl ? `{${dsl}}` : ""}${cache}]]`;
}
