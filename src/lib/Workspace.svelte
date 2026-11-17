<script module>
  import ".";
  import * as Blockly from "blockly";
  import { migrateWorkspaceState } from "./shadow-slots";

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
  let {
    value = $bindable<string>(),
    error = $bindable<string>(),
    ...props
  } = $props();

  function emit(workspace: Blockly.WorkspaceSvg) {
    try {
      value = Generator.workspaceToCode(workspace);
      error = "";
    } catch (err: any) {
      error = err.message;
    }
  }
</script>

<div
  style="height: 100vh; width: 100vw;"
  {@attach (blocklyDiv) => {
    const workspace = Blockly.inject(blocklyDiv, {
      grid: { colour: "#f0f0f0", length: 12, snap: true, spacing: 32 },
      move: { drag: true, scrollbars: true, wheel: true },
      zoom: { controls: true, pinch: true, wheel: true },
      ...props,
    });
    // Keep the category flyout open: clicking the canvas or dragging a block
    // out no longer closes it, so several blocks can be picked in a row.
    const flyout = workspace.getFlyout();
    if (flyout instanceof Blockly.Flyout) flyout.setAutoClose(false);
    restoreWorkspace(workspace);
    emit(workspace);
    workspace.addChangeListener((event) => {
      if (event.isUiEvent) return;
      emit(workspace);
      saveWorkspace(workspace);
    });
    return () => {
      saveWorkspace(workspace);
      workspace.dispose();
    };
  }}
></div>
