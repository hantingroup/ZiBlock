/**
 * Turns a Tianzi syntax tree back into Blockly blocks.
 *
 * The engine compiles a fill-in program and, with `stack: true`, reports every
 * syntax candidate for each `[[…]]` field. Those candidates carry the captured
 * pieces (left/right bounds, variable name, query tokens, …), which is enough
 * to rebuild the block that produced the text. Text outside `[[…]]` becomes a
 * plain 文本 block, exactly as the generator treats it.
 *
 * The importer is best-effort by design: `ok` candidates win, `raised:` ones
 * are still structurally valid, and a rejected candidate is accepted only when
 * its syntax is specific (a rejected `Alias`/`Lex`/`Choice` usually means the
 * field never really parsed).
 */

import type * as Blockly from "blockly";
import { SHADOW_SLOTS, shadowState } from "./shadow-slots";
import type {
  TianziAstNode,
  TianziGroup,
  TianziQueryNode,
  TianziSpan,
  TianziStack,
} from "./tianzi";

type BlockState = Blockly.serialization.blocks.State;

/** The serialized workspace shape expected by `serialization.workspaces.load`. */
export interface ImportedWorkspace {
  blocks: {
    languageVersion: number;
    blocks: BlockState[];
  };
}

export class TextImportError extends Error {
  override readonly name = "TextImportError";
}

/** Syntaxes that match almost any text; only trusted when the engine says ok. */
const GENERIC_SYNTAXES = new Set(["Alias", "Lex", "Choice"]);

// Wire helpers ===============================================================

function spanKey(span: TianziSpan): string {
  return `${span[0]}:${span[1]}`;
}

