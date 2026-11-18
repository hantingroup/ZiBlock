/**
 * Gear palette for lexicon query conditions.
 *
 * The gear opens a native Blockly bubble (the same bubble the mutator icon
 * uses: coloured rounded frame, tail, shadow) but without a mini workspace.
 * The bubble's content is a real flyout whose blocks are dragged straight into
 * the main workspace.
 *
 * The offered conditions are filtered by the selected lexicon's schema.
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

/** Condition block types this lexicon cannot run (670e360 behaviour). */
function unsupportedConditionTypes(meta: LexiconMeta): Set<string> {
  const unsupported = new Set<string>();
  for (const type of QUERY_BLOCK_TYPES) {
    const kind = CONDITION_KINDS[type];
    // Index queries are global; they are not bound to a schema group.
    if (!kind || kind === "index") continue;
    if (groupsForCondition(meta, kind).length === 0) unsupported.add(type);
  }
  return unsupported;
}

function supportedTypes(meta: LexiconMeta | undefined): string[] {
  if (!meta) return [...QUERY_BLOCK_TYPES];
  const unsupported = unsupportedConditionTypes(meta);
  return QUERY_BLOCK_TYPES.filter((type) => !unsupported.has(type));
}

const SVG_NS = "http://www.w3.org/2000/svg";
const BORDER = 6;

/**
 * A flyout that lives inside a bubble instead of at the workspace edge.
 * It renders at scale 1; the bubble canvas applies the workspace zoom.
 */
class BubbleFlyout extends Blockly.VerticalFlyout {
  constructor(options: Blockly.Options) {
    super(options);
    // The bubble wrapper handles dragging on empty flyout space; the stock
    // handler would start a flyout drag against the wrong workspace.
    (this as unknown as {
      onMouseDown: (event: PointerEvent) => void;
    }).onMouseDown = () => {};
  }

  override getFlyoutScale(): number {
    return 1;
  }

  /**
   * A toolbox flyout's client rect is an infinite strip at the workspace edge.
   * This one floats in a bubble, so only its own on-screen box counts as
   * "inside the flyout"; everything else is a drop into the main workspace.
   */
  override getClientRect(): Blockly.utils.Rect | null {
    if (!this.svgGroup_ || !this.isVisible()) return null;
    const rect = this.svgGroup_.getBoundingClientRect();
    return new Blockly.utils.Rect(
      rect.top,
      rect.bottom,
      rect.left,
      rect.right,
    );
  }

  protected override layout_(contents: Blockly.FlyoutItem[]) {
    this.workspace_.scale = 1;
    const x = this.RTL ? this.MARGIN : this.MARGIN + this.tabWidth_;
    let y = this.MARGIN;
    for (const item of contents) {
      item.getElement().moveBy(x, y);
      y += item.getElement().getBoundingRectangle().getHeight();
    }
  }

  override position() {
    if (!this.isVisible()) return;
    const width = this.getWidth();
    const height = this.getContentHeight();
    const corner = this.CORNER_RADIUS;
    // Use the stock flyout background; setBackgroundPath is private in typings.
    const self = this as unknown as {
      setBackgroundPath(width: number, height: number): void;
    };
    self.setBackgroundPath(
      Math.max(width - corner, 0),
      Math.max(height - 2 * corner, 0),
    );
    this.positionAt_(width, height, 0, 0);
  }

  /** Laid-out content height plus the flyout's bottom margin. */
  getContentHeight(): number {
    const box = this.getWorkspace().getBlocksBoundingBox();
    const bottom = Number.isFinite(box.bottom) ? box.bottom : 0;
    return bottom + this.MARGIN;
  }
}

/**
 * The stock Blockly bubble shell with a flyout in place of the mini
 * workspace. Colours, tail, shadow and drag behaviour all come from Bubble.
 */
class ConditionBubble extends Blockly.bubbles.Bubble {
  readonly flyout: BubbleFlyout;
  private readonly wrapper: SVGGElement;

