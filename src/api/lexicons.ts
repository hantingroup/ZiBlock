/**
 * Typed client and cache for the Tianzi lexicon APIs.
 *
 * Endpoints:
 *   GET /api/lex/list              list of every lexicon name
 *   GET /api/lex/jsonmeta/<name>   columns and queryable schema groups
 */

import { tianziUrl } from "./base";

// Wire model =================================================================

export type KnownColumnType =
  | "PlainText"
  | "PlainTextS"
  | "Pinyin"
  | "Length8"
  | "UInt8"
  | "UInt16"
  | "UInt16S"
  | "UInt32"
  | "Enum8";

/** Column types the UI knows about; unknown future types stay assignable. */
export type ColumnType = KnownColumnType | (string & {});

export type KnownSchemaType =
  | "SPinyin"
  | "SPinyinRegex"
  | "SWordLength"
  | "SPos"
  | "SRegex"
  | "SRealNum"
  | "SEnum"
  | "SPath";

/** Query kinds a schema group can run; unknown future kinds stay assignable. */
export type SchemaType = KnownSchemaType | (string & {});

export interface LexiconAliasTable {
  name: string;
  filename: string;
  columns: number;
  hasHeader: boolean;
}

export interface LexiconList {
  names: readonly string[];
  alias: LexiconAliasTable;
  siteKey: string;
  maxViewBytes: number;
  repoUrl: string;
}

export interface LexiconFileInfo {
  path: string;
  sizeBytes: number;
  mtime: number;
  mtimeIso: string;
}

export interface LexiconColumn {
  name: string;
  type: ColumnType;
  /** Groups this column belongs to. The wire format is a map of names. */
  groups: readonly string[];
}

export interface LexiconSchema {
  name: string;
  types: readonly SchemaType[];
}

export interface LexiconMeta {
  name: string;
  headwordCount: number;
  file?: LexiconFileInfo;
  ramBytes?: number;
  columns: readonly LexiconColumn[];
  schemas: readonly LexiconSchema[];
}

// Errors =====================================================================

export class LexiconApiError extends Error {
  override readonly name = "LexiconApiError";

  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

// Parsing ====================================================================

type WireRecord = Record<string, unknown>;

function expectRecord(value: unknown, path: string): WireRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new LexiconApiError(`词库响应格式错误：${path} 应为对象`);
  return value as WireRecord;
}

function expectArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value))
    throw new LexiconApiError(`词库响应格式错误：${path} 应为数组`);
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string")
    throw new LexiconApiError(`词库响应格式错误：${path} 应为字符串`);
  return value;
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new LexiconApiError(`词库响应格式错误：${path} 应为数字`);
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean")
    throw new LexiconApiError(`词库响应格式错误：${path} 应为布尔值`);
  return value;
}

function parseAliasTable(value: unknown, path: string): LexiconAliasTable {
  const alias = expectRecord(value, path);
  return {
    name: expectString(alias.name, `${path}.name`),
    filename: expectString(alias.filename, `${path}.filename`),
    columns: expectNumber(alias.columns, `${path}.columns`),
    hasHeader: expectBoolean(alias.has_header, `${path}.has_header`),
  };
}

/** Validates the `/api/lex/list` payload. */
export function parseLexiconList(value: unknown): LexiconList {
  const list = expectRecord(value, "list");
  return {
    names: expectArray(list.names, "list.names").map((name, index) =>
      expectString(name, `list.names[${index}]`),
    ),
    alias: parseAliasTable(list.alias, "list.alias"),
    siteKey: expectString(list.site_key, "list.site_key"),
    maxViewBytes: expectNumber(list.max_view_bytes, "list.max_view_bytes"),
    repoUrl: expectString(list.repo_url, "list.repo_url"),
  };
}

function parseFileInfo(value: unknown, path: string): LexiconFileInfo {
  const file = expectRecord(value, path);
  return {
    path: expectString(file.path, `${path}.path`),
    sizeBytes: expectNumber(file.size_bytes, `${path}.size_bytes`),
    mtime: expectNumber(file.mtime, `${path}.mtime`),
    mtimeIso: expectString(file.mtime_iso, `${path}.mtime_iso`),
  };
}

function parseColumn(value: unknown, path: string): LexiconColumn {
  const column = expectRecord(value, path);
  const groups = column.group ?? column.groups;
  return {
    name: expectString(column.name, `${path}.name`),
    type: expectString(column.type, `${path}.type`),
    groups:
      groups == null
        ? []
        : Object.keys(expectRecord(groups, `${path}.group`)),
  };
}

