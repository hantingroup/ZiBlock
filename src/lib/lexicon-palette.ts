/**
 * Gear palette for lexicon query conditions.
 *
 * The gear opens its own flyout beside the block instead of reusing the main
 * toolbox flyout. Its blocks live in a flyout workspace and are dragged out
 * into the main workspace, so a condition can be dropped straight into the
 * lexicon query slot.
 *
 * The offered conditions are filtered by the selected lexicon's schema: a
 * condition is only listed when the lexicon has at least one group that can
 * run it. `索引` is global and always available; wrappers are always shown.
 */

import * as Blockly from "blockly";
import {
  getCachedLexiconMeta,
  groupsForCondition,
  loadLexiconMeta,
  type Condition,
  type LexiconMeta,
} from "./lexicons";

const QUERY_BLOCK_TYPES = [
  "lexicon_length",
  "lexicon_pinyin",
  "lexicon_regex",
  "lexicon_index",
  "lexicon_enum",
  "lexicon_path",
  "lexicon_not",
  "lexicon_group",
  "lexicon_or",
] as const;

/** Condition kinds, mirroring the block types in CONDITION_KINDS. */
const CONDITION_KINDS: Record<string, Condition["kind"] | undefined> = {
  lexicon_length: "wordLength",
  lexicon_pinyin: "pinyin",
  lexicon_regex: "regex",
  lexicon_index: "index",
  lexicon_enum: "enumValue",
  lexicon_path: "path",
};

const MARGIN = 12;
/** Width of the coloured frame around the white flyout panel. */
const FRAME = 6;
/** Vertical distance from the block's top to its gear icon. */
const GEAR_OFFSET = 16;

const SVG_NS = "http://www.w3.org/2000/svg";

function roundedRect(
  left: number,
  top: number,
  right: number,
  bottom: number,
  radius: number,
): string {
  const r = Math.max(
    0,
    Math.min(radius, (right - left) / 2, (bottom - top) / 2),
  );
  return [
    `M ${left + r},${top}`,
    `H ${right - r}`,
    `A ${r},${r} 0 0 1 ${right},${top + r}`,
    `V ${bottom - r}`,
    `A ${r},${r} 0 0 1 ${right - r},${bottom}`,
    `H ${left + r}`,
    `A ${r},${r} 0 0 1 ${left},${bottom - r}`,
    `V ${top + r}`,
    `A ${r},${r} 0 0 1 ${left + r},${top}`,
    "Z",
  ].join(" ");
}

/**
 * A flyout shaped like a mutator bubble: a coloured rounded frame with a tail
 * pointing at the gear, and a white flyout panel inside. It hugs its contents
 * and anchors beside the block instead of filling the workspace edge.
 */
class PaletteFlyout extends Blockly.VerticalFlyout {
  anchorX = 0;
  anchorY = 0;
  anchorWidth = 0;

  private bubbleColour = "#ffffff";
  private frame: SVGPathElement | null = null;
  private tail: SVGPathElement | null = null;

  setBubbleColour(colour: string) {
    this.bubbleColour = colour;
    this.frame?.setAttribute("fill", colour);
    this.tail?.setAttribute("fill", colour);
  }

  override position() {
    if (!this.isVisible() || !this.targetWorkspace.isVisible()) return;

    const width = this.getWidth();
    const height = this.contentHeight();
    const host = this.targetWorkspace.getInjectionDiv();

    let x = this.anchorX + this.anchorWidth + MARGIN;
    if (x + width + MARGIN > host.clientWidth) x = this.anchorX - width - MARGIN;
    x = Math.max(MARGIN, x);

    let y = this.anchorY;
    if (y + height + MARGIN > host.clientHeight)
      y = Math.max(MARGIN, host.clientHeight - height - MARGIN);

    this.drawBubble(width, height, x, y);
    this.positionAt_(width, height, x, y);
  }

  /** Keep one bubble-height of space below the last block. */
  private contentHeight(): number {
    const box = this.getWorkspace().getBlocksBoundingBox();
    const bottom = Number.isFinite(box.bottom) ? box.bottom : 0;
    return (bottom + this.MARGIN + FRAME) * this.getWorkspace().scale;
  }

  /** Move the laid-out blocks past the coloured frame. */
  protected override layout_(contents: Blockly.FlyoutItem[]) {
    super.layout_(contents);
    for (const item of contents) item.getElement().moveBy(0, FRAME);
  }

  private ensureBubbleDom() {
    if (this.frame || !this.svgGroup_ || !this.svgBackground_) return;
    this.svgGroup_.style.overflow = "visible";
    const make = () => {
      const element = document.createElementNS(SVG_NS, "path");
      element.setAttribute("class", "ziblock-condition-bubble");
      element.setAttribute("fill", this.bubbleColour);
      return element;
    };
    this.tail = make();
    this.frame = make();
    this.svgGroup_.insertBefore(this.tail, this.svgBackground_);
    this.svgGroup_.insertBefore(this.frame, this.svgBackground_);
  }