  constructor(
    workspace: Blockly.WorkspaceSvg,
    anchor: Blockly.utils.Coordinate,
    ownerRect: Blockly.utils.Rect,
    colour: string,
    owner: ConditionPaletteIcon,
  ) {
    super(workspace, anchor, ownerRect, undefined, owner);
    this.svgRoot.classList.add("ziblock-condition-bubble");
    this.setColour(colour);

    this.wrapper = document.createElementNS(SVG_NS, "g");
    this.wrapper.setAttribute("transform", `translate(${BORDER}, ${BORDER})`);
    this.contentContainer.appendChild(this.wrapper);

    // Empty space inside the flyout moves the bubble; blocks start their own
    // drag, so only presses that are not on a block reach this handler. The
    // event then continues to the workspace so it starts and binds the gesture,
    // exactly as a press on the bubble's own background does.
    this.wrapper.addEventListener("pointerdown", (event) => {
      const target = event.target as Element | null;
      if (target?.closest(".blocklyDraggable")) return;
      const gesture = this.workspace.getGesture(event);
      gesture?.handleBubbleStart(event, this);
      // Focusing selects the bubble, which makes the gesture drag it.
      Blockly.getFocusManager().focusNode(this);
    });

    const options = workspace.copyOptionsForFlyout();
    options.toolboxPosition = workspace.options.toolboxPosition;
    this.flyout = new BubbleFlyout(options);
    this.wrapper.appendChild(this.flyout.createDom("g"));
    this.flyout.init(workspace);
    // The bubble stays open while several conditions are picked.
    this.flyout.setAutoClose(false);
  }

  show(types: readonly string[]) {
    this.flyout.show(types.map((type) => ({ kind: "block", type })));
    this.flyout.setVisible(true);
    this.flyout.position();

    const width = this.flyout.getWidth();
    const height = this.flyout.getContentHeight();
    // Let the stock bubble pick its own spot (and stay draggable).
    this.setSize(
      new Blockly.utils.Size(width + 2 * BORDER, height + 2 * BORDER),
      true,
    );
  }

  /**
   * Blockly's focus tree treats any visible bubble on a MutatorIcon as a mini
   * workspace and asks for its workspace. Ours is the flyout workspace.
   */
  getWorkspace(): Blockly.WorkspaceSvg {
    return this.flyout.getWorkspace();
  }

  override dispose() {
    this.flyout.dispose();
    super.dispose();
  }
}

class ConditionPalette {
  private readonly workspace: Blockly.WorkspaceSvg;
  private bubble: ConditionBubble | null = null;
  private currentBlock: Blockly.Block | null = null;
  private currentIcon: ConditionPaletteIcon | null = null;
  private request = 0;

  constructor(workspace: Blockly.WorkspaceSvg) {
    this.workspace = workspace;
    workspace.addChangeListener((event) => {
      if (!this.currentBlock) return;
      if (event.type === Blockly.Events.BLOCK_DELETE) {
        const deleted = event as Blockly.Events.BlockDelete;
        if (deleted.blockId === this.currentBlock.id) this.close();
      } else if (event.type === Blockly.Events.BLOCK_MOVE) {
        // Icons are not always re-laid out during a drag; follow the block.
        const moved = event as Blockly.Events.BlockMove;
        if (this.currentIcon && moved.blockId === this.currentBlock.id)
          this.bubble?.setAnchorLocation(this.currentIcon.getPaletteAnchor());
      }
    });
  }

  async toggle(block: Blockly.Block, icon: ConditionPaletteIcon) {
    if (this.currentBlock === block && this.bubble) {
      this.close();
      return;
    }
    await this.open(block, icon);
  }