function isSpan(value: unknown): value is TianziSpan {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

function group(node: TianziAstNode, name: string): TianziGroup | undefined {
  return node.groups?.[name];
}

function groupText(node: TianziAstNode, name: string): string | undefined {
  return node.groups?.[name]?.text;
}

function requiredGroup(node: TianziAstNode, name: string): TianziGroup {
  const found = group(node, name);
  if (!found) throw new TextImportError(`${node.syntax} 缺少 ${name} 部分`);
  return found;
}

/** Groups a span-keyed field and every candidate that described it. */
interface NodeField {
  nodes: TianziAstNode[];
}

/**
 * Index of every syntax candidate by the span of the field it parsed. Nested
 * candidates from any parent candidate are merged: the engine only recurses
 * into children for some syntaxes, so a field parsed as `Assign` may still get
 * its nested pieces from the `Lex` attempt on the same span.
 */
class NodeIndex {
  readonly fields = new Map<string, NodeField>();

  constructor(nodes: readonly TianziAstNode[]) {
    this.add(nodes);
  }

  private add(nodes: readonly TianziAstNode[]) {
    for (const node of nodes) {
      if (!isSpan(node.field_span)) continue;
      const key = spanKey(node.field_span);
      let field = this.fields.get(key);
      if (!field) this.fields.set(key, (field = { nodes: [] }));
      field.nodes.push(node);
      if (node.children?.length) this.add(node.children);
    }
  }

  /** Best candidate for an exact field span. */
  choose(span: TianziSpan | undefined): TianziAstNode | undefined {
    if (!span) return undefined;
    const field = this.fields.get(spanKey(span));
    if (!field) return undefined;
    return chooseNode(field.nodes);
  }

  /**
   * Immediate nested expressions of a field, one representative per span,
   * sorted by position.
   */
  childrenOf(span: TianziSpan): { span: TianziSpan; node: TianziAstNode }[] {
    const field = this.fields.get(spanKey(span));
    if (!field) return [];

    const bySpan = new Map<string, TianziAstNode[]>();
    for (const parent of field.nodes) {
      for (const child of parent.children ?? []) {
        if (!isSpan(child.field_span)) continue;
        const key = spanKey(child.field_span);
        const list = bySpan.get(key);
        if (list) list.push(child);
        else bySpan.set(key, [child]);
      }
    }

    const result: { span: TianziSpan; node: TianziAstNode }[] = [];
    for (const nodes of bySpan.values()) {
      const node = chooseNode(nodes);
      if (node) result.push({ span: node.field_span, node });
    }
    result.sort((a, b) => a.span[0] - b.span[0]);
    return result;
  }
}

function chooseNode(nodes: readonly TianziAstNode[]): TianziAstNode | undefined {
  if (nodes.length === 0) return undefined;
  // The engine's first accepted parse is the one that actually ran.
  const ok = nodes.find((node) => node.status === "ok");
  if (ok) return ok;
  // A raised syntax parsed correctly but failed semantically (unknown word,
  // empty result, …); its structure is still usable.
  const raised = nodes.find((node) => node.status?.startsWith("raised:"));
  if (raised) return raised;
  // Rejected candidates are only trusted when they are specific: a rejected
  // Alias/Lex/Choice is just the catch-all attempt failing.
  return nodes.find(
    (node) => BUILDERS[node.syntax] && !GENERIC_SYNTAXES.has(node.syntax),
  );
}

// State helpers ==============================================================

function setInput(
  state: BlockState,
  name: string,
  connection: { block?: BlockState; shadow?: BlockState },
) {
  (state.inputs ??= {})[name] = connection;
}

function literal(value: string, type = "literal_text"): BlockState {
  return { type, fields: { TEXT: value } };
}

/** Shadow for a slot, preferring the type and options the block declares. */
function slotShadow(
  blockType: string,
  input: string,
  value: string | number,
): BlockState {
  const slot = SHADOW_SLOTS.get(blockType)?.find((item) => item.input === input);
  return slot ? shadowState({ ...slot, value }) : literal(String(value));
}

function setSlot(
  state: BlockState,
  blockType: string,
  input: string,
  value: string | number,
) {
  setInput(state, input, { shadow: slotShadow(blockType, input, value) });
}

/**
 * Fills a value input with the nested expression captured for `name`, or with
 * the literal shadow when the field held plain text.
 */
function setSlotOrChild(
  state: BlockState,
  blockType: string,
  node: TianziAstNode,
  index: NodeIndex,
  input: string,
  name: string,
) {
  const captured = group(node, name);
  const child = index.choose(captured?.span);
  if (child) setInput(state, input, { block: buildNode(child, index) });
  else if (captured) setSlot(state, blockType, input, captured.text);
}

/** A value input that is not a slot (variables/format bodies). */
function setBody(
  state: BlockState,
  node: TianziAstNode,
  index: NodeIndex,
  name: string,
  input = "BODY",
) {
  const captured = group(node, name);
  const child = index.choose(captured?.span);
  if (child) setInput(state, input, { block: buildNode(child, index) });
  else setInput(state, input, { shadow: literal(captured?.text ?? "") });
}

/** A statement input; plain text becomes a 文本 block in the chain. */
function setStatement(
  state: BlockState,
  node: TianziAstNode,
  index: NodeIndex,
  name: string,
  input = "BODY",
) {
  const captured = group(node, name);
  const child = index.choose(captured?.span);
  setInput(state, input, {
    block: child
      ? buildNode(child, index)
      : { type: "text_multiline", fields: { TEXT: captured?.text ?? "" } },
  });
}

function isNumeric(text: string): boolean {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim());
}

/** Links blocks into one statement chain and returns its first block. */
function chain(states: BlockState[]): BlockState | undefined {
  for (let index = 0; index < states.length - 1; index++)
    states[index].next = { block: states[index + 1] };
  return states[0];
}

/** A statement input filled with a chain of blocks. */
function wrapper(
  type: string,
  input: string,
  states: BlockState[],
  fields?: Record<string, unknown>,
): BlockState {
  const state: BlockState = { type };
  if (fields) state.fields = fields;
  const first = chain(states);
  if (first) setInput(state, input, { block: first });
  return state;
}

// Block builders =============================================================

