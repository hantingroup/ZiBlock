/**
 * Client for Tianzi's fill-in execution API.
 *
 * `POST /api/tianzi` compiles a fill-in program. With `stack: true` the
 * response also carries the syntax tree of the program, which the text importer
 * turns back into blocks.
 */

import { tianziUrl } from "./lexicons/api";

/** Half-open `[start, end)` offsets into the submitted command. */
export type TianziSpan = readonly [number, number];

/** A named capture of a syntax node. */
export interface TianziGroup {
  span: TianziSpan;
  text: string;
}

/** One syntax candidate the engine tried on a `[[…]]` field. */
export interface TianziAstNode {
  /** Syntax/translator name, e.g. `Range`, `Lex`, `Assign`. */
  syntax: string;
  kind: string;
  /** `ok`, `rejected`, or `raised:<ErrorName>`. */
  status: string;
  /** Offsets of the field body (between the brackets). */
  span: TianziSpan;
  text: string;
  groups?: Record<string, TianziGroup>;
  /** Nested `[[…]]` expressions inside this field. */
  children?: TianziAstNode[];
  output?: unknown;
  /** Offsets of the whole field, brackets included. */
  field_span: TianziSpan;
  /** Lexicon query breakdown, present on `Lex` nodes. */
  query?: TianziQuery;
}

/** One node of a lexicon query expression. */
export interface TianziQueryNode {
  /** `or`, `and`, `seg` or `tok`. */
  kind: string;
  span: TianziSpan;
  text: string;
  /** Schema group bound to a whole segment (`@组`). */
  group?: string;
  /** Segment is negated with `!`. */
  neg?: boolean;
  /** For `tok`: the schema translator that matched, e.g. `SPinyin`. */
  schema?: string;
  /**
   * For `tok`: captured values, keyed by grammar slot. Unlike syntax-node
   * groups these are plain strings, not spans.
   */
  groups?: Record<string, string>;
  children?: TianziQueryNode[];
}

export interface TianziQuery {
  text: string;
  span: TianziSpan;
  ast?: TianziQueryNode[];
  error?: string | null;
}

/** The compiled stack returned for a fill-in program. */
export interface TianziStack {
  input: string;
  output: string | null;
  final: boolean;
  error: string | null;
  duration_us: number;
  ast: TianziAstNode[];
}

export class TianziApiError extends Error {
  override readonly name = "TianziApiError";

  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

interface TianziResponse {
  status?: unknown;
  errno?: unknown;
  msg?: unknown;
  ast?: unknown;
}

function isSpan(value: unknown): value is TianziSpan {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

function parseStack(value: unknown): TianziStack {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TianziApiError("填字服务未返回语法树");
  const stack = value as Record<string, unknown>;
  if (typeof stack.input !== "string" || !Array.isArray(stack.ast))
    throw new TianziApiError("填字服务返回的语法树格式不正确");
  // The engine's own nodes are trusted as-is; the importer validates the parts
  // it consumes. This guard only rejects clearly malformed payloads.
  for (const node of stack.ast) {
    if (
      typeof node !== "object" ||
      node === null ||
      typeof (node as TianziAstNode).syntax !== "string" ||
      !isSpan((node as TianziAstNode).field_span)
    )
      throw new TianziApiError("填字服务返回的语法树节点格式不正确");
  }
  return {
    input: stack.input,
    output: typeof stack.output === "string" ? stack.output : null,
    final: stack.final === true,
    error: typeof stack.error === "string" ? stack.error : null,
    duration_us:
      typeof stack.duration_us === "number" ? stack.duration_us : 0,
    ast: stack.ast as TianziAstNode[],
  };
}

/**
 * Compiles `cmd` and returns its syntax tree. Unlike the plain execution call
 * this never throws on a compile error: a tree is still returned, and the
 * importer decides whether it can rebuild the program from it.
 */
export async function fetchTianziStack(
  cmd: string,
  options: { signal?: AbortSignal } = {},
): Promise<TianziStack> {
  // A hung request would leave the import dialog spinning forever.
  const timeout = AbortSignal.timeout(20_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  let response: Response;
  try {
    response = await fetch(tianziUrl("/api/tianzi"), {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd, stack: true }),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new TianziApiError(
      timeout.aborted ? "填字服务请求超时" : "无法连接填字服务",
      undefined,
      error,
    );
  }

  const payload: TianziResponse | undefined = await response
    .json()
    .catch(() => undefined);

  if (!response.ok) {
    const detail =
      typeof payload === "object" && payload !== null ? payload.msg : undefined;
    const message =
      typeof detail === "string"
        ? detail
        : `${response.status} ${response.statusText}`;
    throw new TianziApiError(`填字请求失败：${message}`, response.status, payload);
  }
  if (!payload || typeof payload !== "object")
    throw new TianziApiError("填字服务返回了无法解析的响应");

  return parseStack(payload.ast);
}
