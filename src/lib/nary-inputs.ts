/**
 * Auto-growing value inputs for choice/reduce_calc.
 *
 * These two blocks are n-ary string expressions: one slot per alternative (or
 * per segment before a reduction), with one spare slot after the last filled
 * one. The input count is saved in extra state so a reloaded block keeps its
 * empty slots.
 */

import * as Blockly from "blockly";
import { SHADOW_SLOTS, shadowState } from "./shadow-slots";

const PREFIX = "ITEM";

/** The reductions offered by reduce_calc, as a replaceable dropdown slot. */
const REDUCE_OPS: Blockly.MenuOption[] = [
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
];

// Older saved workspaces keep the operator and separator as fields; the
// migrator moves them into the slots they now belong to.
SHADOW_SLOTS.set("reduce_calc", [
  {
    input: "OP",
    shadowType: "literal_dropdown",
    value: "+",
    options: REDUCE_OPS,
  },
  { input: "SEP", shadowType: "literal_text", value: "，" },
]);

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
        helpUrl: "https://tianzi.hongbot.icu/howto#选择",
      });
      this.setPreviousStatement(true, "TzText");
      this.setNextStatement(true, "TzText");
      setupNaryInputs(this, 2);
    },
  },
  reduce_calc: {
    init(this: Blockly.Block) {
      this.jsonInit({
        message0: "# %1 分隔符 %2 %3",
        args0: [
          { type: "input_value", name: "OP" },
          { type: "input_value", name: "SEP" },
          { type: "input_value", name: "ITEM0", check: ["String"] }
        ],
        output: "String",
        style: "math_blocks",
        inputsInline: false,
        tooltip: "把各段按同一个分隔符拆开后从左到右做归约运算",
        helpUrl: "https://tianzi.hongbot.icu/howto#ReduceCalc",
      });
      // The operator and separator are editable literals, not fixed choices,
      // so an expression can be dropped onto either slot.
      this.getInput("OP")?.connection?.setShadowState(
        shadowState({
          input: "OP",
          shadowType: "literal_dropdown",
          value: "+",
          options: REDUCE_OPS,
        }),
      );
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
