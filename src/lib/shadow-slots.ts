/**
 * Scratch-style value slots.
 *
 * Blockly fields cannot hold blocks, so every text/number field becomes a
 * value input with a literal *shadow* block: the shadow shows an editable
 * field in place, and any reporter with an output connection can cover it.
 *
 * `blocks.yml` keeps using `field_input` / `field_number` /
 * `field_multilinetext`, plus `field_dropdown` / `field_variable` where the
 * definition marks it with `shadow: true`; `prepareShadowSlots` rewrites those
 * arguments into value inputs and remembers the shadow each one starts with.
 */

import * as Blockly from "blockly";

export type LiteralType =
  | "literal_text"
  | "literal_multiline"
  | "literal_number"
  | "literal_dropdown"
  | "variable_name";

/** One field turned into a value slot. */
export interface ShadowSlot {
  /** Input name (the field name it replaces). */
  input: string;
  /** Shadow block type that supplies the editable literal. */
  shadowType: LiteralType;
  /** Initial literal value; number slots keep a number, not a string. */
  value: string | number;
  /** Choices of a dropdown slot, carried by the shadow's extra state. */
  options?: Blockly.MenuOption[];
}

/** Field types that become slots, mapped to their shadow block type. */
const SHADOW_KINDS: Record<string, { shadowType: LiteralType; optIn?: boolean }> =
  {
    field_input: { shadowType: "literal_text" },
    field_multilinetext: { shadowType: "literal_multiline" },
    field_number: { shadowType: "literal_number" },
    // Dropdowns become slots only where the definition asks (`shadow: true`):
    // most remaining ones are fixed choices, such as the query comparisons.
    field_dropdown: { shadowType: "literal_dropdown", optIn: true },
    // A variable dropdown can be replaced by any expression, but the variable
    // model only makes sense as the default (写名) input of the set block.
    field_variable: { shadowType: "variable_name", optIn: true },
  };

const SHADOW_EXTENSION = "ziblock_shadow_slots";

/** Shadow slots per block type, used by the extension and the migrator. */
export const SHADOW_SLOTS = new Map<string, ShadowSlot[]>();

