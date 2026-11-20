/**
 * Blockly registration and block-level behaviour for lexicon queries.
 *
 * The query is a C-shaped statement input on the lexicon block. Each condition
 * line is one DSL segment; consecutive lines are joined with & (AND). A bare
 * 或者 separator starts a new | (OR) branch. 取反 and 组 are C-shaped wrappers;
 * the generator expands 取反 with De Morgan when it contains several conditions
 * or OR branches.
 */

import * as Blockly from "blockly";
import { addConditionPalette, syncLexiconQueryRow } from "./lexicon-palette";
import {
  getCachedLexiconMeta,
  isKnownLexiconName,
  loadLexiconMeta,
  type LexiconMeta,
} from "../api/lexicons";
import { lexiconName } from "../dsl/lexicon-context";
import {
  FieldEnumValue,
  FieldGroupName,
  FieldLexiconField,
  FieldLexiconName,
  columnOptions,
  schemaGroupOptions,
} from "../fields/lexicon";
import {
  refreshLexiconChildren,
  validateConditionBlock,
  validateGroupBlock,
  validateNotBlock,
} from "./lexicon-validation";

function updateLexiconBlock(block: Blockly.Block) {
  const name = String(block.getFieldValue("NAME") ?? "");
  if (!name) {
    block.setWarningText("请选择词库");
    return;
  }
  if (isKnownLexiconName(name) === false) {
    block.setWarningText(`未找到词库：${name}`);
    return;
  }

  const cached = getCachedLexiconMeta(name);
  if (cached) {
    applyLexiconMeta(block, cached);
    return;
  }

  block.setWarningText(null);
  void loadLexiconMeta(name)
    .then((meta) => {
      if (!block.isDisposed() && block.getFieldValue("NAME") === name)
        applyLexiconMeta(block, meta);
    })
    .catch(() => {
      if (!block.isDisposed() && block.getFieldValue("NAME") === name)
        block.setTooltip("无法加载该词库的详细信息");
    });
}

function applyLexiconMeta(block: Blockly.Block, meta: LexiconMeta) {
  block.setWarningText(null);
  const groups = meta.schemas.map(({ name }) => name).join("、");
  block.setTooltip(
    `词库「${meta.name}」共 ${meta.headwordCount} 条\n查询组：${groups || "无"}`,
  );

  // A column carried over from another lexicon may not exist here.
  const output = block.getField("FIELD");
  const value = String(output?.getValue() ?? "");
  if (value && !meta.columns.some(({ name }) => name === value))
    output?.setValue("");

  refreshLexiconChildren(block);
}

// Registration ===============================================================

Blockly.Extensions.register("lexicon_block", function (this: Blockly.Block) {
  const nameField = this.getField("NAME");
  if (nameField instanceof FieldLexiconName) {
    nameField.setOnChange(() => {
      updateLexiconBlock(this);
      refreshLexiconChildren(this);
    });
  }
  const outputField = this.getField("FIELD");
  if (outputField instanceof FieldLexiconField)
    outputField.setOptions(() => columnOptions(this));
  // Conditions only know their lexicon once they are connected, so keep their
  // warnings in sync with the tree.
  if (!this.workspace.isFlyout) {
    this.workspace.addChangeListener((event) => {
      if (event.isUiEvent || this.isDisposed()) return;
      refreshLexiconChildren(this);
      // Blockly re-shows every input when a collapsed block is expanded, and
      // does that after firing the change; check once it has finished.
      queueMicrotask(() => syncLexiconQueryRow(this));
    });
    // The gear opens a flyout of query blocks beside the block, so they can
    // be dragged straight into the query slot.
    if (this instanceof Blockly.BlockSvg) addConditionPalette(this);
  }
  updateLexiconBlock(this);
  // Without conditions the query row is removed until the gear is opened. A
  // saved workspace connects its conditions while events are disabled, after
  // the block is built, so only reshape it right away when that cannot happen.
  if (Blockly.Events.isEnabled()) syncLexiconQueryRow(this);
  queueMicrotask(() => syncLexiconQueryRow(this));
});

Blockly.Extensions.register(
  "lexicon_condition",
  function (this: Blockly.Block) {
    const name = lexiconName(this);
    if (name) void loadLexiconMeta(name).catch(() => {});
    validateConditionBlock(this);
  },
);

Blockly.Extensions.register(
  "lexicon_enum_block",
  function (this: Blockly.Block) {
    const valueField = this.getField("VALUE");
    if (valueField instanceof FieldEnumValue)
      valueField.setOnChange(() => validateConditionBlock(this));
  },
);

Blockly.Extensions.register(
  "lexicon_group_block",
  function (this: Blockly.Block) {
    const groupField = this.getField("GROUP");
    if (groupField instanceof FieldGroupName) {
      groupField.setOptions(() => schemaGroupOptions(this));
      groupField.setOnChange(() => validateGroupBlock(this));
    }
    validateGroupBlock(this);
  },
);

Blockly.Extensions.register(
  "lexicon_not_block",
  function (this: Blockly.Block) {
    validateNotBlock(this);
  },
);
