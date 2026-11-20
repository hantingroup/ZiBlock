/**
 * Where a query block sits in the lexicon tree.
 *
 * Conditions live in the query stack of a lexicon block, possibly inside a
 * 取反/组 wrapper. Code generation and the block UI both look up that context;
 * keeping the helpers in one place lets the generator work without importing
 * the field or extension modules.
 */

import * as Blockly from "blockly";
import type { Condition } from "./lexicon-query";

/** Block type → DSL condition kind for the query condition blocks. */
export const CONDITION_KINDS: Record<string, Condition["kind"] | undefined> = {
  lexicon_pinyin: "pinyin",
  lexicon_pinyin_regex: "pinyinRegex",
  lexicon_length: "wordLength",
  lexicon_path: "path",
  lexicon_enum: "enumValue",
  lexicon_index: "index",
  lexicon_regex: "regex",
};

/** Nearest enclosing lexicon block, if the block sits inside one. */
export function findEnclosingLexicon(
  block: Blockly.Block,
): Blockly.Block | undefined {
  for (
    let parent = block.getSurroundParent();
    parent;
    parent = parent.getSurroundParent()
  ) {
    if (parent.type === "lexicon") return parent;
  }
  return undefined;
}

/** Name of a lexicon block. */
export function lexiconBlockName(block: Blockly.Block): string {
  return String(block.getFieldValue("NAME") ?? "");
}

/** Nearest enclosing 组 wrapper, if the block sits inside one. */
export function findEnclosingGroup(
  block: Blockly.Block,
): Blockly.Block | undefined {
  for (
    let parent = block.getSurroundParent();
    parent;
    parent = parent.getSurroundParent()
  ) {
    if (parent.type === "lexicon_group") return parent;
    if (parent.type === "lexicon") return undefined;
  }
  return undefined;
}

/** Name of the lexicon this block belongs to, or "" outside one. */
export function lexiconName(block: Blockly.Block): string {
  const lexicon = findEnclosingLexicon(block);
  return lexicon ? lexiconBlockName(lexicon) : "";
}

/** DSL condition kind produced by this condition block. */
export function conditionKind(
  block: Blockly.Block,
): Condition["kind"] | undefined {
  return CONDITION_KINDS[block.type];
}
