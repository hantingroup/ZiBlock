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

const DISABLED_REASON = "ziblock-no-code";

/**
 * 或者 only splits the query into OR branches; it never emits code of its own,
 * even when the query is complete. Every other query block (conditions and the
 * 取反/组 wrappers) does emit code once filled in, so an empty one greys out
 * like any other incomplete block.
 */
const QUERY_SEPARATORS = new Set(["lexicon_or"]);

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

export function updateBlockEffectiveness(block: Blockly.Block): boolean {
  if (QUERY_SEPARATORS.has(block.type) || SHADOW_TYPES.has(block.type))
    return false;

  const noCode = blockCode(block) === "";
  if (block.hasDisabledReason(DISABLED_REASON) === noCode) return false;
  block.setDisabledReason(noCode, DISABLED_REASON);
  return true;
}

export function refreshBlockEffectiveness(workspace: Blockly.Workspace) {
  const blocks = workspace.getAllBlocks(false);
  // A wrapper's code depends on whether its children still generate code, and
  // children are visited after their parent; repeat until the state settles.
  for (let pass = 0; pass <= blocks.length; pass++) {
    let changed = false;
    for (const block of blocks)
      changed = updateBlockEffectiveness(block) || changed;
    if (!changed) break;
  }
}
