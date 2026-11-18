/**
 * Auto-growing value inputs for choice/reduce_calc.
 *
 * These two blocks are n-ary string expressions: one slot per alternative (or
 * per segment before a reduction), with one spare slot after the last filled
 * one. The input count is saved in extra state so a reloaded block keeps its
 * empty slots.
 */

import * as Blockly from "blockly";

const PREFIX = "ITEM";

function inputCount(block: Blockly.Block): number {
  let count = 0;
  while (block.getInput(`${PREFIX}${count}`)) count++;
  return count;
}

function ensureInputs(
  block: Blockly.Block,
  checks: string[] | null,
  count: number,
) {
  for (let index = 0; index < count; index++) {
    if (!block.getInput(`${PREFIX}${index}`))
      block.appendValueInput(`${PREFIX}${index}`).setCheck(checks);
  }
}

/** Keep one empty slot after the last filled one. */
function syncSpareInputs(
  block: Blockly.Block,
  checks: string[] | null,
  minimum = 1,
): boolean {
  let count = 0;
  let lastFilled = -1;
  while (block.getInput(`${PREFIX}${count}`)) {
    if (block.getInputTargetBlock(`${PREFIX}${count}`)) lastFilled = count;
    count++;
  }

  const needed = Math.max(minimum, lastFilled + 2);
  let changed = false;
  for (let index = count - 1; index >= needed; index--) {
    block.removeInput(`${PREFIX}${index}`);
    changed = true;
  }
  for (let index = count; index < needed; index++) {
    block.appendValueInput(`${PREFIX}${index}`).setCheck(checks);
    changed = true;
  }
  if (changed && block instanceof Blockly.BlockSvg && block.rendered)
    block.render();
  return changed;
}

const LISTENER_FLAG = "ZiBlockNaryListener";

function watchSpareInputs(
  block: Blockly.Block,
  checks: string[] | null,
  minimum = 1,
) {
  type Watched = Blockly.Block & { [LISTENER_FLAG]?: boolean };
  const watched = block as Watched;
  if (block.workspace.isFlyout || watched[LISTENER_FLAG]) return;
  watched[LISTENER_FLAG] = true;
  block.workspace.addChangeListener(() => {
    if (!block.isDisposed()) syncSpareInputs(block, checks, minimum);
  });
}

function setupNaryInputs(block: Blockly.Block, minimum = 1) {
  const checks = ["String"];
  block.setInputsInline(false);
  syncSpareInputs(block, checks, minimum);
  watchSpareInputs(block, checks, minimum);

  block.saveExtraState = () => ({ itemCount: inputCount(block) });
  block.loadExtraState = (state: { itemCount?: number }) => {
    ensureInputs(
      block,
      checks,
      Math.max(minimum, Math.floor(Number(state?.itemCount)) || minimum),
    );
  };
}

// These two blocks live in code instead of blocks.yml: the n-ary inputs and
// their extra state are part of init, which a non-mutator extension is not
// allowed to change.

Blockly.common.defineBlocks({
  choice: {
    init(this: Blockly.Block) {
      this.jsonInit({
        message0: "选择 %1",
        args0: [{ type: "input_value", name: "ITEM0", check: ["String"] }],
        output: "String",
        style: "math_blocks",
        inputsInline: false,
        tooltip: "在多个候选里随机选一个；每个候选是一个表达式",
      });
      this.setPreviousStatement(true, "TzText");
      this.setNextStatement(true, "TzText");
      setupNaryInputs(this, 2);
    },
  },
  reduce_calc: {
    init(this: Blockly.Block) {
      this.jsonInit({
        message0: "# %1 分隔 %2 %3",
        args0: [
          {
            type: "field_dropdown",
            name: "OP",
            options: [
              ["加", "+"],
              ["减", "-"],
              ["乘", "*"],
              ["除", "/"],
              ["整除", "//"],
              ["取余", "%"],
              ["幂", "**"],
              ["按位与", "&"],
              ["按位或", "|"],
              ["按位异或", "^"],
            ],
          },
          { type: "input_value", name: "SEP" },
          { type: "input_value", name: "ITEM0", check: ["String"] }
        ],
        output: "String",
        style: "math_blocks",
        inputsInline: false,
        tooltip: "把各段按同一个分隔符拆开后从左到右做归约运算",
      });
      // The separator is an editable literal, not a fixed dropdown, so it can
      // also be supplied by an expression.
      this.getInput("SEP")?.connection?.setShadowState({
        type: "literal_text",
        fields: { TEXT: "，" },
      });
      this.setPreviousStatement(true, "TzText");
      this.setNextStatement(true, "TzText");
      setupNaryInputs(this);
    },
  },
});
