/**
 * Toolbox/block colour scheme.
 *
 * Text, math, loops, variables and settings use Blockly's classic hues.
 * Lexicon blocks get a hue slightly offset from text (the 词库 toolbox uses
 * the same 140), and settings get their own colour instead of borrowing text.
 */

import * as Blockly from "blockly";

export const AppTheme = Blockly.Theme.defineTheme("ZiBlock", {
  name: "ZiBlock",
  base: Blockly.Themes.Classic,
  blockStyles: {
    lexicon_blocks: { colourPrimary: "190" },
    setting_blocks: { colourPrimary: "20" },
  },
});
