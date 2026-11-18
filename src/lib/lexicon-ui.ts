/**
 * Blockly-facing glue for the lexicon query blocks.
 *
 * A query is a chain of branches joined with |: the mutator root is the first
 * branch, and each branch block chained below it is another. Inside a branch,
 * each slot is one DSL segment, the slots are joined with &, and every slot
 * has its own 非 checkbox, so `a & !b` is representable. A lexicon_group item
 * keeps its @group on its own slot.
 *
 * Connection types (checked by Blockly itself):
 *   Cond:<kind>  one condition block (legacy 非 still outputs this)
 *   TzSegment    a condition bound to a schema group (lexicon_group output)
 *   TzClause     legacy 与 tree (hidden)
 *   TzQuery      legacy 或 tree (hidden)
 *
 * `lexicon_group` has a left value input for a condition and a right value
 * output. Its input check is narrowed to the condition kinds the selected
 * schema supports, so Blockly refuses unsupported pairs outright.
 */

import * as Blockly from "blockly";
import { ALIAS_ENTRIES, type AliasEntry } from "./aliases";
import {
  conditionsForGroup,
  getCachedLexiconMeta,
  getCachedLexiconNames,
  groupsForCondition,
  isKnownLexiconName,
  loadLexiconList,
  loadLexiconMeta,
  type Condition,
  type LexiconMeta,
} from "./lexicons";

const DEFAULT_LEXICON = "词";
const AUTO_GROUP: Blockly.MenuOption = ["自动", ""];
const ENUM_HISTORY_KEY = "ziblock:enum-history";
const ENUM_LIST_ID = "ziblock-enum-values";

export const CONDITION_TYPE: Record<Condition["kind"], string> = {
  pinyin: "Cond:pinyin",
  wordLength: "Cond:wordLength",
  path: "Cond:path",
  enumValue: "Cond:enumValue",
  index: "Cond:index",
  regex: "Cond:regex",
  raw: "Cond:raw",
};

const CONDITION_CHECKS = Object.values(CONDITION_TYPE);
const SEGMENT_CHECKS = [...CONDITION_CHECKS, "TzSegment"];
const CLAUSE_CHECKS = [...SEGMENT_CHECKS, "TzClause"];
const QUERY_CHECKS = [...CLAUSE_CHECKS, "TzQuery"];

export const CONDITION_KINDS: Record<string, Condition["kind"] | undefined> = {
  lexicon_pinyin: "pinyin",
  lexicon_length: "wordLength",
  lexicon_path: "path",
  lexicon_enum: "enumValue",
  lexicon_index: "index",
  lexicon_regex: "regex",
};

// Fields =====================================================================

/**
 * Dropdown that accepts values which are not in its option list. Fields are
 * restored from saved workspaces before their async options arrive, so
 * rejecting unknown values would silently drop the user's selection.
 */
export abstract class FlexibleDropdown extends Blockly.FieldDropdown {
  #onChange?: (value: string) => void;

  constructor(generator: Blockly.MenuGenerator, value: string) {
    super(Blockly.Field.SKIP_SETUP);
    this.setOptions(generator);
    this.setValue(value);
  }

  /**
   * FieldDropdown's own doClassValidation_ ignores validators, so value
   * changes are reported here instead.
   */
  setOnChange(handler: (value: string) => void) {
    this.#onChange = handler;
  }

  /** Never serve a cached option list; options may have loaded since. */
  override getOptions(useCache = true): Blockly.MenuOption[] {
    void useCache;
    return super.getOptions(false);
  }

  protected override doClassValidation_(newValue?: string): string | null {
    return newValue ?? null;
  }

  protected override doValueUpdate_(newValue: string): void {
    super.doValueUpdate_(newValue);
    this.#onChange?.(newValue);
  }

  protected override getText_(): string | null {
    const value = this.getValue();
    for (const option of super.getOptions(false)) {
      if (option !== "separator" && option[1] === value)
        return typeof option[0] === "string" ? option[0] : value;
    }
    return value || null;
  }

