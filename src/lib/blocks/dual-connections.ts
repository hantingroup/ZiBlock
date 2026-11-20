/**
 * Expression blocks also get statement connections.
 *
 * Blockly's jsonInit rejects a definition that has both `output` and
 * `previousStatement`, but the underlying block supports both. Adding the
 * statement connections after init lets one block be used either as a value or
 * as a line in a vertical concatenation chain.
 */

import * as Blockly from "blockly";

const DUAL_CONNECTION = "dual_connection";

Blockly.Extensions.register(
  DUAL_CONNECTION,
  function (this: Blockly.Block) {
    this.setPreviousStatement(true, "TzText");
    this.setNextStatement(true, "TzText");
  },
);
