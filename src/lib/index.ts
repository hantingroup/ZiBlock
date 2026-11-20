import * as Blockly from "blockly";
import * as zhHans from "blockly/msg/zh-hans";
import { registerFieldMultilineInput } from "@blockly/field-multilineinput";
import "./blocks/dual-connections";
import "./fields/lexicon";
import "./blocks/lexicon";
import "./blocks/nary-inputs";
import "./fields/transform";
import { loadMacroEntries } from "./api/macros";
import blockArray from "./blocks/definitions.yml";
import {
  defineLiteralBlocks,
  prepareShadowSlots,
  registerShadowSlotExtension,
} from "./blocks/shadow-slots";

Blockly.setLocale(zhHans as any);
registerFieldMultilineInput();
defineLiteralBlocks();
registerShadowSlotExtension();
Blockly.defineBlocksWithJsonArray(prepareShadowSlots(blockArray));

// Warm the macro table so the picker usually has its options on first click.
void loadMacroEntries();