  /** Adds a filter box to long dropdown menus (e.g. 562 lexicon names). */
  protected override showEditor_(e?: MouseEvent): void {
    super.showEditor_(e);
    if (this.getOptions(false).length <= 8) return;

    const content = Blockly.DropDownDiv.getContentDiv();
    const items = Array.from(
      content.querySelectorAll<HTMLElement>(".blocklyMenuItem"),
    );
    if (items.length === 0) return;

    const search = document.createElement("input");
    search.type = "search";
    search.className = "ziblock-dropdown-search";
    search.placeholder = "搜索…";
    search.setAttribute("aria-label", "搜索选项");
    search.style.cssText =
      "box-sizing:border-box;width:calc(100% - 8px);margin:4px;" +
      "padding:4px 6px;font:inherit;border:1px solid #bbb;border-radius:2px;";

    const applyFilter = () => {
      const needle = search.value.trim().toLocaleLowerCase();
      let height = 0;
      for (const item of items) {
        const visible =
          !needle ||
          (item.textContent ?? "").toLocaleLowerCase().includes(needle);
        item.style.display = visible ? "" : "none";
        if (visible) height += item.offsetHeight;
      }
      content.style.height = `${height + search.offsetHeight + 8}px`;
    };

    search.addEventListener("input", applyFilter);
    search.addEventListener("keydown", (event) => {
      // Let Escape reach Blockly's menu handler so the dropdown can close.
      if (event.key !== "Escape") event.stopPropagation();
    });
    content.prepend(search);

    // Blockly sized the dropdown before the search box existed. Reserve the
    // box's height inside it, otherwise the list runs past the background.
    const menu = content.querySelector<HTMLElement>(".blocklyMenu");
    if (menu) {
      const reserved = search.offsetHeight + 8; // 4px margin above and below
      menu.style.maxHeight = `calc(100% - ${reserved}px)`;
    }
    search.focus();
  }
}

type DropdownJson = Parameters<typeof Blockly.FieldDropdown.fromJson>[0];

function lexiconNameOptions(): Blockly.MenuOption[] {
  const names = getCachedLexiconNames();
  if (!names) {
    void loadLexiconList().catch(() => {});
    return [[DEFAULT_LEXICON, DEFAULT_LEXICON]];
  }
  return names.map((name): Blockly.MenuOption => [name, name]);
}

export class FieldLexiconName extends FlexibleDropdown {
  constructor(value: string = DEFAULT_LEXICON) {
    super(lexiconNameOptions, value);
  }

  static override fromJson(options: DropdownJson): FieldLexiconName {
    return new FieldLexiconName(
      (options as { text?: string }).text ?? DEFAULT_LEXICON,
    );
  }
}

export class FieldGroupName extends FlexibleDropdown {
  constructor(value = "") {
    super(() => [AUTO_GROUP], value);
  }

  static override fromJson(options: DropdownJson): FieldGroupName {
    return new FieldGroupName((options as { text?: string }).text ?? "");
  }
}

// Output column: 默认 (the default) or one of the lexicon's columns.

const MAIN_FIELD: Blockly.MenuOption = ["默认", ""];

function columnOptions(block: Blockly.Block): Blockly.MenuOption[] {
  const name = String(block.getFieldValue("NAME") ?? "");
  if (!name) return [MAIN_FIELD];
  const meta = getCachedLexiconMeta(name);
  if (!meta) {
    void loadLexiconMeta(name).catch(() => {});
    return [MAIN_FIELD];
  }
  return [
    MAIN_FIELD,
    ...meta.columns.map(({ name }): Blockly.MenuOption => [name, name]),
  ];
}

export class FieldLexiconField extends FlexibleDropdown {
  constructor(value = "") {
    super(() => [MAIN_FIELD], value);
  }

  static override fromJson(options: DropdownJson): FieldLexiconField {
    return new FieldLexiconField((options as { text?: string }).text ?? "");
  }
}

// Enum value field with a local history of previously used values.

