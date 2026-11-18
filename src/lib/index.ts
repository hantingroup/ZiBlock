import * as Blockly from "blockly";
import * as zhHans from "blockly/msg/zh-hans";
import { registerFieldMultilineInput } from "@blockly/field-multilineinput";
import "./dual-connections";
import "./lexicon-ui";
import "./nary-inputs";
import "./transforms";
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
