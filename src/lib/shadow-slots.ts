/**
 * Scratch-style value slots.
 *
 * Blockly fields cannot hold blocks, so every text/number field becomes a
 * value input with a literal *shadow* block: the shadow shows an editable
 * field in place, and any reporter with an output connection can cover it.
 *
 * `blocks.yml` keeps using `field_input` / `field_number` /
 * `field_multilinetext`; `prepareShadowSlots` rewrites those arguments into
 * value inputs and remembers the shadow each one starts with.
 */

import * as Blockly from "blockly";

export type LiteralType =
  | "literal_text"
  | "literal_multiline"
  | "literal_number";

/** One field turned into a value slot. */
export interface ShadowSlot {
  /** Input name (the field name it replaces). */
  input: string;
  /** Shadow block type that supplies the editable literal. */
  shadowType: LiteralType;
  /** Initial literal text. */
  text: string;
}

/** Field types that become slots, mapped to their shadow block type. */
const SHADOW_KINDS: Record<string, { shadowType: LiteralType }> = {
  field_input: { shadowType: "literal_text" },
  field_multilinetext: { shadowType: "literal_multiline" },
  field_number: { shadowType: "literal_number" },
};

const SHADOW_EXTENSION = "ziblock_shadow_slots";

/** Shadow slots per block type, used by the extension and the migrator. */
export const SHADOW_SLOTS = new Map<string, ShadowSlot[]>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      definition[`args${index}`] = args.map((arg: any) => {
        const kind =
          arg && typeof arg === "object" ? SHADOW_KINDS[arg.type] : undefined;
        if (!kind || !arg.name) return arg;

        slots.push({
          input: arg.name,
          shadowType: kind.shadowType,
          text: String(arg.text ?? arg.value ?? ""),
        });
        return { type: "input_value", name: arg.name };
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
  ]);
}

/** Gives every converted input its initial literal shadow. */
export function registerShadowSlotExtension() {
  Blockly.Extensions.register(SHADOW_EXTENSION, function (this: Blockly.Block) {
    const slots = SHADOW_SLOTS.get(this.type);
    if (!slots) return;
    for (const slot of slots) {
      this.getInput(slot.input)?.connection?.setShadowState({
        type: slot.shadowType,
        fields: { TEXT: slot.text },
      });
    }
  });
}

// Legacy workspaces ==========================================================
//
// Workspaces saved before this change store the literal under `fields`. The
// dev sessionStorage restore moves it into the input's shadow so a reloaded
// canvas keeps its text.

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
    extraState?: {
      branches?: { items?: unknown[] }[];
      queries?: unknown[];
      query?: unknown;
    };
  };

  const slots = state.type ? SHADOW_SLOTS.get(state.type) : undefined;
  if (slots && state.fields) {
    for (const slot of slots) {
      if (!(slot.input in state.fields)) continue;
      const value = state.fields[slot.input];
      delete state.fields[slot.input];
      if (state.inputs?.[slot.input]) continue;
      state.inputs ??= {};
      state.inputs[slot.input] = {
        shadow: {
          type: slot.shadowType,
          fields: { TEXT: String(value ?? "") },
        },
      };
    }
  }

  for (const connection of Object.values(state.inputs ?? {})) {
    migrateBlock(connection?.block);
    migrateBlock(connection?.shadow);
  }
  migrateBlock(state.next?.block);

  // Lexicon blocks keep their query condition blocks in extra state. Branch
  // items are {state, not} in the current format and bare states in older ones.
  for (const branch of state.extraState?.branches ?? [])
    for (const item of branch.items ?? []) {
      const stored = item as { state?: unknown } | null;
      migrateBlock(
        stored && typeof stored === "object" && "state" in stored
          ? stored.state
          : item,
      );
    }
  for (const query of state.extraState?.queries ?? []) migrateBlock(query);
  migrateBlock(state.extraState?.query);
}