const BUILDERS: Record<
  string,
  (node: TianziAstNode, index: NodeIndex) => BlockState
> = {
  ImmediateNumbers(node, index) {
    const state: BlockState = { type: "number" };
    const captured = group(node, "val");
    const child = index.choose(captured?.span);
    if (child) setInput(state, "TEXT", { block: buildNode(child, index) });
    else if (captured && isNumeric(captured.text))
      setSlot(state, "number", "TEXT", Number(captured.text));
    else setInput(state, "TEXT", { shadow: literal(captured?.text ?? "") });
    return state;
  },

  Calculate(node, index) {
    const state: BlockState = { type: "calculate" };
    setSlotOrChild(state, "calculate", node, index, "TEXT", "expr");
    return state;
  },

  Range(node, index) {
    const state: BlockState = { type: "range" };
    setSlotOrChild(state, "range", node, index, "LEFT", "left");
    setSlotOrChild(state, "range", node, index, "RIGHT", "right");
    if (group(node, "fspec"))
      setSlotOrChild(state, "range", node, index, "FSPEC", "fspec");
    if (group(node, "fusr"))
      setSlotOrChild(state, "range", node, index, "FUSR", "fusr");
    const rand = groupText(node, "rand");
    if (rand !== undefined) setSlot(state, "range", "DIST", rand);
    if (group(node, "rname"))
      setSlotOrChild(state, "range", node, index, "RNAME", "rname");
    if (group(node, "cname"))
      setSlotOrChild(state, "range", node, index, "CNAME", "cname");
    const count = groupText(node, "count");
    if (count !== undefined) {
      setSlot(state, "range", "CSEP", groupText(node, "csep") ?? "");
      setSlot(state, "range", "COUNT", count);
    }
    return state;
  },

  Format(node, index) {
    const state: BlockState = { type: "format" };
    setBody(state, node, index, "target");
    // The block's slots start on ".2f" and "d"; clear them when the text did
    // not specify a format, or the defaults would leak into the output.
    if (group(node, "fspec"))
      setSlotOrChild(state, "format", node, index, "FSPEC", "fspec");
    else setSlot(state, "format", "FSPEC", "");
    if (group(node, "fusr"))
      setSlotOrChild(state, "format", node, index, "FUSR", "fusr");
    else setSlot(state, "format", "FUSR", "");
    if (group(node, "cname"))
      setSlotOrChild(state, "format", node, index, "CNAME", "cname");
    return state;
  },

  StrFilter(node, index) {
    const state: BlockState = {
      type: "transform",
      fields: { OP: requiredGroup(node, "op").text },
    };
    setSlotOrChild(state, "transform", node, index, "BODY", "target");
    if (group(node, "cname"))
      setSlotOrChild(state, "transform", node, index, "CNAME", "cname");
    return state;
  },

  Font(node, index) {
    const state: BlockState = {
      type: "transform",
      fields: { OP: requiredGroup(node, "font").text },
    };
    setSlotOrChild(state, "transform", node, index, "BODY", "target");
    if (group(node, "charset"))
      setSlotOrChild(state, "transform", node, index, "CHARSET", "charset");
    if (group(node, "cname"))
      setSlotOrChild(state, "transform", node, index, "CNAME", "cname");
    return state;
  },

  Slice(node, index) {
    const state: BlockState = { type: "slice" };
    setSlotOrChild(state, "slice", node, index, "BODY", "target");
    for (const [input, name] of [
      ["START", "start"],
      ["STOP", "stop"],
      ["STEP", "step"],
    ] as const)
      if (group(node, name))
        setSlotOrChild(state, "slice", node, index, input, name);
    return state;
  },

  Repeat(node, index) {
    const state: BlockState = { type: "controls_repeat" };
    setSlotOrChild(state, "controls_repeat", node, index, "TIMES", "num");
    setStatement(state, node, index, "target");
    state.fields = { LAZY: groupText(node, "ast") !== "*" };
    return state;
  },

  Choice(node, index) {
    const items = splitItems(node, index);
    if (items.length === 0) throw new TextImportError("选择块没有任何候选");
    const state: BlockState = { type: "choice" };
    items.forEach((item, position) =>
      setInput(state, `ITEM${position}`, itemState(item, index)),
    );
    state.extraState = { itemCount: items.length };
    return state;
  },

  ReduceCalc(node, index) {
    const state: BlockState = { type: "reduce_calc" };
    setSlotOrChild(state, "reduce_calc", node, index, "OP", "op");
    setSlotOrChild(state, "reduce_calc", node, index, "SEP", "sep");
    const items = splitItems(node, index);
    if (items.length === 0) throw new TextImportError("归约块没有任何分段");
    items.forEach((item, position) =>
      setInput(state, `ITEM${position}`, itemState(item, index)),
    );
    state.extraState = { itemCount: items.length };
    return state;
  },

  Lex(node) {
    const name = requiredGroup(node, "lex").text;
    const state: BlockState = {
      type: "lexicon",
      fields: { NAME: name, FIELD: groupText(node, "colname") ?? "" },
    };
    const query = node.query;
    if (query?.error)
      throw new TextImportError(`词库查询语法有误：${query.error}`);
    const conditions = query ? queryStates(query.ast ?? []) : [];
    const first = chain(conditions);
    if (first) setInput(state, "QUERY", { block: first });
    return state;
  },

  Alias(node) {
    return {
      type: "macro",
      fields: { MACRO: requiredGroup(node, "alias").text },
    };
  },

  Assign(node, index) {
    requiredGroup(node, "cname");
    const echo = (groupText(node, "output") ?? "") !== "";
    const state: BlockState = { type: "variables_set" };
    // The 写名 is a value slot, so it accepts both plain text and a nested
    // expression.
    setSlotOrChild(state, "variables_set", node, index, "VAR", "cname");
    state.fields = { ECHO: echo };
    setBody(state, node, index, "val");
    return state;
  },

  Reference(node) {
    return {
      type: "variables_get",
      fields: { VAR: { name: requiredGroup(node, "rname").text } },
    };
  },

  LingerRef(node, index) {
    const state: BlockState = { type: "variables_get_linger" };
    setSlotOrChild(state, "variables_get_linger", node, index, "SCOPE", "cname");
    return state;
  },

  LingerAssign(node, index) {
    const state: BlockState = { type: "variables_set_linger" };
    const names = requiredGroup(node, "val");
    const child = index.choose(names.span);
    if (child) setInput(state, "VAR", { block: buildNode(child, index) });
    // An empty list means "export every cached name"; leave the slot empty
    // rather than creating a variable with an empty name.
    else if (names.text)
      setSlot(state, "variables_set_linger", "VAR", names.text);
    setSlotOrChild(state, "variables_set_linger", node, index, "SCOPE", "cname");
    return state;
  },

  InnerValAssign(node, index) {
    // FIELD starts on "Range", and the block cannot represent an inner-value
    // write without a scope (the engine rejects it too).
    if (!group(node, "field"))
      throw new TextImportError("内部值写入缺少作用域");
    const state: BlockState = { type: "inner_value_set" };
    setSlotOrChild(state, "inner_value_set", node, index, "FIELD", "field");
    setSlotOrChild(state, "inner_value_set", node, index, "NAME", "cname");
    setBody(state, node, index, "val");
    state.fields = { ECHO: (groupText(node, "output") ?? "") !== "" };
    return state;
  },

  InnerValRef(node, index) {
    const state: BlockState = { type: "inner_value_get" };
    if (group(node, "field"))
      setSlotOrChild(state, "inner_value_get", node, index, "FIELD", "field");
    setSlotOrChild(state, "inner_value_get", node, index, "NAME", "cname");
    return state;
  },

  Config(node) {
    return {
      type: "config",
      fields: { ITEM: requiredGroup(node, "item").text },
    };
  },

  Nocensor(node, index) {
    const state: BlockState = { type: "nocensor" };
    setSlotOrChild(state, "nocensor", node, index, "OTP", "otp");
    return state;
  },

  Reset(node, index) {
    const state: BlockState = { type: "reset" };
    if (group(node, "seed"))
      setSlotOrChild(state, "reset", node, index, "SEED", "seed");
    return state;
  },
};

