<script module>
  import ".";
  import * as Blockly from "blockly";
  import { refreshBlockEffectiveness } from "./block-state";
  import { migrateWorkspaceState } from "./shadow-slots";
  import { AppTheme } from "./theme";

  // The default (15px) is chunky next to the grid; keep scrolling usable but
  // visually lighter. Must be set before Blockly.inject creates scrollbars.
  Blockly.Scrollbar.scrollbarThickness = 10;

  const STORAGE_KEY = "ziblock:workspace";

  // Dev only: keep the workspace across Vite HMR updates and full reloads.
  function getStorage(): Storage | undefined {
    if (!import.meta.hot) return undefined;
    try {
      return sessionStorage;
    } catch {
      return undefined;
    }
  }

  function saveWorkspace(workspace: Blockly.WorkspaceSvg) {
    const storage = getStorage();
    if (!storage) return;
    try {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify(Blockly.serialization.workspaces.save(workspace)),
      );
    } catch {
      // Ignore quota / private-mode errors; persistence is a dev convenience.
    }
  }

  function restoreWorkspace(workspace: Blockly.WorkspaceSvg) {
    const storage = getStorage();
    if (!storage) return;
    try {
      const saved = storage.getItem(STORAGE_KEY);
      if (saved) {
        const state = JSON.parse(saved);
        migrateWorkspaceState(state);
        Blockly.serialization.workspaces.load(state, workspace);
      }
    } catch (err) {
      console.warn("Failed to restore Blockly workspace", err);
      storage.removeItem(STORAGE_KEY);
    }
  }
</script>

<script lang="ts">
  import Generator from "./generator";
  import { workspaceStateFromStack } from "./text-import";
  import type { TianziStack } from "./tianzi";

  let {
    value = $bindable<string>(),
    error = $bindable<string>(),
    ...props
  } = $props();

  /** The injected canvas, available once the attachment below has run. */
  let workspace: Blockly.WorkspaceSvg | undefined;

  function emit(workspace: Blockly.WorkspaceSvg) {
    try {
      value = Generator.workspaceToCode(workspace);
      error = "";
    } catch (err: any) {
      error = err.message;
    }
  }

  // Refreshing may toggle Blockly's disabled state, which fires change events;
  // ignore those while the state pass is running.
  let refreshing = false;
  function refresh(workspace: Blockly.WorkspaceSvg) {
    if (refreshing) return;
    refreshing = true;
    try {
      refreshBlockEffectiveness(workspace);
    } finally {
      refreshing = false;
    }
  }

  /** Free canvas space below the existing top blocks. */
  function freeSpot(workspace: Blockly.WorkspaceSvg): { x: number; y: number } {
    const tops = workspace.getTopBlocks(false);
    if (tops.length === 0) return { x: 40, y: 40 };

    let left = Infinity;
    let bottom = -Infinity;
    for (const block of tops) {
      const position = block.getRelativeToSurfaceXY();
      const { height } = block.getHeightWidth();
      left = Math.min(left, position.x);
      bottom = Math.max(bottom, position.y + height);
    }
    return {
      x: Number.isFinite(left) ? left : 40,
      y: Number.isFinite(bottom) ? bottom + 40 : 40,
    };
  }

  /**
   * Appends the blocks described by a Tianzi syntax tree to the canvas.
   * Returns how many top-level blocks were added.
   */
  export function importStack(stack: TianziStack): number {
    if (!workspace) throw new Error("画布尚未就绪");
    const state = workspaceStateFromStack(stack);
    const tops = state.blocks.blocks;
    if (tops.length > 0) {
      const spot = freeSpot(workspace);
      tops[0].x = spot.x;
      tops[0].y = spot.y;
    }
    Blockly.serialization.workspaces.load(state, workspace, {
      recordUndo: true,
    });
    refresh(workspace);
    emit(workspace);
    return tops.length;
  }
</script>

<div
  style="height: 100vh; width: 100vw;"
  {@attach (blocklyDiv) => {
    const injected = Blockly.inject(blocklyDiv, {
      grid: { colour: "#f0f0f0", length: 12, snap: true, spacing: 32 },
      move: { drag: true, scrollbars: true, wheel: true },
      zoom: { controls: true, pinch: true, wheel: true },
      theme: AppTheme,
      ...props,
    });
    workspace = injected;
    // Keep the category flyout open: clicking the canvas or dragging a block
    // out no longer closes it, so several blocks can be picked in a row.
    const flyout = injected.getFlyout();
    if (flyout instanceof Blockly.Flyout) flyout.setAutoClose(false);

    restoreWorkspace(injected);
    refresh(injected);
    emit(injected);
    injected.addChangeListener((event) => {
      if (event.isUiEvent || refreshing) return;
      refresh(injected);
      emit(injected);
      saveWorkspace(injected);
    });
    return () => {
      saveWorkspace(injected);
      injected.dispose();
      if (workspace === injected) workspace = undefined;
    };
  }}
></div>
