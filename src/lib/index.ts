import * as Blockly from "blockly";
import * as zhHans from "blockly/msg/zh-hans";
import { registerFieldMultilineInput } from "@blockly/field-multilineinput";
import "./lexicon-ui";
import "./lexicon-mutator";
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