/** Shadow fields keep their type: number slots hold numbers, the rest text. */
function literalValue(
  shadowType: LiteralType,
  value: unknown,
): string | number {
  if (shadowType !== "literal_number") return String(value ?? "");
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** A dropdown starts on its declared value, else on its first option. */
function dropdownValue(options: unknown): string {
  const first = Array.isArray(options) ? options[0] : undefined;
  if (Array.isArray(first)) return String(first[1] ?? "");
  return "";
}

/** Resolves a variable field's default name, e.g. `%{BKY_VARIABLES_DEFAULT_NAME}`. */
function variableName(value: unknown): string {
  const name = Blockly.utils.parsing.replaceMessageReferences(
    String(value ?? ""),
  );
  return name || String(Blockly.Msg["VARIABLES_DEFAULT_NAME"] ?? "");
}

/** Saved shadow state for a slot, including the choices it must offer. */
export function shadowState(slot: ShadowSlot): Blockly.serialization.blocks.State {
  const fields =
    slot.shadowType === "variable_name"
      ? { VAR: { name: String(slot.value) } }
      : { TEXT: literalValue(slot.shadowType, slot.value) };
  const state: Blockly.serialization.blocks.State = {
    type: slot.shadowType,
    fields,
  };
  if (slot.options) state.extraState = { options: slot.options };
  return state;
}

type Definition = Record<string, any>;

/**
 * Rewrites text/number fields in block definitions into value inputs and
 * records the literal shadow each input should start with. Returns new
 * definition objects; the YAML anchors they came from are left untouched.
 */
export function prepareShadowSlots(
  definitions: readonly Definition[],
): Definition[] {
  return definitions.map((source) => {
    const definition: Definition = { ...source };
    const slots: ShadowSlot[] = [];

    for (let index = 0; definition[`args${index}`]; index++) {
      const args = definition[`args${index}`];
      if (!Array.isArray(args)) continue;

      definition[`args${index}`] = args.map((arg: any) => {
        const kind =
          arg && typeof arg === "object" ? SHADOW_KINDS[arg.type] : undefined;
        if (!kind || !arg.name) return arg;
        if (kind.optIn && arg.shadow !== true) return arg;

        // Literal text blocks are already replaceable expressions. Their text
        // stays a plain field instead of a nested value slot.
        if (arg.shadow === false) {
          const plain = { ...arg };
          delete plain.shadow;
          return plain;
        }

        const raw =
          arg.text ??
          arg.value ??
          arg.variable ??
          (kind.shadowType === "literal_dropdown"
            ? dropdownValue(arg.options)
            : undefined);
        slots.push({
          input: arg.name,
          shadowType: kind.shadowType,
          value:
            kind.shadowType === "variable_name"
              ? variableName(raw)
              : literalValue(kind.shadowType, raw),
          ...(kind.shadowType === "literal_dropdown" && Array.isArray(arg.options)
            ? { options: arg.options }
            : {}),
        });
        // The literal now lives in the shadow block; only the connection check
        // still belongs on the input.
        const input: Record<string, unknown> = {
          type: "input_value",
          name: arg.name,
        };
        if (arg.check) input.check = arg.check;
        return input;
      });
    }

    if (slots.length === 0) return definition;

    SHADOW_SLOTS.set(definition.type, slots);
    const extensions: string[] = Array.isArray(definition.extensions)
      ? [...definition.extensions]
      : [];
    if (!extensions.includes(SHADOW_EXTENSION))
      extensions.push(SHADOW_EXTENSION);
    definition.extensions = extensions;
    return definition;
  });
}

/** The literal blocks the slots are filled with (never shown in the toolbox). */
export function defineLiteralBlocks() {
  Blockly.defineBlocksWithJsonArray([
    {
      type: "literal_text",
      message0: "%1",
      args0: [{ type: "field_input", name: "TEXT" }],
      output: "String",
      style: "text_blocks",
      tooltip: "文本字面量；可以用值积木替换",
    },
    {
      type: "literal_multiline",
      message0: "%1",
      args0: [{ type: "field_multilinetext", name: "TEXT" }],
      output: "String",
      style: "text_blocks",
      tooltip: "文本字面量；可以用值积木替换",
    },
    {
      type: "literal_number",
      message0: "%1",
      args0: [{ type: "field_number", name: "TEXT" }],
      output: "Number",
      style: "math_blocks",
      tooltip: "数字字面量；可以用值积木替换",
    },
    {
      type: "variable_name",
      message0: "%1",
      args0: [
        {
          type: "field_variable",
          name: "VAR",
          variable: "%{BKY_VARIABLES_DEFAULT_NAME}",
        },
      ],
      output: "String",
      style: "variable_blocks",
      tooltip: "变量名；可以用值积木替换",
    },
  ]);
  // Dropdowns carry their choices in extra state, so one block type serves
  // every dropdown slot. The values are DSL tokens, not user text.
  Blockly.common.defineBlocks({
    literal_dropdown: {
      init(this: Blockly.Block) {
        this.jsonInit({
          message0: "%1",
          args0: [
            { type: "field_dropdown", name: "TEXT", options: [["", ""]] },
          ],
          output: "String",
          style: "math_blocks",
          tooltip: "下拉字面量；可以用值积木替换",
        });
      },
      saveExtraState(this: Blockly.Block) {
        const field = this.getField("TEXT") as Blockly.FieldDropdown | null;
        return { options: field?.getOptions(false) ?? [] };
      },
      loadExtraState(this: Blockly.Block, state: { options?: unknown }) {
        const field = this.getField("TEXT") as Blockly.FieldDropdown | null;
        if (field && Array.isArray(state?.options) && state.options.length)
          field.setOptions(state.options as Blockly.MenuOption[]);
      },
    },
  });
}

/** Gives every converted input its initial literal shadow. */
export function registerShadowSlotExtension() {
  Blockly.Extensions.register(SHADOW_EXTENSION, function (this: Blockly.Block) {
    const slots = SHADOW_SLOTS.get(this.type);
    if (!slots) return;
    for (const slot of slots) {
      this.getInput(slot.input)?.connection?.setShadowState(shadowState(slot));
    }
  });
}

// Legacy workspaces ==========================================================
//
// Workspaces saved before the value-slot change store the literal under
// `fields`. The dev sessionStorage restore moves it into the input's shadow so
// a reloaded canvas keeps its text.

export function migrateWorkspaceState(state: unknown): void {
  if (!state || typeof state !== "object") return;
  const blocks = (state as { blocks?: unknown }).blocks;
  const top =
    blocks && typeof blocks === "object" && "blocks" in blocks
      ? (blocks as { blocks?: unknown }).blocks
      : blocks;
  if (!Array.isArray(top)) return;
  for (const block of top) migrateBlock(block);
}

function migrateBlock(block: unknown): void {
  if (!block || typeof block !== "object") return;
  const state = block as {
    type?: string;
    fields?: Record<string, unknown>;
    inputs?: Record<string, { block?: unknown; shadow?: unknown } | undefined>;
    next?: { block?: unknown };
  };

  // The 别名 block is now 宏 (macro); saved workspaces still use the old names.
  if (state.type === "alias") state.type = "macro";
  if (state.fields?.ALIAS !== undefined) {
    state.fields.MACRO ??= state.fields.ALIAS;
    delete state.fields.ALIAS;
  }

  // The 设置 blocks used to keep the variable name in a dropdown field; that
  // name is now a value slot. Rename the old block type so saved canvases
  // still load, and let the slot migration below turn the name into a shadow.
  if (state.type === "variables_set_block") state.type = "variables_set";

  // The 遍历 trim used to be a shadow slot; it is a plain dropdown now.
  if (state.type === "map" && state.inputs?.TRIM) {
    const trim = state.inputs.TRIM as {
      shadow?: { fields?: { TEXT?: unknown } };
    };
    const value = trim.shadow?.fields?.TEXT;
    if (state.fields?.TRIM === undefined && typeof value === "string")
      state.fields = { ...state.fields, TRIM: value };
    delete state.inputs.TRIM;
  }

  const slots = state.type ? SHADOW_SLOTS.get(state.type) : undefined;
  if (slots && state.fields) {
    for (const slot of slots) {
      if (!(slot.input in state.fields)) continue;
      let value = state.fields[slot.input];
      // A variable field saved `{name}`; the slot only needs the name.
      if (value !== null && typeof value === "object")
        value = String((value as { name?: unknown }).name ?? "");
      delete state.fields[slot.input];
      if (state.inputs?.[slot.input]) continue;
      state.inputs ??= {};
      const initial = literalValue(slot.shadowType, value);
      state.inputs[slot.input] = {
        shadow: shadowState({ ...slot, value: initial }),
      };
    }
  }

  for (const connection of Object.values(state.inputs ?? {})) {
    migrateBlock(connection?.block);
    migrateBlock(connection?.shadow);
  }
  migrateBlock(state.next?.block);
}