function buildNode(node: TianziAstNode, index: NodeIndex): BlockState {
  const build = BUILDERS[node.syntax];
  if (!build)
    throw new TextImportError(`暂不支持导入这种语法：${node.syntax}`);
  return build(node, index);
}

// Multi-item expressions =====================================================

interface Item {
  child?: TianziAstNode;
  text?: string;
}

function itemState(item: Item, index: NodeIndex): {
  block?: BlockState;
  shadow?: BlockState;
} {
  return item.child
    ? { block: buildNode(item.child, index) }
    : { shadow: literal(item.text ?? "") };
}

/**
 * Splits the `main` capture of Choice/ReduceCalc into items. Nested `[[…]]`
 * children are kept whole, so a separator inside a nested expression cannot
 * cut an item in half.
 */
function splitItems(node: TianziAstNode, index: NodeIndex): Item[] {
  const main = group(node, "main");
  if (!main) throw new TextImportError(`${node.syntax} 缺少 main 部分`);
  const separator = groupText(node, "sep") ?? "";
  const start = main.span[0];
  const children = index
    .childrenOf(node.field_span)
    .filter((child) => child.span[0] >= main.span[0] && child.span[1] <= main.span[1])
    .map((child) => ({
      start: child.span[0] - start,
      end: child.span[1] - start,
      node: child.node,
    }));

  const items: Item[] = [];
  let position = 0;
  let literalStart = 0;
  let nextChild = 0;

  const pushLiteral = (end: number) => {
    const text = main.text.slice(literalStart, end);
    if (text !== "") items.push({ text });
  };

  while (position < main.text.length) {
    const child = children[nextChild];
    if (child && position === child.start) {
      pushLiteral(position);
      items.push({ child: child.node });
      position = child.end;
      literalStart = position;
      nextChild++;
      continue;
    }
    if (separator && main.text.startsWith(separator, position)) {
      pushLiteral(position);
      position += separator.length;
      literalStart = position;
      continue;
    }
    position++;
  }
  pushLiteral(main.text.length);
  return items;
}

