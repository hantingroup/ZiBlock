/**
 * Dropdown base for long option lists.
 *
 * The field accepts values outside its option list: saved workspaces restore
 * fields before their async options arrive, so rejecting unknown values would
 * silently drop the user's selection. Long menus get a filter box.
 */

import * as Blockly from "blockly";

export type DropdownJson = Parameters<typeof Blockly.FieldDropdown.fromJson>[0];

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
