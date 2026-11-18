import * as Blockly from "blockly";
import * as zhHans from "blockly/msg/zh-hans";
import { registerFieldMultilineInput } from "@blockly/field-multilineinput";
import "./dual-connections";
import "./lexicons/fields";
import "./lexicons/blocks";
import "./nary-inputs";
import "./transforms";
import { loadMacroEntries } from "./macros";
import blockArray from "./blocks.yml";
import {
  defineLiteralBlocks,
  prepareShadowSlots,
  registerShadowSlotExtension,
} from "./shadow-slots";

Blockly.setLocale(zhHans as any);
registerFieldMultilineInput();
defineLiteralBlocks();
registerShadowSlotExtension();
Blockly.defineBlocksWithJsonArray(prepareShadowSlots(blockArray));

// Warm the macro table so the picker usually has its options on first click.
void loadMacroEntries();
