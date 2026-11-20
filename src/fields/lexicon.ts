/**
 * Fields used by the lexicon blocks.
 *
 * The lexicon, group and output-column pickers read their options from the
 * cached lexicon metadata (fetching it on first use), the enum field keeps a
 * local history of values, and the macro field offers the fetched macro table.
 * Long option lists are filtered by `FlexibleDropdown`.
 */

import * as Blockly from "blockly";
import {
  getMacroEntries,
  loadMacroEntries,
  macroTableStatus,
} from "../api/macros";
import {
  getCachedLexiconMeta,
  getCachedLexiconNames,
  loadLexiconList,
  loadLexiconMeta,
  type LexiconMeta,
} from "../api/lexicons";
import {
  findEnclosingGroup,
  findEnclosingLexicon,
  lexiconBlockName,
  lexiconName,
} from "../dsl/lexicon-context";
import { FlexibleDropdown, type DropdownJson } from "./flexible-dropdown";

const DEFAULT_LEXICON = "词";
const ENUM_HISTORY_KEY = "ziblock:enum-history";
const ENUM_LIST_ID = "ziblock-enum-values";

// Lexicon name ===============================================================

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

// Schema group ===============================================================

const AUTO_GROUP: Blockly.MenuOption = ["自动", ""];

function metaForBlock(block: Blockly.Block): LexiconMeta | undefined {
  const name = lexiconName(block);
  if (!name) return undefined;
  const meta = getCachedLexiconMeta(name);
  if (!meta) void loadLexiconMeta(name).catch(() => {});
  return meta;
}

export function schemaGroupOptions(block: Blockly.Block): Blockly.MenuOption[] {
  const meta = metaForBlock(block);
  if (!meta) return [AUTO_GROUP];
  return [
    AUTO_GROUP,
    ...meta.schemas.map(({ name }): Blockly.MenuOption => [name, name]),
  ];
}

export class FieldGroupName extends FlexibleDropdown {
  constructor(value = "") {
    super(() => [AUTO_GROUP], value);
  }

  static override fromJson(options: DropdownJson): FieldGroupName {
    return new FieldGroupName((options as { text?: string }).text ?? "");
  }
}

// Output column ==============================================================
//
// 默认 (the default) or one of the lexicon's columns.

const MAIN_FIELD: Blockly.MenuOption = ["默认", ""];

export function columnOptions(block: Blockly.Block): Blockly.MenuOption[] {
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

// Enum value =================================================================
//
// A text field with a local history of previously used values.

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

// Macro name =================================================================
//
// Searchable dropdown over the macro table (`src/api/macros.ts`, fetched from
// the public `reserved/alias.tsv`). Only table entries are valid: unlike the
// lexicon picker there is no free-text editor.

const DEFAULT_MACRO = "一";

function macroOptions(): Blockly.MenuOption[] {
  return getMacroEntries().map(({ key }): Blockly.MenuOption => [key, key]);
}

export class FieldMacroName extends FlexibleDropdown {
  constructor(value = DEFAULT_MACRO) {
    super(macroOptions, value);
  }

  static override fromJson(options: Blockly.FieldConfig): FieldMacroName {
    void loadMacroEntries();
    return new FieldMacroName(
      (options as { text?: string }).text ?? DEFAULT_MACRO,
    );
  }

  /**
   * Only the fetched table's keys are accepted. While the table is still on
   * its way the saved value is let through, so restoring a workspace does not
   * lose the user's choice.
   */
  protected override doClassValidation_(newValue?: string): string | null {
    const value = newValue ?? "";
    if (macroTableStatus() !== "ready") return value;
    return this.getOptions(false).some(
      (option) => option !== "separator" && option[1] === value,
    )
      ? value
      : null;
  }

  protected override showEditor_(e?: MouseEvent): void {
    // Keep retrying a failed request; the menu opens with what is loaded now.
    void loadMacroEntries();
    super.showEditor_(e);
  }
}

// Registration ===============================================================

Blockly.fieldRegistry.register("field_lexicon_name", FieldLexiconName);
Blockly.fieldRegistry.register("field_lexicon_field", FieldLexiconField);
Blockly.fieldRegistry.register("field_group_name", FieldGroupName);
Blockly.fieldRegistry.register("field_enum_value", FieldEnumValue);
Blockly.fieldRegistry.register("field_macro_name", FieldMacroName);
