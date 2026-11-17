/**
 * Gear (mutator) for the lexicon block.
 *
 * Instead of attaching query condition blocks to the lexicon block itself, the
 * whole query is edited in the gear bubble: the bubble's flyout offers the
 * condition blocks, and the root block exposes one external input per condition
 * plus one spare. The conditions are stored as a list of block states in the
 * lexicon block's extra state, so they survive save/load and can be regenerated
 * outside the bubble.
 */

import * as Blockly from "blockly";
import {
  joinQueryBlocks,
  queryDslFromStates,
} from "./generator";
import {
  CONDITION_KINDS,
  lexiconBlockName,
  refreshLexiconChildren,
  syncSpareInputs,
  watchSpareInputs,
} from "./lexicon-ui";
import {
  getCachedLexiconMeta,
  groupsForCondition,
  loadLexiconMeta,
  type LexiconMeta,
} from "./lexicons";

const ROOT_TYPE = "lexicon_mutator_root";
const INPUT_PREFIX = "ITEM";
const SUMMARY_LIMIT = 20;

const INPUT_CHECKS = [
  "Cond:pinyin",
  "Cond:wordLength",
  "Cond:path",
  "Cond:enumValue",
  "Cond:index",
  "Cond:regex",
  "TzSegment",
  "TzClause",
  "TzQuery",
];

/** Blocks offered by the gear bubble's flyout. */
export const QUERY_BLOCK_TYPES = [
  "lexicon_pinyin",
  "lexicon_word_length",
  "lexicon_path",
  "lexicon_enum",
  "lexicon_index",
  "lexicon_regex",
  "lexicon_group",
  "lexicon_not",
  "lexicon_and",
  "lexicon_or",
];

type BlockState = Blockly.serialization.blocks.State;

type LexiconBlock = Blockly.Block & {
  queryStates?: BlockState[];
};

type RootBlock = Blockly.Block & { lexiconName?: string };

function summarizeDsl(dsl: string): string {
  if (!dsl) return "无";
  return dsl.length > SUMMARY_LIMIT ? `${dsl.slice(0, SUMMARY_LIMIT)}…` : dsl;
}

/** The dummy input holding the query summary row. */
function summaryRow(block: Blockly.Block): Blockly.Input | undefined {
  const field = block.getField("SUMMARY");
  return field
    ? block.inputList.find((input) => input.fieldRow.includes(field))
    : undefined;
}

function setSummary(block: Blockly.Block, text: string) {
  // Derived from the query; do not fire a change event for it.
  block.getField("SUMMARY")?.setValue(text, false);

  // Hide the whole row while there is nothing to summarise.
  const visible = text !== "无";
  const row = summaryRow(block);
  if (row && row.isVisible() !== visible) {
    row.setVisible(visible);
    if (block instanceof Blockly.BlockSvg && block.rendered) block.render();
  }
}

function summarizeStates(block: LexiconBlock): string {
  const name = String(block.getFieldValue("NAME") ?? "");
  try {
    return summarizeDsl(queryDslFromStates(block.queryStates, name));
  } catch {
    return "查询有误";
  }
}

/** Condition blocks currently connected to the root's slots, in order. */
function queryBlocks(root: Blockly.Block): Blockly.Block[] {
  const blocks: Blockly.Block[] = [];
  for (let index = 0; root.getInput(`${INPUT_PREFIX}${index}`); index++) {
    const block = root.getInputTargetBlock(`${INPUT_PREFIX}${index}`);
    if (block) blocks.push(block);
  }
  return blocks;
}

/** Condition block types this lexicon cannot run. */
function unsupportedTypes(meta: LexiconMeta): Set<string> {
  const unsupported = new Set<string>();
  for (const [type, kind] of Object.entries(CONDITION_KINDS)) {
    // Index queries are global; they are not bound to a schema group.
    if (!kind || kind === "index") continue;
    if (groupsForCondition(meta, kind).length === 0) unsupported.add(type);
  }
  if (meta.schemas.length === 0) unsupported.add("lexicon_group");
  return unsupported;
}

