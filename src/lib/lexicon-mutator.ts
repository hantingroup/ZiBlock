/**
 * Gear (mutator) for the lexicon block.
 *
 * Instead of attaching query condition blocks to the lexicon block itself, the
 * whole query is edited in the gear bubble. A query is a vertical chain of
 * branches joined with `|`: the root block is the first branch, and each block
 * connected below it is another. Inside one branch, each slot is a segment
 * joined with `&` and has its own 非 checkbox, so `a & !b` is expressible.
 *
 * The branches are stored as serialized condition states in the lexicon
 * block's extra state, so they survive save/load and can be regenerated
 * outside the bubble.
 */

import * as Blockly from "blockly";
import {
  queryDslFromBranches,
  type QueryBranchItemState,
  type QueryBranchState,
} from "./generator";
import {
  CONDITION_TYPE,
  conditionKindLabel,
  effectiveConditionKind,
  FieldGroupName,
  lexiconBlockName,
  refreshLexiconChildren,
  syncSpareInputs,
  unsupportedConditionTypes,
  watchSpareInputs,
} from "./lexicon-ui";
import {
  conditionsForGroup,
  getCachedLexiconMeta,
  loadLexiconMeta,
} from "./lexicons";

const ROOT_TYPE = "lexicon_mutator_root";
const BRANCH_TYPE = "lexicon_branch";
const INPUT_PREFIX = "ITEM";
const SUMMARY_LIMIT = 20;

/** Conditions (or a grouped condition) make up one branch segment. */
const BRANCH_CHECKS = [...Object.values(CONDITION_TYPE), "TzSegment"];

/** Blocks offered by the gear bubble's flyout. */
export const QUERY_BLOCK_TYPES = [
  BRANCH_TYPE,
  "lexicon_length",
  "lexicon_pinyin",
  "lexicon_regex",
  "lexicon_index",
  "lexicon_enum",
  "lexicon_path",
];

type BlockState = Blockly.serialization.blocks.State;