// Lexicon queries ============================================================

const LENGTH_COMPARISON: Record<string, string> = {
  "": "eq",
  ">": "gt",
  "<": "lt",
  ">=": "gte",
  "<=": "lte",
};

function queryStates(nodes: readonly TianziQueryNode[]): BlockState[] {
  const root = nodes[0];
  if (!root) return [];
  return queryNode(root);
}

function queryNode(node: TianziQueryNode): BlockState[] {
  if (node.kind === "and") {
    const states: BlockState[] = [];
    for (const child of node.children ?? []) {
      // A nested OR would need DNF expansion; the generator never emits it.
      if (child.kind === "or")
        throw new TextImportError("暂不支持嵌套的或分支");
      states.push(...queryNode(child));
    }
    return states;
  }
  if (node.kind === "or") {
    const states: BlockState[] = [];
    let first = true;
    for (const child of node.children ?? []) {
      if (!first) states.push({ type: "lexicon_or" });
      first = false;
      states.push(...queryNode(child));
    }
    return states;
  }
  if (node.kind === "seg") return segmentStates(node);
  throw new TextImportError(`暂不支持的查询节点：${node.kind}`);
}

function segmentStates(segment: TianziQueryNode): BlockState[] {
  const conditions = (segment.children ?? [])
    .filter((child) => child.kind === "tok")
    .map(tokenState);
  if (conditions.length === 0) throw new TextImportError("查询段为空");

  let states = conditions;
  if (segment.neg) states = [wrapper("lexicon_not", "ITEM", states)];
  if (segment.group)
    states = [wrapper("lexicon_group", "ITEM", states, { GROUP: segment.group })];
  return states;
}

