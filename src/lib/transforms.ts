/**
 * Combined font/filter picker.
 *
 * Fonts and string filters share the same slot in the DSL (`[[text:op]]`), so
 * one block offers both. The charset part (`@…`) only applies to fonts; the
 * block hides that row for filter operations.
 */

import * as Blockly from "blockly";
import { FONT_NAMES } from "./fonts";
import { FlexibleDropdown } from "./lexicon-ui";

/** String filters accepted by Tianzi's `Filter` translator. */
export const FILTER_OPS: readonly (readonly [label: string, value: string])[] = [
  ["小写 lower", "lower"],
  ["大写 upper", "upper"],
  ["标题 title", "title"],
  ["首字母大写 capitalize", "capitalize"],
  ["casefold", "casefold"],
  ["交换大小写 swapcase", "swapcase"],
  ["去首尾空白 strip", "strip"],
  ["去尾部空白 rstrip", "rstrip"],
  ["去首部空白 lstrip", "lstrip"],
  ["展开制表符 expandtabs", "expandtabs"],
  ["麻将 mahjong", "mahjong"],
  ["摩斯 morse", "morse"],
  ["乱序 shuffle", "shuffle"],
];

const FILTER_VALUES = new Set(FILTER_OPS.map(([, value]) => value));

/** Whether `value` is a string filter rather than a font alias. */
export function isFilterOp(value: string): boolean {
  return FILTER_VALUES.has(value);
}

const DEFAULT_TRANSFORM = FILTER_OPS[0]?.[1] ?? "";

function transformOptions(): Blockly.MenuOption[] {
  return [
    ...FILTER_OPS.map(([label, value]): Blockly.MenuOption => [label, value]),
    "separator",
    ...FONT_NAMES.map((name): Blockly.MenuOption => [name, name]),
  ];
}

type DropdownJson = Parameters<typeof Blockly.FieldDropdown.fromJson>[0];

export class FieldTransformName extends FlexibleDropdown {
  constructor(value = DEFAULT_TRANSFORM) {
    super(transformOptions, value);
  }

  static override fromJson(options: DropdownJson): FieldTransformName {
    return new FieldTransformName(
      (options as { text?: string }).text ?? DEFAULT_TRANSFORM,
    );
  }
}

Blockly.fieldRegistry.register("field_transform_name", FieldTransformName);

/** The charset row is meaningful for fonts only. */
Blockly.Extensions.register(
  "transform_charset_visibility",
  function (this: Blockly.Block) {
    const update = () => {
      if (this.isDisposed()) return;
      const op = String(this.getFieldValue("OP") ?? "");
      const visible = !!op && !isFilterOp(op);
      const input = this.getInput("CHARSET");
      if (input && input.isVisible() !== visible) {
        input.setVisible(visible);
        if (this instanceof Blockly.BlockSvg && this.rendered) this.render();
      }
    };

    const opField = this.getField("OP");
    if (opField instanceof FieldTransformName) opField.setOnChange(update);
    update();
  },
);