type LexiconBlock = Blockly.Block & {
  queryBranches?: QueryBranchState[];
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

function summarizeBranches(block: LexiconBlock): string {
  const name = String(block.getFieldValue("NAME") ?? "");
  try {
    return summarizeDsl(queryDslFromBranches(block.queryBranches, name));
  } catch {
    return "查询有误";
  }
}

/** Blocks currently connected to one branch's slots, in order. */
function branchItems(
  block: Blockly.Block,
): { block: Blockly.Block; not: boolean; group?: string }[] {
  const items: {
    block: Blockly.Block;
    not: boolean;
    group?: string;
  }[] = [];
  for (let index = 0; block.getInput(`${INPUT_PREFIX}${index}`); index++) {
    const item = block.getInputTargetBlock(`${INPUT_PREFIX}${index}`);
    if (item)
      items.push({
        block: item,
        not: isNot(block, index),
        group: String(block.getFieldValue(`GROUP${index}`) ?? "") || undefined,
      });
  }
  return items;
}

function isNot(block: Blockly.Block, index: number): boolean {
  return block.getFieldValue(`NOT${index}`) === "TRUE";
}

/** The branch chain starting at the root, top to bottom. */
function branchChain(root: Blockly.Block): Blockly.Block[] {
  const blocks: Blockly.Block[] = [];
  for (let block: Blockly.Block | null = root; block; block = block.getNextBlock())
    blocks.push(block);
  return blocks;
}

/** Rebuilds the flyout without conditions the lexicon cannot run. */
let updatingFlyout = false;

function updateFlyoutAvailability(root: Blockly.Block) {
  if (updatingFlyout) return;
  const workspace = root.workspace;
  if (!(workspace instanceof Blockly.WorkspaceSvg)) return;
  const name = lexiconBlockName(root);
  const meta = name ? getCachedLexiconMeta(name) : undefined;
  if (!meta) return;

  const unsupported = unsupportedConditionTypes(meta);
  const flyout = workspace.getFlyout();
  if (!flyout) return;
  const contents: any[] = (flyout as any).getContents?.() ?? [];
  const blocked = contents.some((item) => {
    const type = item.getElement?.()?.type;
    return !!type && unsupported.has(type);
  });
  if (!blocked) return;

  updatingFlyout = true;
  try {
    // Recreate the flyout with the supported subset: this lays the blocks out
    // from scratch, so removed items do not leave gaps.
    flyout.show({
      kind: "flyoutToolbox",
      contents: QUERY_BLOCK_TYPES.filter(
        (type) => !unsupported.has(type),
      ).map((type) => ({ kind: "block", type })),
    } as any);
  } finally {
    updatingFlyout = false;
  }
}

// Branch blocks ==============================================================
//
// The root is the first branch; blocks chained below it are more OR branches.
// Every slot has its own schema group and 非 checkbox; the slots of one branch
// are joined with &.

const AUTO_GROUP: Blockly.MenuOption = ["自动", ""];

/** Name of the lexicon that the branch chain belongs to. */
function branchLexiconName(block: Blockly.Block): string {
  const top = block.getTopStackBlock();
  return top.type === ROOT_TYPE
    ? ((top as RootBlock).lexiconName ?? "")
    : "";
}

function branchGroupOptions(block: Blockly.Block): Blockly.MenuOption[] {
  const name = branchLexiconName(block);
  const meta = name ? getCachedLexiconMeta(name) : undefined;
  if (!meta) {
    if (name) void loadLexiconMeta(name).catch(() => {});
    return [AUTO_GROUP];
  }
  return [
    AUTO_GROUP,
    ...meta.schemas.map(
      ({ name: group }): Blockly.MenuOption => [group, group],
    ),
  ];
}

/** Narrows each slot to the kinds its own group supports. */
function validateBranch(block: Blockly.Block) {
  if (block.isDisposed()) return;
  const name = branchLexiconName(block);
  const meta = name ? getCachedLexiconMeta(name) : undefined;
  if (name && !meta) void loadLexiconMeta(name).catch(() => {});

  const warnings: string[] = [];
  for (let index = 0; block.getInput(`${INPUT_PREFIX}${index}`); index++) {
    const group = String(block.getFieldValue(`GROUP${index}`) ?? "");
    const kinds = meta && group ? conditionsForGroup(meta, group) : [];
    const checks = kinds.length
      ? kinds.map((kind) => CONDITION_TYPE[kind])
      : BRANCH_CHECKS;
    block.getInput(`${INPUT_PREFIX}${index}`)?.setCheck(checks);

    if (!meta || !group) continue;
    if (!meta.schemas.some((schema) => schema.name === group)) {
      warnings.push(`词库“${name}”没有组“${group}”`);
      continue;
    }
    const kind = effectiveConditionKind(
      block.getInputTargetBlock(`${INPUT_PREFIX}${index}`),
    );
    if (kind && !kinds.includes(kind))
      warnings.push(
        `组“${group}”不支持${conditionKindLabel(kind)}查询；可用：${kinds
          .map(conditionKindLabel)
          .join("、") || "无"}`,
      );
  }
  block.setWarningText(
    warnings.length ? [...new Set(warnings)].join("\n") : null,
  );
}

/** Adds the per-slot 非 checkbox and 组 dropdown to a branch input. */
function setupBranchInput(input: Blockly.Input, index: number) {
  if (!input.fieldRow.some((field) => field.name === `NOT${index}`))
    input.insertFieldAt(0, new Blockly.FieldCheckbox("FALSE"), `NOT${index}`);
  if (!input.fieldRow.some((field) => field.name === `NOT_LABEL${index}`))
    input.insertFieldAt(0, new Blockly.FieldLabel("非"), `NOT_LABEL${index}`);
  const block = input.getSourceBlock();
  if (!input.fieldRow.some((field) => field.name === `GROUP${index}`)) {
    const field = new FieldGroupName("");
    field.setOptions(() => branchGroupOptions(block));
    field.setOnChange(() => validateBranch(block));
    input.insertFieldAt(
      0,
      field as unknown as Blockly.Field<string>,
      `GROUP${index}`,
    );
  }
  if (!input.fieldRow.some((field) => field.name === `GROUP_LABEL${index}`))
    input.insertFieldAt(0, new Blockly.FieldLabel("组"), `GROUP_LABEL${index}`);
}

/** Hide 非/组 on empty slots; they only mean something when connected. */
function syncSlotVisibility(block: Blockly.Block) {
  for (let index = 0; block.getInput(`${INPUT_PREFIX}${index}`); index++) {
    const visible = !!block.getInputTargetBlock(`${INPUT_PREFIX}${index}`);
    for (const name of [
      `NOT${index}`,
      `NOT_LABEL${index}`,
      `GROUP${index}`,
      `GROUP_LABEL${index}`,
    ]) {
      const field = block.getField(name);
      if (field && field.isVisible() !== visible) field.setVisible(visible);
    }
  }
}

function defineBranchBlock(
  type: string,
  message: string,
  tooltip: string,
  hasPrevious: boolean,
) {
  Blockly.common.defineBlocks({
    [type]: {
      init(this: Blockly.Block) {
        this.jsonInit({
          message0: message,
          message1: "%1",
          args1: [
            {
              type: "input_value",
              name: `${INPUT_PREFIX}0`,
              check: BRANCH_CHECKS,
            },
          ],
          style: "text_blocks",
          tooltip,
          previousStatement: hasPrevious ? null : undefined,
          nextStatement: null,
        });
        this.setInputsInline(false);
        const first = this.getInput(`${INPUT_PREFIX}0`);
        if (first) setupBranchInput(first, 0);
        syncSpareInputs(
          this,
          INPUT_PREFIX,
          BRANCH_CHECKS,
          1,
          setupBranchInput,
        );
        watchSpareInputs(
          this,
          INPUT_PREFIX,
          BRANCH_CHECKS,
          1,
          setupBranchInput,
        );
        syncSlotVisibility(this);
        validateBranch(this);
        if (!this.workspace.isFlyout)
          this.workspace.addChangeListener(() => {
            if (this.isDisposed()) return;
            syncSlotVisibility(this);
            validateBranch(this);
            if (type === ROOT_TYPE) refreshLexiconChildren(this);
          });
      },
    },
  });
}

defineBranchBlock(
  ROOT_TYPE,
  "查询",
  "同一分支内的槽按「与」组合；每个槽的「非」只否定该槽；下面的「或」分支之间按「或」组合",
  false,
);
defineBranchBlock(
  BRANCH_TYPE,
  "或者",
  "这是一个「或」分支；分支内的槽按「与」组合，每个槽可单独取反",
  true,
);

// Legacy query states ========================================================
//
// Before the branch model, query states were a flat list of slots (or one
// tree). Flatten 与 into the branch's slots, expand 或 into branches, and turn
// 非 into a per-slot not flag.

function childStates(state: BlockState): BlockState[] {
  const inputs = (state.inputs ?? {}) as Record<
    string,
    { block?: BlockState } | undefined
  >;
  // 非 has a single input named ITEM; 与/或 use ITEM0, ITEM1, …
  const single = inputs["ITEM"]?.block;
  if (single) return [single];

  const children: BlockState[] = [];
  for (let index = 0; inputs[`${INPUT_PREFIX}${index}`]; index++) {
    const child = inputs[`${INPUT_PREFIX}${index}`]?.block;
    if (child) children.push(child);
  }
  return children;
}

function normalizeItem(state: BlockState): QueryBranchItemState[] {
  if (state.type === "lexicon_and")
    return childStates(state).flatMap(normalizeItem);
  if (state.type === "lexicon_not")
    return childStates(state).flatMap((child) =>
      normalizeItem(child).map((item) => ({ ...item, not: !item.not })),
    );
  return [{ state }];
}

function normalizeLegacy(items: readonly BlockState[]): QueryBranchState[] {
  const branches: QueryBranchState[] = [];
  for (const item of items) {
    if (item.type === "lexicon_or") {
      branches.push(...normalizeLegacy(childStates(item)));
      continue;
    }
    const normalized = normalizeItem(item);
    if (normalized.length) branches.push({ items: normalized });
  }
  return branches;
}

interface StoredBranch {
  group?: string;
  not?: boolean;
  items?: unknown[];
}

function isItemState(value: unknown): value is QueryBranchItemState {
  return (
    !!value &&
    typeof value === "object" &&
    "state" in (value as Record<string, unknown>)
  );
}

/** Renames block types from older saved query trees. */
function upgradeStateTypes(state: BlockState) {
  if (state.type === "lexicon_word_length") state.type = "lexicon_length";
  for (const connection of Object.values(state.inputs ?? {})) {
    const child = (connection as { block?: BlockState } | undefined)?.block;
    if (child) upgradeStateTypes(child);
  }
  if (state.next?.block) upgradeStateTypes(state.next.block);
}

function loadBranches(state: {
  branches?: StoredBranch[];
  queries?: BlockState[];
  query?: BlockState;
}): QueryBranchState[] {
  let branches: QueryBranchState[];
  if (Array.isArray(state?.branches)) {
    branches = state.branches.map((branch) => {
      const raw = Array.isArray(branch.items) ? branch.items : [];
      const branchGroup = String(branch.group ?? "") || undefined;
      if (raw.every(isItemState))
        return {
          items: raw.map((item) => ({
            not: !!item.not || undefined,
            group: String(item.group ?? "") || branchGroup,
            state: item.state,
          })),
        };

      // Previous shape: one branch-level not for a flat item list. It can only
      // be preserved when the branch had a single slot.
      const not = !!branch.not;
      return {
        items: raw.map((item, index) => ({
          not: not && raw.length === 1 && index === 0 ? true : undefined,
          group: branchGroup,
          state: item as BlockState,
        })),
      };
    });
  } else {
    // `queries` is the flat multi-slot format; `query` the single-tree format.
    const legacy = state?.queries ?? (state?.query ? [state.query] : []);
    branches = normalizeLegacy(legacy);
  }

  for (const branch of branches)
    for (const item of branch.items) upgradeStateTypes(item.state);
  return branches;
}

// Mutator ====================================================================

Blockly.Extensions.registerMutator(
  "lexicon_mutator",
  {
    decompose(this: LexiconBlock, workspace: Blockly.Workspace): Blockly.Block {
      const root = workspace.newBlock(ROOT_TYPE);
      if (root instanceof Blockly.BlockSvg) root.initSvg();
      const name = String(this.getFieldValue("NAME") ?? "");
      (root as RootBlock).lexiconName = name;

      const branches = this.queryBranches?.length
        ? this.queryBranches
        : [{ items: [] }];

      let block = root;
      branches.forEach((branch, branchIndex) => {
        if (branchIndex > 0) {
          const next = workspace.newBlock(BRANCH_TYPE);
          if (next instanceof Blockly.BlockSvg) next.initSvg();
          block.nextConnection?.connect(next.previousConnection!);
          block = next;
        }

        branch.items.forEach((item, index) => {
          let input = block.getInput(`${INPUT_PREFIX}${index}`);
          if (!input) {
            input = block
              .appendValueInput(`${INPUT_PREFIX}${index}`)
              .setCheck(BRANCH_CHECKS);
            setupBranchInput(input, index);
          }
          block.setFieldValue(item.not ? "TRUE" : "FALSE", `NOT${index}`);
          block.setFieldValue(item.group ?? "", `GROUP${index}`);
          try {
            const tree = Blockly.serialization.blocks.append(
              item.state,
              workspace,
            );
            if (input.connection && tree.outputConnection)
              input.connection.connect(tree.outputConnection);
          } catch {
            // Skip items that no longer deserialize (or do not fit the slot).
          }
        });
        syncSpareInputs(
          block,
          INPUT_PREFIX,
          BRANCH_CHECKS,
          1,
          setupBranchInput,
        );
        syncSlotVisibility(block);
        validateBranch(block);
      });

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
              for (const branch of branchChain(root)) validateBranch(branch);
              refreshLexiconChildren(root);
              updateFlyoutAvailability(root);
            }
          })
          .catch(() => {});
      return root;
    },

    compose(this: LexiconBlock, root: Blockly.Block) {
      const name = String(this.getFieldValue("NAME") ?? "");
      const branches: QueryBranchState[] = [];
      for (const block of branchChain(root)) {
        const items: QueryBranchItemState[] = [];
        for (const { block: item, not, group } of branchItems(block)) {
          const state = Blockly.serialization.blocks.save(item);
          if (state) items.push({ not: not || undefined, group, state });
        }
        if (items.length) branches.push({ items });
      }
      this.queryBranches = branches;

      let summary = "无";
      if (branches.length) {
        try {
          summary = summarizeDsl(queryDslFromBranches(branches, name));
        } catch {
          summary = "查询有误";
        }
      }
      setSummary(this, summary);
    },

    saveExtraState(this: LexiconBlock) {
      return this.queryBranches?.length
        ? { branches: this.queryBranches }
        : {};
    },

    loadExtraState(
      this: LexiconBlock,
      state: {
        branches?: StoredBranch[];
        queries?: BlockState[];
        query?: BlockState;
      },
    ) {
      this.queryBranches = loadBranches(state);
      setSummary(this, summarizeBranches(this));
    },
  },
  function (this: LexiconBlock) {
    this.queryBranches = [];
    setSummary(this, "无");
  },
  QUERY_BLOCK_TYPES,
);