/** Greys out and locks flyout blocks the current lexicon cannot run. */
function updateFlyoutAvailability(root: Blockly.Block) {
  const workspace = root.workspace;
  if (!(workspace instanceof Blockly.WorkspaceSvg)) return;
  const name = lexiconBlockName(root);
  const meta = name ? getCachedLexiconMeta(name) : undefined;
  if (!meta) return;

  const unsupported = unsupportedTypes(meta);
  const flyout = workspace.getFlyout();
  for (const block of flyout?.getWorkspace().getTopBlocks(false) ?? [])
    block.setDisabledReason(
      unsupported.has(block.type),
      "MANUALLY_DISABLED",
    );
}

// Root block of the gear bubble. It stands in for the lexicon block (so
// conditions are validated against the lexicon's meta) and holds every
// condition in its own external input.
Blockly.common.defineBlocks({
  [ROOT_TYPE]: {
    init(this: Blockly.Block) {
      // First condition on the header row (like 非); later ones get their own
      // row because extra inputs are not inline.
      this.jsonInit({
        message0: "查询 %1",
        args0: [
          { type: "input_value", name: `${INPUT_PREFIX}0`, check: INPUT_CHECKS },
        ],
        style: "text_blocks",
        tooltip: "条件按「与」组合；末尾始终留一个空槽用于继续添加",
      });
      this.setInputsInline(false);
      syncSpareInputs(this, INPUT_PREFIX, INPUT_CHECKS);
      watchSpareInputs(this, INPUT_PREFIX, INPUT_CHECKS);
      // Re-run validation as conditions are connected or edited.
      if (!this.workspace.isFlyout)
        this.workspace.addChangeListener(() => {
          if (!this.isDisposed()) refreshLexiconChildren(this);
        });
    },
  },
});

Blockly.Extensions.registerMutator(
  "lexicon_mutator",
  {
    decompose(this: LexiconBlock, workspace: Blockly.Workspace): Blockly.Block {
      const root = workspace.newBlock(ROOT_TYPE);
      if (root instanceof Blockly.BlockSvg) root.initSvg();
      const name = String(this.getFieldValue("NAME") ?? "");
      (root as RootBlock).lexiconName = name;

      const states = this.queryStates ?? [];
      for (let index = 0; index < states.length; index++) {
        if (!root.getInput(`${INPUT_PREFIX}${index}`))
          root.appendValueInput(`${INPUT_PREFIX}${index}`).setCheck(INPUT_CHECKS);
      }
      states.forEach((state, index) => {
        const tree = Blockly.serialization.blocks.append(state, workspace);
        const connection = root.getInput(`${INPUT_PREFIX}${index}`)?.connection;
        if (connection && tree.outputConnection)
          connection.connect(tree.outputConnection);
      });
      syncSpareInputs(root, INPUT_PREFIX, INPUT_CHECKS);

      updateFlyoutAvailability(root);
      // The flyout fills itself when the bubble opens; re-apply once its blocks
      // exist (and if they are ever rebuilt).
      if (workspace instanceof Blockly.WorkspaceSvg)
        workspace
          .getFlyout()
          ?.getWorkspace()
          .addChangeListener(() => {
            if (!root.isDisposed()) updateFlyoutAvailability(root);
          });
      refreshLexiconChildren(root);
      if (name)
        void loadLexiconMeta(name)
          .then(() => {
            if (!root.isDisposed()) {
              refreshLexiconChildren(root);
              updateFlyoutAvailability(root);
            }
          })
          .catch(() => {});
      return root;
    },

    compose(this: LexiconBlock, root: Blockly.Block) {
      const blocks = queryBlocks(root);
      this.queryStates = blocks
        .map((block) => Blockly.serialization.blocks.save(block))
        .filter((state): state is BlockState => !!state);

      let summary = "无";
      if (blocks.length) {
        try {
          summary = summarizeDsl(joinQueryBlocks(blocks));
        } catch {
          summary = "查询有误";
        }
      }
      setSummary(this, summary);
    },

    saveExtraState(this: LexiconBlock) {
      return this.queryStates?.length ? { queries: this.queryStates } : {};
    },

    loadExtraState(
      this: LexiconBlock,
      state: { queries?: BlockState[]; query?: BlockState },
    ) {
      // `query` is the single-tree format used before multi-slot queries.
      this.queryStates = state?.queries ?? (state?.query ? [state.query] : []);
      setSummary(this, summarizeStates(this));
    },
  },
  function (this: LexiconBlock) {
    this.queryStates = [];
    setSummary(this, "无");
  },
  QUERY_BLOCK_TYPES,
);
