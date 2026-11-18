/**
 * Macro table (`reserved/alias.tsv`), used by Tianzi's `Alias` translator.
 *
 * The table lives in the public lexicons repository and is fetched at runtime,
 * so entries added there show up without a rebuild. Until the request lands
 * (and whenever it fails) the default entries below keep the picker usable.
 *
 * Source: https://github.com/WFLing-seaer/lexicons/blob/main/reserved/alias.tsv
 */

export interface MacroEntry {
  /** The literal that gets expanded (the TSV key). */
  key: string;
  /** The expansion expression (the TSV's second column). */
  value: string;
}

/**
 * Fetched through the raw GitHub URL rather than tianzi.hongbot.icu: the
 * site's source endpoint (`/api/lex/source/别名表`) requires a login session
 * and a Turnstile token, which this editor does not have.
 */
const MACRO_TABLE_URL =
  "https://raw.githubusercontent.com/WFLing-seaer/lexicons/main/reserved/alias.tsv";

/** Minimal table until the remote one arrives. */
export const DEFAULT_MACRO_ENTRIES: readonly MacroEntry[] = [
  { key: "一", value: "[[通规{#0..3500}]]" },
  { key: "二", value: "[[通规{#3500..6500}]]" },
  { key: "三", value: "[[通规{#6500..8105}]]" },
];

// Remote table ===============================================================

export type MacroTableStatus = "idle" | "loading" | "ready" | "failed";

let cachedEntries: readonly MacroEntry[] | undefined;
let pending: Promise<readonly MacroEntry[]> | undefined;
let status: MacroTableStatus = "idle";

/** Entries to show now: the fetched table once it has arrived. */
export function getMacroEntries(): readonly MacroEntry[] {
  return cachedEntries ?? DEFAULT_MACRO_ENTRIES;
}

/** Where the table load stands; the picker uses it for its placeholder row. */
export function macroTableStatus(): MacroTableStatus {
  return status;
}

/**
 * Fetches the macro table, keeping at most one request in flight. A failed
 * request is retried the next time the picker opens.
 */
export function loadMacroEntries(): Promise<readonly MacroEntry[]> {
  if (!pending) {
    status = "loading";
    pending = fetchMacroEntries().then(
      (entries) => {
        cachedEntries = entries;
        status = "ready";
        return entries;
      },
      () => {
        status = "failed";
        pending = undefined;
        return DEFAULT_MACRO_ENTRIES;
      },
    );
  }
  return pending;
}

async function fetchMacroEntries(): Promise<readonly MacroEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(MACRO_TABLE_URL, {
      cache: "no-cache",
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`宏表请求失败：${response.status} ${response.statusText}`);
    const entries = parseMacroTable(await response.text());
    if (entries.length === 0) throw new Error("宏表为空");
    return entries;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses the table. The long examples are quoted and span lines, so cells
 * follow the usual doubled-quote CSV rules with a tab delimiter.
 */
export function parseMacroTable(text: string): MacroEntry[] {
  return parseTsv(text.replace(/^\uFEFF/, ""))
    .map(([key, value]) => ({ key: key ?? "", value: value ?? "" }))
    .filter(({ key }) => key !== "");
}

function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        cell += char;
      } else if (text[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === "\t") {
      endCell();
    } else if (char === "\n") {
      endRow();
    } else if (char === "\r") {
      if (text[index + 1] === "\n") index++;
      endRow();
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}