  private drawBubble(width: number, height: number, x: number, y: number) {
    this.ensureBubbleDom();

    this.frame?.setAttribute(
      "d",
      roundedRect(0, 0, width, height, this.CORNER_RADIUS),
    );
    this.svgBackground_?.setAttribute(
      "d",
      roundedRect(
        FRAME + 0.5,
        FRAME + 0.5,
        width - FRAME - 0.5,
        height - FRAME - 0.5,
        this.CORNER_RADIUS,
      ),
    );

    // The tail points back at the gear, so the bubble reads as belonging to
    // the block even though it sits beside it.
    const tailY = Math.min(
      Math.max(this.anchorY + GEAR_OFFSET - y, FRAME + 12),
      height - FRAME - 12,
    );
    const length = 8;
    const half = 6;
    const onLeft = x > this.anchorX;
    this.tail?.setAttribute(
      "d",
      onLeft
        ? `M 0,${tailY - half} L ${-length},${tailY} L 0,${tailY + half} Z`
        : `M ${width},${tailY - half} L ${width + length},${tailY} L ${width},${tailY + half} Z`,
    );
  }

  /**
   * Blockly's chaff-hiding pass runs on the pointerdown that reaches the gear.
   * Skip that one call so the icon's click can toggle the palette instead of
   * closing it and immediately reopening it.
   */
  ignoreAutoHide = false;

  override autoHide(_onlyClosePopups: boolean) {
    if (this.ignoreAutoHide) {
      this.ignoreAutoHide = false;
      return;
    }
    if (this.autoClose) this.hide();
  }
}

class ConditionPalette {
  readonly workspace: Blockly.WorkspaceSvg;
  readonly flyout: PaletteFlyout;
  private readonly dom: SVGElement;
  private currentBlock: Blockly.Block | null = null;
  private request = 0;

  constructor(workspace: Blockly.WorkspaceSvg) {
    this.workspace = workspace;
    const options = workspace.copyOptionsForFlyout();
    options.toolboxPosition = workspace.options.toolboxPosition;
    this.flyout = new PaletteFlyout(options);
    this.dom = this.flyout.createDom("svg") as SVGElement;
    this.dom.classList.add("ziblock-condition-flyout");
    workspace.getInjectionDiv().appendChild(this.dom);
    this.flyout.init(workspace);
    this.flyout.setAutoClose(true);

    workspace
      .getInjectionDiv()
      .addEventListener("pointerdown", this.onPointerDown, true);
    workspace.addChangeListener((event) => {
      if (!this.flyout.isVisible()) return;
      if (event.type === Blockly.Events.VIEWPORT_CHANGE) this.flyout.hide();
    });
  }

  /** Close the palette when the user clicks outside it or on another gear. */
  private onPointerDown = (event: PointerEvent) => {
    const target = event.target as Element | null;
    if (!target) return;
    // Gear clicks are handled by the icon itself (toggle); keep Blockly's
    // chaff-hiding pass out of that click so the toggle works.
    if (target.closest(".blocklyMutatorIcon")) {
      this.flyout.ignoreAutoHide = true;
      setTimeout(() => {
        this.flyout.ignoreAutoHide = false;
      }, 0);
      return;
    }
    if (this.flyout.isVisible() && !this.dom.contains(target))
      this.flyout.hide();
  };

  async toggle(block: Blockly.Block) {
    if (this.currentBlock === block && this.flyout.isVisible()) {
      this.flyout.hide();
      return;
    }
    this.currentBlock = block;
    const token = ++this.request;

    const name = String(block.getFieldValue("NAME") ?? "");
    let meta = name ? getCachedLexiconMeta(name) : undefined;
    if (name && !meta) {
      try {
        meta = await loadLexiconMeta(name);
      } catch {
        // Keep every condition available when the metadata cannot be loaded.
      }
    }
    if (token !== this.request || block.isDisposed()) return;
    this.show(block, meta);
  }

  private show(block: Blockly.Block, meta: LexiconMeta | undefined) {
    const types = QUERY_BLOCK_TYPES.filter((type) => {
      const kind = CONDITION_KINDS[type];
      if (!kind || kind === "index" || !meta) return true;
      return groupsForCondition(meta, kind).length > 0;
    });
    if (!types.length) return;

    const host = this.workspace.getInjectionDiv().getBoundingClientRect();
    const rect = (
      block as Blockly.BlockSvg
    ).getSvgRoot().getBoundingClientRect();
    this.flyout.anchorX = rect.left - host.left;
    this.flyout.anchorY = rect.top - host.top;
    this.flyout.anchorWidth = rect.width;
    this.flyout.setBubbleColour((block as Blockly.BlockSvg).getColour());

    this.flyout.show(types.map((type) => ({ kind: "block", type })));
    this.flyout.setVisible(true);
    // show() only repositions when the width changes; always reposition here.
    this.flyout.position();
  }
}

const palettes = new WeakMap<Blockly.WorkspaceSvg, ConditionPalette>();

function paletteFor(workspace: Blockly.WorkspaceSvg): ConditionPalette {
  let palette = palettes.get(workspace);
  if (!palette) {
    palette = new ConditionPalette(workspace);
    palettes.set(workspace, palette);
  }
  return palette;
}

class ConditionPaletteIcon extends Blockly.icons.MutatorIcon {
  constructor(sourceBlock: Blockly.BlockSvg) {
    super([], sourceBlock);
    this.setTooltip("查询条件");
  }

  protected override getAriaLabel(): string | null {
    return "查询条件";
  }

  override onClick() {
    const block = this.getSourceBlock();
    if (!block.isEditable()) return;
    if (!(block.workspace instanceof Blockly.WorkspaceSvg)) return;
    void paletteFor(block.workspace).toggle(block);
  }
}

/** Give a lexicon block its condition gear. */
export function addConditionPalette(block: Blockly.BlockSvg) {
  block.addIcon(new ConditionPaletteIcon(block));
}