function parseSchema(value: unknown, path: string): LexiconSchema {
  const schema = expectRecord(value, path);
  return {
    name: expectString(schema.name, `${path}.name`),
    types: expectArray(schema.types, `${path}.types`).map((type, index) =>
      expectString(type, `${path}.types[${index}]`),
    ),
  };
}

/** Validates the `/api/lex/jsonmeta/<name>` payload. */
export function parseLexiconMeta(value: unknown): LexiconMeta {
  const meta = expectRecord(value, "meta");
  return {
    name: expectString(meta.name, "meta.name"),
    headwordCount: expectNumber(meta.headword_count, "meta.headword_count"),
    file:
      meta.file == null ? undefined : parseFileInfo(meta.file, "meta.file"),
    ramBytes:
      meta.ram_bytes == null
        ? undefined
        : expectNumber(meta.ram_bytes, "meta.ram_bytes"),
    columns: expectArray(meta.columns, "meta.columns").map((column, index) =>
      parseColumn(column, `meta.columns[${index}]`),
    ),
    schemas: expectArray(meta.schemas, "meta.schemas").map((schema, index) =>
      parseSchema(schema, `meta.schemas[${index}]`),
    ),
  };
}

// Requests ===================================================================

async function requestJson(
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(tianziUrl(path), { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new LexiconApiError("无法连接词库服务", undefined, error);
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail =
      typeof payload === "object" && payload !== null
        ? (payload as WireRecord).detail
        : undefined;
    const message =
      typeof detail === "string"
        ? detail
        : `${response.status} ${response.statusText}`;
    throw new LexiconApiError(`词库请求失败：${message}`, response.status, payload);
  }
  return payload;
}

/** Fetches every lexicon name. */
export async function fetchLexiconList(options: {
  signal?: AbortSignal;
} = {}): Promise<LexiconList> {
  return parseLexiconList(
    await requestJson("/api/lex/list", options.signal),
  );
}

// Shared caches ==============================================================
//
// Blocks need synchronous access to the lexicon list and to already-fetched
// metas (dropdown options and generators run synchronously). These loaders
// dedupe requests and populate the caches used by the block UI.

let cachedNames: readonly string[] | undefined;
let listPending: Promise<LexiconList> | undefined;

const metaCache = new Map<string, LexiconMeta>();
const metaPending = new Map<string, Promise<LexiconMeta>>();

/** Fetches the lexicon list once; later calls reuse the same request. */
export function loadLexiconList(): Promise<LexiconList> {
  if (!listPending) {
    listPending = fetchLexiconList()
      .then((list) => {
        cachedNames = list.names;
        return list;
      })
      .catch((error) => {
        listPending = undefined;
        throw error;
      });
  }
  return listPending;
}

/** Cached lexicon names, or undefined while the list is still loading. */
export function getCachedLexiconNames(): readonly string[] | undefined {
  return cachedNames;
}

/**
 * Whether the list knows this name. Returns undefined while the list is still
 * loading, false for a name that definitely is not in the list.
 */
export function isKnownLexiconName(name: string): boolean | undefined {
  return cachedNames?.includes(name);
}

/** Fetches one lexicon's meta once; later calls reuse the result. */
export function loadLexiconMeta(name: string): Promise<LexiconMeta> {
  const cached = metaCache.get(name);
  if (cached) return Promise.resolve(cached);

  let pending = metaPending.get(name);
  if (!pending) {
    pending = fetchLexiconMeta(name)
      .then((meta) => {
        metaCache.set(name, meta);
        return meta;
      })
      .finally(() => metaPending.delete(name));
    metaPending.set(name, pending);
  }
  return pending;
}

/** Meta already fetched for this lexicon, if any. */
export function getCachedLexiconMeta(name: string): LexiconMeta | undefined {
  return metaCache.get(name);
}

/** Fetches columns and schema groups for one lexicon. */
export async function fetchLexiconMeta(
  name: string,
  options: { signal?: AbortSignal } = {},
): Promise<LexiconMeta> {
  if (!name)
    throw new LexiconApiError("词库名不能为空");
  return parseLexiconMeta(
    await requestJson(
      `/api/lex/jsonmeta/${encodeURIComponent(name)}`,
      options.signal,
    ),
  );
}