function tokenValue(token: TianziQueryNode, name: string): string {
  const value = token.groups?.[name];
  if (value === undefined || value === "")
    throw new TextImportError(`查询条件缺少 ${name}`);
  return value;
}

function tokenState(token: TianziQueryNode): BlockState {
  const value = (name: string) => tokenValue(token, name);

  switch (token.schema) {
    case "SPinyin": {
      const state: BlockState = { type: "lexicon_pinyin" };
      setSlot(state, "lexicon_pinyin", "PATTERN", value("pinyin"));
      return state;
    }
    case "SPinyinRegex": {
      const state: BlockState = { type: "lexicon_pinyin_regex" };
      setSlot(state, "lexicon_pinyin_regex", "PATTERN", value("regex"));
      return state;
    }
    case "SWordLength": {
      const state: BlockState = {
        type: "lexicon_length",
        fields: {
          COMPARISON: LENGTH_COMPARISON[token.groups?.o ?? ""] ?? "eq",
        },
      };
      setSlot(state, "lexicon_length", "LENGTH", value("l"));
      return state;
    }
    case "SPath": {
      const state: BlockState = {
        type: "lexicon_path",
        fields: {
          DEPTH: token.groups?.getall ? "descendants" : "children",
        },
      };
      setSlot(state, "lexicon_path", "PATH", `/${value("path")}`);
      return state;
    }
    case "SEnum": {
      return {
        type: "lexicon_enum",
        fields: { VALUE: value("enum") },
      };
    }
    case "SPos": {
      const state: BlockState = { type: "lexicon_index" };
      setSlot(state, "lexicon_index", "START", value("start"));
      setSlot(state, "lexicon_index", "END", value("stop"));
      return state;
    }
    case "SRegex": {
      const state: BlockState = { type: "lexicon_regex" };
      setSlot(state, "lexicon_regex", "SOURCE", value("regex"));
      return state;
    }
    default:
      throw new TextImportError(
        `暂不支持导入这种查询条件：${token.schema ?? token.text}`,
      );
  }
}

// Entry point ================================================================

/**
 * Rebuilds the program described by `stack`. Returns the root of the statement
 * chain (the blocks are linked through `next`). Throws `TextImportError` when
 * a field cannot be recognised.
 */
export function blocksFromStack(stack: TianziStack): BlockState[] {
  const index = new NodeIndex(stack.ast);

  const tops = new Map<string, TianziAstNode[]>();
  for (const node of stack.ast) {
    if (!isSpan(node.field_span)) continue;
    const key = spanKey(node.field_span);
    const list = tops.get(key);
    if (list) list.push(node);
    else tops.set(key, [node]);
  }

  const fields = [...tops.values()]
    .map((nodes) => {
      const node = chooseNode(nodes);
      if (!node)
        throw new TextImportError(`无法识别这段文本：${nodes[0]?.text ?? ""}`);
      return node;
    })
    .sort((a, b) => a.field_span[0] - b.field_span[0]);

  const states: BlockState[] = [];
  let cursor = 0;
  for (const node of fields) {
    const [start, end] = node.field_span;
    if (start > cursor) {
      const text = stack.input.slice(cursor, start);
      if (text) states.push({ type: "text_multiline", fields: { TEXT: text } });
    }
    states.push(buildNode(node, index));
    cursor = Math.max(cursor, end);
  }
  if (cursor < stack.input.length) {
    const text = stack.input.slice(cursor);
    if (text) states.push({ type: "text_multiline", fields: { TEXT: text } });
  }

  chain(states);
  // Only the chain's first block is a top block; the rest hang off `next`.
  return states.length > 0 ? [states[0]] : [];
}

/** Serialized workspace state; top-level blocks are chained. */
export function workspaceStateFromStack(stack: TianziStack): ImportedWorkspace {
  return {
    blocks: { languageVersion: 1, blocks: blocksFromStack(stack) },
  };
}
