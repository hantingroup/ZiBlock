/**
 * Disabled state for blocks that currently contribute no code.
 *
 * An incomplete block (an empty filter, an empty slice, …) generates an empty
 * string. Blockly's disabled state is the right visual for that: the block is
 * greyed out and skipped by code generation, but can still be edited and
 * connected. The state is re-evaluated after every change.
 */

import * as Blockly from "blockly";
import Generator from "./generator";

/** Query-editor blocks are line fragments, not standalone expressions. */
const DISABLED_REASON = "ziblock-no-code";

const QUERY_TYPES = new Set([
  "lexicon_or",
  "lexicon_not",
  "lexicon_group",
  "lexicon_pinyin",
  "lexicon_length",
  "lexicon_path",
  "lexicon_enum",
  "lexicon_index",
  "lexicon_regex",
]);

/** Literal shadows render as editable fields, not as standalone blocks. */
const SHADOW_TYPES = new Set([
  "literal_text",
  "literal_multiline",
  "literal_number",
  "literal_dropdown",
]);

/**
 * The block's own code, ignoring its disabled state. Calling blockToCode would
 * return an empty string for an already-disabled block, so it could never be
 * enabled again after the user fills it in.
 */
function blockCode(block: Blockly.Block): string {
  const generate = Generator.forBlock[block.type];
  if (typeof generate !== "function") return "";
  try {
    const code = generate(block, Generator);
    return Array.isArray(code) ? code[0] : (code ?? "");
  } catch {
    return "";
  }
}

export function updateBlockEffectiveness(block: Blockly.Block) {
  if (QUERY_TYPES.has(block.type) || SHADOW_TYPES.has(block.type)) return;

  const noCode = blockCode(block) === "";
  if (block.hasDisabledReason(DISABLED_REASON) !== noCode)
    block.setDisabledReason(noCode, DISABLED_REASON);
}

export function refreshBlockEffectiveness(workspace: Blockly.Workspace) {
  for (const block of workspace.getAllBlocks(false))
    updateBlockEffectiveness(block);
}
