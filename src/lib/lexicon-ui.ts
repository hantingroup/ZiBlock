/**
 * Blockly-facing glue for the lexicon query blocks.
 *
 * The query is a C-shaped statement input on the lexicon block. Each condition
 * line is one DSL segment; consecutive lines are joined with & (AND). A bare
 * 或者 separator starts a new | (OR) branch. 取反 and 组 are C-shaped wrappers;
 * the generator expands 取反 with De Morgan when it contains several conditions
 * or OR branches.
 */

import * as Blockly from "blockly";
import { ALIAS_ENTRIES, type AliasEntry } from "./aliases";
import { addConditionPalette } from "./lexicon-palette";
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

/** Nearest enclosing lexicon block, if the block sits inside one. */
export function findEnclosingLexicon(
  block: Blockly.Block,
): Blockly.Block | undefined {
  for (
    let parent = block.getSurroundParent();
    parent;
    parent = parent.getSurroundParent()
  ) {
    if (parent.type === "lexicon" || parent.type === "lexicon_value")
      return parent;
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
    if (parent.type === "lexicon" || parent.type === "lexicon_value")
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

function validateGroupBlock(block: Blockly.Block) {
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

function validateNotBlock(block: Blockly.Block) {
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
  // Conditions only know their lexicon once they are connected, so keep their
  // warnings in sync with the tree.
  if (!this.workspace.isFlyout) {
    this.workspace.addChangeListener((event) => {
      if (event.isUiEvent || this.isDisposed()) return;
      refreshLexiconChildren(this);
    });
    // The gear opens a flyout of query blocks beside the block, so they can
    // be dragged straight into the query slot.
    if (this instanceof Blockly.BlockSvg) addConditionPalette(this);
  }
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
    validateGroupBlock(this);
  },
);

Blockly.Extensions.register(
  "lexicon_not_block",
  function (this: Blockly.Block) {
    validateNotBlock(this);
  },
);
