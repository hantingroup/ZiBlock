/**
 * Warnings for the lexicon query blocks.
 *
 * A condition checks itself against the schema groups of the lexicon it sits
 * in; a 组/取反 wrapper checks what it wraps. The checks run on every change,
 * so moving a block into the right lexicon clears its warning.
 */

import * as Blockly from "blockly";
import {
  conditionsForGroup,
  groupsForCondition,
  type Condition,
} from "../dsl/lexicon-query";
import {
  getCachedLexiconMeta,
  isKnownLexiconName,
  loadLexiconMeta,
} from "../api/lexicons";
import {
  conditionKind,
  findEnclosingLexicon,
  lexiconBlockName,
  lexiconName,
} from "../dsl/lexicon-context";

function conditionKindLabel(kind: Condition["kind"]): string {
  return {
    pinyin: "拼音",
    pinyinRegex: "拼音正则",
    wordLength: "长度",
    path: "路径",
    enumValue: "枚举",
    index: "索引",
    regex: "正则",
    raw: "原始",
  }[kind];
}

/** Direct statements inside a 取反/组 wrapper, top to bottom. */
function innerBlocks(block: Blockly.Block): Blockly.Block[] {
  const blocks: Blockly.Block[] = [];
  for (
    let child = block.getInputTargetBlock("ITEM");
    child;
    child = child.getNextBlock()
  )
    blocks.push(child);
  return blocks;
}

/** Every condition kind inside a wrapper subtree. */
function leafConditionKinds(block: Blockly.Block): Condition["kind"][] {
  const kind = conditionKind(block);
  if (kind) return [kind];
  if (block.type === "lexicon_not" || block.type === "lexicon_group")
    return innerBlocks(block).flatMap(leafConditionKinds);
  return [];
}

function isQueryStatement(block: Blockly.Block): boolean {
  return (
    block.type === "lexicon_or" ||
    block.type === "lexicon_not" ||
    block.type === "lexicon_group" ||
    !!conditionKind(block)
  );
}

export function validateConditionBlock(block: Blockly.Block) {
  const kind = conditionKind(block);
  if (!kind) return;
  // Toolbox previews are always detached; don't flag them as misplaced.
  if (block.workspace.isFlyout) return;

  const lexicon = findEnclosingLexicon(block);
  if (!lexicon) {
    block.setWarningText("查询条件需要放在词库积木的查询里");
    return;
  }
  const name = lexiconBlockName(lexicon);
  if (!name) {
    block.setWarningText("请先选择词库");
    return;
  }
  if (isKnownLexiconName(name) === false) {
    block.setWarningText(`未找到词库：${name}`);
    return;
  }

  const meta = getCachedLexiconMeta(name);
  if (!meta) {
    void loadLexiconMeta(name).catch(() => {});
    block.setWarningText(null);
    return;
  }

  // Index queries are global; they are not bound to a schema group.
  if (kind === "index") {
    block.setWarningText(null);
    return;
  }

  const groups = groupsForCondition(meta, kind);
  block.setWarningText(
    groups.length === 0
      ? `词库“${name}”不支持${conditionKindLabel(kind)}查询`
      : null,
  );
}

export function validateGroupBlock(block: Blockly.Block) {
  const group = String(block.getFieldValue("GROUP") ?? "");
  const name = lexiconName(block);
  if (name && !getCachedLexiconMeta(name))
    void loadLexiconMeta(name).catch(() => {});
  const meta = name ? getCachedLexiconMeta(name) : undefined;

  if (!group) {
    block.setWarningText(null);
    block.setTooltip("给包住的条件加 @组");
    return;
  }
  if (!meta) {
    block.setWarningText(null);
    return;
  }

  if (!meta.schemas.some((schema) => schema.name === group)) {
    block.setWarningText(`词库“${name}”没有组“${group}”`);
    return;
  }

  const supported = conditionsForGroup(meta, group);
  const warnings: string[] = [];
  for (const child of innerBlocks(block)) {
    if (child.type === "lexicon_or") continue;
    if (child.type === "lexicon_group") {
      warnings.push("组里不要再套组");
      continue;
    }
    if (!isQueryStatement(child)) {
      warnings.push("组里只能放查询条件");
      continue;
    }
    for (const kind of leafConditionKinds(child))
      if (!supported.includes(kind))
        warnings.push(
          `组“${group}”不支持${conditionKindLabel(kind)}查询；可用：${supported
            .map(conditionKindLabel)
            .join("、") || "无"}`,
        );
  }
  block.setWarningText(
    warnings.length ? [...new Set(warnings)].join("\n") : null,
  );
  block.setTooltip(
    `组「${group}」支持的查询：${supported.map(conditionKindLabel).join("、") || "无"}`,
  );
}

export function validateNotBlock(block: Blockly.Block) {
  const warnings: string[] = [];
  for (const child of innerBlocks(block)) {
    if (child.type === "lexicon_or") continue;
    if (!isQueryStatement(child)) warnings.push("取反里只能放查询条件");
  }
  block.setWarningText(
    warnings.length ? [...new Set(warnings)].join("\n") : null,
  );
}

export function refreshLexiconChildren(lexicon: Blockly.Block) {
  for (const child of lexicon.getDescendants(false)) {
    if (conditionKind(child)) validateConditionBlock(child);
    else if (child.type === "lexicon_group") validateGroupBlock(child);
    else if (child.type === "lexicon_not") validateNotBlock(child);
  }
}