  /** Open (or keep open) the bubble for this block. */
  async open(block: Blockly.Block, icon: ConditionPaletteIcon) {
    if (this.currentBlock === block && this.bubble) return;
    this.close();
    this.currentBlock = block;
    this.currentIcon = icon;
    const token = ++this.request;

    const name = String(block.getFieldValue("NAME") ?? "");
    let meta = name ? getCachedLexiconMeta(name) : undefined;
    if (name && !meta) {
      try {
        meta = await loadLexiconMeta(name);
      } catch {
        // Leave every condition available when the metadata cannot be loaded.
      }
    }
    if (token !== this.request || block.isDisposed()) return;

    const bubble = new ConditionBubble(
      this.workspace,
      icon.getPaletteAnchor(),
      icon.getPaletteOwnerRect(),
      (block as Blockly.BlockSvg).getColour(),
      icon,
    );
    this.bubble = bubble;
    // Blockly's focus tree finds a bubble through its owner's getBubble();
    // without this the bubble cannot be focused, selected or dragged.
    icon.setPaletteBubble(bubble);
    bubble.show(supportedTypes(meta));
  }

  closeFor(block: Blockly.Block) {
    if (this.currentBlock === block) this.close();
  }

  /** Keep the bubble's tail pointing at the gear as its block moves. */
  updateAnchor(block: Blockly.Block, anchor: Blockly.utils.Coordinate) {
    if (this.currentBlock === block) this.bubble?.setAnchorLocation(anchor);
  }

  private close() {
    this.currentIcon?.setPaletteBubble(null);
    this.bubble?.dispose();
    this.bubble = null;
    this.currentBlock = null;
    this.currentIcon = null;
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
  /**
   * The condition bubble this gear owns. MutatorIcon tracks its mini workspace
   * bubble in a private field, so this one is kept here and reported through
   * the IHasBubble methods below, which is how the focus tree discovers it.
   */
  private paletteBubble: ConditionBubble | null = null;

  constructor(sourceBlock: Blockly.BlockSvg) {
    super([], sourceBlock);
    this.setTooltip("查询条件");
  }

  protected override getAriaLabel(): string | null {
    return "查询条件";
  }

  setPaletteBubble(bubble: ConditionBubble | null) {
    this.paletteBubble = bubble;
  }

  override getBubble(): Blockly.bubbles.MiniWorkspaceBubble | null {
    return this.paletteBubble as unknown as
      | Blockly.bubbles.MiniWorkspaceBubble
      | null;
  }

  override bubbleIsVisible(): boolean {
    return !!this.paletteBubble;
  }

  override setBubbleVisible(visible: boolean): Promise<void> {
    const block = this.getSourceBlock();
    if (!(block.workspace instanceof Blockly.WorkspaceSvg))
      return Promise.resolve();
    const palette = paletteFor(block.workspace);
    if (visible) return palette.open(block, this);
    palette.closeFor(block);
    return Promise.resolve();
  }

  /** The bubble tail points at the middle of the gear. */
  getPaletteAnchor(): Blockly.utils.Coordinate {
    return Blockly.utils.Coordinate.sum(
      this.workspaceLocation,
      new Blockly.utils.Coordinate(8.5, 8.5),
    );
  }

  /** The block rectangle the bubble should avoid covering. */
  getPaletteOwnerRect(): Blockly.utils.Rect {
    const block = this.getSourceBlock() as Blockly.BlockSvg;
    const box = block.getSvgRoot().getBBox();
    return new Blockly.utils.Rect(
      box.y,
      box.y + box.height,
      box.x,
      box.x + box.width,
    );
  }

  override onLocationChange(blockOrigin: Blockly.utils.Coordinate) {
    super.onLocationChange(blockOrigin);
    const block = this.getSourceBlock();
    if (block.workspace instanceof Blockly.WorkspaceSvg)
      paletteFor(block.workspace).updateAnchor(block, this.getPaletteAnchor());
  }

  override onClick() {
    const block = this.getSourceBlock();
    if (!block.isEditable()) return;
    if (!(block.workspace instanceof Blockly.WorkspaceSvg)) return;
    void paletteFor(block.workspace).toggle(block, this);
  }

  override dispose() {
    const block = this.getSourceBlock();
    if (block.workspace instanceof Blockly.WorkspaceSvg)
      paletteFor(block.workspace).closeFor(block);
    super.dispose();
  }
}

/** Give a lexicon block its condition gear. */
export function addConditionPalette(block: Blockly.BlockSvg) {
  block.addIcon(new ConditionPaletteIcon(block));
}