function enumHistory(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(ENUM_HISTORY_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

function enumValues(key: string): string[] {
  return enumHistory()[key] ?? [];
}

function rememberEnumValue(key: string, value: string) {
  if (!key || !value) return;
  try {
    const history = enumHistory();
    const values = history[key] ?? [];
    history[key] = [value, ...values.filter((item) => item !== value)].slice(0, 50);
    localStorage.setItem(ENUM_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Local storage can be unavailable; suggestions are a convenience.
  }
}

function enumKey(block: Blockly.Block | null | undefined): string {
  if (!block) return "";
  const lexicon = findEnclosingLexicon(block);
  const name = lexicon ? lexiconBlockName(lexicon) : "";
  const group = findEnclosingGroup(block);
  const groupName = group ? String(group.getFieldValue("GROUP") ?? "") : "";
  return `${name}::${groupName}`;
}

function populateEnumDatalist(block: Blockly.Block | null | undefined) {
  if (typeof document === "undefined") return;
  let list = document.getElementById(ENUM_LIST_ID) as HTMLDataListElement | null;
  if (!list) {
    list = document.createElement("datalist");
    list.id = ENUM_LIST_ID;
    document.body.appendChild(list);
  }
  list.replaceChildren(
    ...enumValues(enumKey(block)).map((value) => {
      const option = document.createElement("option");
      option.value = value;
      return option;
    }),
  );
}

const ENUM_CUSTOM = "\u0000custom";

function enumMenuItem(text: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.style.cssText =
    "display:block;width:100%;padding:6px 12px;border:0;background:transparent;" +
    "text-align:left;font:inherit;cursor:pointer;white-space:nowrap;";
  button.addEventListener("mouseenter", () => {
    button.style.background = "rgba(0,0,0,.08)";
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "transparent";
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

export class FieldEnumValue extends Blockly.FieldTextInput {
  // Not a private field: the base constructor calls doValueUpdate_ before
  // subclass field initializers run.
  onChangeHandler?: (value: string) => void;

  constructor(value = "") {
    super(value);
  }

  setOnChange(handler: (value: string) => void) {
    this.onChangeHandler = handler;
  }

  static override fromJson(options: Blockly.FieldConfig): FieldEnumValue {
    return new FieldEnumValue((options as { text?: string }).text ?? "");
  }

  protected override doValueUpdate_(newValue: string): void {
    super.doValueUpdate_(newValue);
    this.onChangeHandler?.(newValue);
  }

  /** Remember the committed value once the editor closes, not every keystroke. */
  protected override widgetDispose_(): void {
    super.widgetDispose_();
    const value = this.getValue();
    if (value) rememberEnumValue(enumKey(this.getSourceBlock()), value);
  }

  /** Opens the text editor with the remembered values as suggestions. */
  private openTextEditor(
    e?: Event,
    quietInput?: boolean,
    manageEphemeralFocus?: boolean,
  ) {
    super.showEditor_(e, quietInput, manageEphemeralFocus);
    if (!this.htmlInput_) return;
    populateEnumDatalist(this.getSourceBlock());
    this.htmlInput_.setAttribute("list", ENUM_LIST_ID);
    this.htmlInput_.placeholder = "枚举值（会记住用过的值）";
  }

  protected override showEditor_(
    e?: Event,
    quietInput?: boolean,
    manageEphemeralFocus?: boolean,
  ): void {
    if (typeof document === "undefined") return;
    const values = enumValues(enumKey(this.getSourceBlock()));
    // Nothing remembered yet: no dropdown to show.
    if (values.length === 0) {
      this.openTextEditor(e, quietInput, manageEphemeralFocus);
      return;
    }

    const content = Blockly.DropDownDiv.getContentDiv();
    content.replaceChildren();
    const list = document.createElement("div");
    list.style.cssText =
      "display:flex;flex-direction:column;min-width:140px;max-height:300px;" +
      "overflow-y:auto;";

    const choose = (value: string) => {
      if (value === ENUM_CUSTOM) {
        // Release the dropdown's focus immediately, then reuse the editor.
        Blockly.DropDownDiv.hideWithoutAnimation();
        this.openTextEditor();
      } else {
        Blockly.DropDownDiv.hide();
        rememberEnumValue(enumKey(this.getSourceBlock()), value);
        this.setValue(value);
      }
    };

    for (const value of values)
      list.append(enumMenuItem(value, () => choose(value)));
    list.append(enumMenuItem("自定义…", () => choose(ENUM_CUSTOM)));
    content.append(list);

    const block = this.getSourceBlock();
    if (block instanceof Blockly.BlockSvg)
      Blockly.DropDownDiv.setColour(block.getColour(), block.getColourTertiary());
    Blockly.DropDownDiv.showPositionedByField(this);
  }
}

// Alias names ================================================================
//
// Searchable picker over the bundled alias table (`src/lib/aliases.ts`, copied
// from the public `reserved/alias.tsv`). It is a text field first, so an alias
// missing from the table can still be typed; 自定义… switches to the editor.

function aliasMenuItem(entry: AliasEntry, onClick: () => void): HTMLButtonElement {
  const button = enumMenuItem("", onClick);
  button.replaceChildren();
  const key = document.createElement("span");
  key.textContent = entry.key;
  button.append(key);
  if (entry.value) {
    const value = document.createElement("span");
    const hint =
      entry.value.length > 60 ? `${entry.value.slice(0, 60)}…` : entry.value;
    value.textContent = ` → ${hint}`;
    value.style.cssText = "opacity:.55;margin-left:6px;";
    button.append(value);
  }
  button.title = `${entry.key} → ${entry.value}`;
  return button;
}

export class FieldAliasName extends Blockly.FieldTextInput {
  static override fromJson(options: Blockly.FieldConfig): FieldAliasName {
    return new FieldAliasName(
      (options as { text?: string }).text ?? ALIAS_ENTRIES[0]?.key ?? "",
    );
  }

  private openTextEditor(
    e?: Event,
    quietInput?: boolean,
    manageEphemeralFocus?: boolean,
  ) {
    super.showEditor_(e, quietInput, manageEphemeralFocus);
    if (this.htmlInput_) this.htmlInput_.placeholder = "别名（可直接输入）";
  }

  protected override showEditor_(
    e?: Event,
    quietInput?: boolean,
    manageEphemeralFocus?: boolean,
  ): void {
    if (typeof document === "undefined") return;
    const entries = ALIAS_ENTRIES;
    if (entries.length === 0) {
      this.openTextEditor(e, quietInput, manageEphemeralFocus);
      return;
    }

    const content = Blockly.DropDownDiv.getContentDiv();
    content.replaceChildren();
    const wrapper = document.createElement("div");
    wrapper.style.cssText =
      "display:flex;flex-direction:column;min-width:200px;max-height:340px;";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "ziblock-dropdown-search";
    search.placeholder = "搜索别名…";
    search.setAttribute("aria-label", "搜索别名");
    search.style.cssText =
      "box-sizing:border-box;width:calc(100% - 8px);margin:4px;" +
      "padding:4px 6px;font:inherit;border:1px solid #bbb;border-radius:2px;";
    const list = document.createElement("div");
    list.style.cssText = "min-height:0;overflow-y:auto;";
    wrapper.append(search, list);
    content.append(wrapper);

    const choose = (value: string) => {
      Blockly.DropDownDiv.hide();
      this.setValue(value);
    };

    const render = (needle: string) => {
      list.replaceChildren();
      const query = needle.trim().toLocaleLowerCase();
      const matches = entries.filter(
        (entry) =>
          !query ||
          entry.key.toLocaleLowerCase().includes(query) ||
          entry.value.toLocaleLowerCase().includes(query),
      );
      for (const entry of matches)
        list.append(aliasMenuItem(entry, () => choose(entry.key)));
      if (matches.length === 0) {
        const empty = document.createElement("div");
        empty.textContent = "没有匹配的别名";
        empty.style.cssText = "padding:6px 12px;opacity:.6;";
        list.append(empty);
      }
      list.append(
        enumMenuItem("自定义…", () => {
          Blockly.DropDownDiv.hideWithoutAnimation();
          this.openTextEditor();
        }),
      );
    };

    search.addEventListener("input", () => render(search.value));
    search.addEventListener("keydown", (event) => {
      // Let Escape reach Blockly's menu handler so the dropdown can close.
      if (event.key === "Escape") return;
      if (event.key === "Enter") {
        const first = list.querySelector<HTMLButtonElement>("button");
        if (first) {
          event.preventDefault();
          first.click();
        }
      }
      event.stopPropagation();
    });
    render("");

    const block = this.getSourceBlock();
    if (block instanceof Blockly.BlockSvg)
      Blockly.DropDownDiv.setColour(block.getColour(), block.getColourTertiary());
    Blockly.DropDownDiv.showPositionedByField(this);
    search.focus();
  }
}

// Helpers ====================================================================

/** Nearest enclosing `lexicon` block, if the block sits inside one. */
export function findEnclosingLexicon(
  block: Blockly.Block,
): Blockly.Block | undefined {
  for (
    let parent = block.getSurroundParent();
    parent;
    parent = parent.getSurroundParent()
  ) {
    // Blocks in the lexicon gear bubble hang off its root block, which carries
    // the lexicon name and stands in for the lexicon block there.
    if (parent.type === "lexicon" || parent.type === "lexicon_mutator_root")
      return parent;
    // A branch chained below the root is part of the same query; jump to the
    // top of the chain, which is the root.
    if (parent.type === "lexicon_branch") {
      const top = parent.getTopStackBlock();
      if (top.type === "lexicon_mutator_root") return top;
    }
  }
  return undefined;
}

/**
 * Name of a lexicon block, or of the gear bubble's root block (the root keeps
 * the name as plain data instead of showing it).
 */
export function lexiconBlockName(block: Blockly.Block): string {
  if (block.type === "lexicon_mutator_root")
    return (
      (block as Blockly.Block & { lexiconName?: string }).lexiconName ?? ""
    );
  return String(block.getFieldValue("NAME") ?? "");
}

function findEnclosingGroup(block: Blockly.Block): Blockly.Block | undefined {
  for (
    let parent = block.getSurroundParent();
    parent;
    parent = parent.getSurroundParent()
  ) {
    if (parent.type === "lexicon_group") return parent;
    if (parent.type === "lexicon" || parent.type === "lexicon_mutator_root")
      return undefined;
  }
  return undefined;
}

/** DSL condition kind produced by this condition block. */
export function conditionKind(
  block: Blockly.Block,
): Condition["kind"] | undefined {
  return CONDITION_KINDS[block.type];
}

/** Like conditionKind, but looks through a lexicon_not wrapper. */
export function effectiveConditionKind(
  block: Blockly.Block | null,
): Condition["kind"] | undefined {
  if (!block) return undefined;
  if (block.type === "lexicon_not")
    return effectiveConditionKind(block.getInputTargetBlock("ITEM"));
  return conditionKind(block);
}

function lexiconName(block: Blockly.Block): string {
  const lexicon = findEnclosingLexicon(block);
  return lexicon ? lexiconBlockName(lexicon) : "";
}

function metaForBlock(block: Blockly.Block): LexiconMeta | undefined {
  const name = lexiconName(block);
  if (!name) return undefined;
  const meta = getCachedLexiconMeta(name);
  if (!meta) void loadLexiconMeta(name).catch(() => {});
  return meta;
}

function schemaGroupOptions(block: Blockly.Block): Blockly.MenuOption[] {
  const meta = metaForBlock(block);
  if (!meta) return [AUTO_GROUP];
  return [
    AUTO_GROUP,
    ...meta.schemas.map(({ name }): Blockly.MenuOption => [name, name]),
  ];
}

export function conditionKindLabel(kind: Condition["kind"]): string {
  return {
    pinyin: "拼音",
    wordLength: "长度",
    path: "路径",
    enumValue: "枚举",
    index: "索引",
    regex: "正则",
    raw: "原始",
  }[kind];
}

/** Condition block types this lexicon cannot run. */
export function unsupportedConditionTypes(meta: LexiconMeta): Set<string> {
  const unsupported = new Set<string>();
  for (const [type, kind] of Object.entries(CONDITION_KINDS)) {
    // Index queries are global; they are not bound to a schema group.
    if (!kind || kind === "index") continue;
    if (groupsForCondition(meta, kind).length === 0) unsupported.add(type);
  }
  return unsupported;
}

// Validation =================================================================

function validateConditionBlock(block: Blockly.Block) {
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

function validateGroupBlock(block: Blockly.Block) {
  const group = String(block.getFieldValue("GROUP") ?? "");
  const name = lexiconName(block);
  const meta = name ? getCachedLexiconMeta(name) : undefined;

  const kinds = meta && group ? conditionsForGroup(meta, group) : [];
  const checks = kinds.length
    ? kinds.map((kind) => CONDITION_TYPE[kind])
    : CONDITION_CHECKS;

  block.getInput("ITEM")?.setCheck(checks);

  const target = block.getInputTargetBlock("ITEM");
  const targetKind = effectiveConditionKind(target);
  if (targetKind && meta && group && !kinds.includes(targetKind)) {
    block.setWarningText(
      `组“${group}”不支持${conditionKindLabel(targetKind)}查询；可用：${kinds
        .map(conditionKindLabel)
        .join("、") || "无"}`,
    );
  } else if (name && meta && group && !meta.schemas.some((s) => s.name === group)) {
    block.setWarningText(`词库“${name}”没有组“${group}”`);
  } else {
    block.setWarningText(null);
  }

  if (meta && group) {
    const schema = meta.schemas.find((s) => s.name === group);
    const labels = kinds.map(conditionKindLabel).join("、") || "无";
    block.setTooltip(schema ? `组「${group}」支持的查询：${labels}` : "");
  }
}

export function refreshLexiconChildren(lexicon: Blockly.Block) {
  for (const child of lexicon.getDescendants(false)) {
    if (conditionKind(child)) validateConditionBlock(child);
    if (child.type === "lexicon_group") validateGroupBlock(child);
  }
}

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

// Legacy n-ary AND / OR =====================================================
//
// These blocks are no longer offered in the gear flyout: a branch block now
// represents one segment (implicit AND) with a 非 checkbox, and branches are
// chained vertically as the OR alternatives. The types are kept so older saved
// query states still deserialize (lexicon-mutator flattens them).
//   Cond:<kind>  one condition
//   TzSegment:   condition bound to a group
//   TzClause:    legacy 与 tree
//   TzQuery:     legacy 或 tree

/** Number of consecutive inputs named `<prefix>0`, `<prefix>1`, … */
export function inputCount(block: Blockly.Block, prefix: string): number {
  let count = 0;
  while (block.getInput(`${prefix}${count}`)) count++;
  return count;
}

/**
 * Keeps at least `minimum` inputs and one empty input after the last connected
 * one. `decorate` runs for each newly added input (e.g. to add a per-slot
 * checkbox) and receives the slot index.
 */
export function syncSpareInputs(
  block: Blockly.Block,
  prefix: string,
  checks: string[] | null,
  minimum = 1,
  decorate?: (input: Blockly.Input, index: number) => void,
): boolean {
  let count = 0;
  let lastFilled = -1;
  while (block.getInput(`${prefix}${count}`)) {
    if (block.getInputTargetBlock(`${prefix}${count}`)) lastFilled = count;
    count++;
  }

  // One spare after the last filled input; `minimum` inputs when few are used.
  const needed = Math.max(minimum, lastFilled + 2);
  let changed = false;
  for (let index = count - 1; index >= needed; index--) {
    block.removeInput(`${prefix}${index}`);
    changed = true;
  }
  for (let index = count; index < needed; index++) {
    const input = block.appendValueInput(`${prefix}${index}`).setCheck(checks);
    decorate?.(input, index);
    changed = true;
  }
  if (changed && block instanceof Blockly.BlockSvg && block.rendered)
    block.render();
  return changed;
}

const LISTENER_FLAG = "autoInputsListener";

/** Re-check the spare input after anything in the block's workspace changes. */
export function watchSpareInputs(
  block: Blockly.Block,
  prefix: string,
  checks: string[] | null,
  minimum = 1,
  decorate?: (input: Blockly.Input, index: number) => void,
) {
  type Watched = Blockly.Block & { [LISTENER_FLAG]?: boolean };
  const watched = block as Watched;
  if (block.workspace.isFlyout || watched[LISTENER_FLAG]) return;
  watched[LISTENER_FLAG] = true;
  block.workspace.addChangeListener(() => {
    if (!block.isDisposed())
      syncSpareInputs(block, prefix, checks, minimum, decorate);
  });
}

function ensureInputs(
  block: Blockly.Block,
  prefix: string,
  checks: string[] | null,
  count: number,
) {
  for (let index = 0; index < count; index++) {
    if (!block.getInput(`${prefix}${index}`))
      block.appendValueInput(`${prefix}${index}`).setCheck(checks);
  }
}

function defineNaryLogic(
  type: string,
  word: string,
  output: "TzClause" | "TzQuery",
  checks: string[],
  tooltip: string,
) {
  Blockly.common.defineBlocks({
    [type]: {
      init(this: Blockly.Block) {
        // The first operand sits on the label row (like 非); later operands
        // get a row of their own because extra inputs are not inline.
        this.jsonInit({
          message0: `${word} %1`,
          args0: [{ type: "input_value", name: "ITEM0", check: checks }],
          output,
          style: "text_blocks",
          tooltip,
        });
        this.setInputsInline(false);
        syncSpareInputs(this, "ITEM", checks, 2);
        watchSpareInputs(this, "ITEM", checks, 2);

        this.saveExtraState = () => ({ itemCount: inputCount(this, "ITEM") });
        this.loadExtraState = (state: { itemCount?: number }) => {
          ensureInputs(
            this,
            "ITEM",
            checks,
            Math.max(2, Math.floor(Number(state?.itemCount)) || 2),
          );
        };
      },
    },
  });
}

defineNaryLogic(
  "lexicon_and",
  "与",
  "TzClause",
  CLAUSE_CHECKS,
  "用 & 连接条件；根节点的多个槽之间用 | 组合",
);

// Legacy type: the query root is now the only OR. Keep 或 defined so saved
// query trees that contain one still load, but do not offer it in the flyout.
defineNaryLogic(
  "lexicon_or",
  "或",
  "TzQuery",
  QUERY_CHECKS,
  "旧版「或」积木；查询根节点的多个槽已经按「或」组合",
);

// NOT: keeps the condition kind on its output so a group block can still
// reject unsupported combinations (e.g. negated 拼音 on a 路径-only group).
Blockly.Extensions.register("lexicon_not_block", function (this: Blockly.Block) {
  const syncOutput = () => {
    if (this.isDisposed()) return;
    const item = this.getInputTargetBlock("ITEM");
    const kind = effectiveConditionKind(item);
    const next = kind
      ? CONDITION_TYPE[kind]
      : item?.outputConnection?.getCheck()?.includes("TzSegment")
        ? "TzSegment"
        : "Cond:unknown";
    const current = this.outputConnection?.getCheck();
    if (!current || current.length !== 1 || current[0] !== next)
      this.setOutput(true, next);
  };
  syncOutput();
  if (!this.workspace.isFlyout) {
    this.workspace.addChangeListener(() => syncOutput());
  }
});

// Filter the mutator bubble's flyout before it is created, so unsupported
// conditions never flash into view and never leave gaps behind.
function patchMutatorFlyout(block: Blockly.Block) {
  const icon = block.getIcon(Blockly.icons.MutatorIcon.TYPE) as
    | {
        getMiniWorkspaceConfig?: () => any;
        ziblockFiltered?: boolean;
      }
    | undefined;
  if (!icon?.getMiniWorkspaceConfig || icon.ziblockFiltered) return;
  icon.ziblockFiltered = true;
  const original = icon.getMiniWorkspaceConfig.bind(icon);
  icon.getMiniWorkspaceConfig = () => {
    const config = original();
    const name = lexiconBlockName(block);
    const meta = name ? getCachedLexiconMeta(name) : undefined;
    const contents = config?.toolbox?.contents;
    if (!meta || !Array.isArray(contents)) return config;
    const unsupported = unsupportedConditionTypes(meta);
    const mode =
      (block as { queryMode?: string }).queryMode === "blocks"
        ? "blocks"
        : "fields";
    config.toolbox.contents = contents.filter((item: any) => {
      if (String(item?.kind ?? "").toLowerCase() !== "block") return true;
      if (unsupported.has(item.type)) return false;
      if (
        mode !== "blocks" &&
        (item.type === "lexicon_group" || item.type === "lexicon_not")
      )
        return false;
      return true;
    });
    return config;
  };
}

// Registration ===============================================================

Blockly.fieldRegistry.register("field_lexicon_name", FieldLexiconName);
Blockly.fieldRegistry.register("field_lexicon_field", FieldLexiconField);
Blockly.fieldRegistry.register("field_group_name", FieldGroupName);
Blockly.fieldRegistry.register("field_enum_value", FieldEnumValue);
Blockly.fieldRegistry.register("field_alias_name", FieldAliasName);

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
  patchMutatorFlyout(this);
  // The mutator icon is normally installed by jsonInit before extensions run;
  // retry on changes in case it was not there yet.
  this.workspace.addChangeListener(() => {
    if (!this.isDisposed()) patchMutatorFlyout(this);
  });
  updateLexiconBlock(this);
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
    const name = lexiconName(this);
    if (name) void loadLexiconMeta(name).catch(() => {});
    validateGroupBlock(this);
    // The enclosing lexicon is only known after the block is connected, so
    // re-narrow the input check whenever the workspace changes.
    if (!this.workspace.isFlyout)
      this.workspace.addChangeListener(() => {
        if (!this.isDisposed()) validateGroupBlock(this);
      });
  },
);
