<script lang="ts">
	import { resource } from "runed";
	import toolbox from "./lib/blocks/toolbox.yml";
	import Workspace from "./lib/Workspace.svelte";
	import { loadLexiconList } from "./lib/api/lexicons";
	import { tianziUrl } from "./lib/api/base";
	import { fetchTianziStack, type TianziStack } from "./lib/api/tianzi";

	let compiledCode = $state("");
	let compileError = $state("");

	/** The methods Workspace exposes through `bind:this`. */
	interface WorkspaceApi {
		importStack(stack: TianziStack): number;
	}
	let workspaceComponent = $state<WorkspaceApi>();

	let importOpen = $state(false);
	let importSource = $state("");
	let importError = $state("");
	let importing = $state(false);
	let importTextarea = $state<HTMLTextAreaElement>();

	// Focus the editor as soon as the dialog appears.
	$effect(() => {
		if (importOpen) importTextarea?.focus();
	});

	function openImport() {
		importError = "";
		importOpen = true;
	}

	function closeImport() {
		if (!importing) importOpen = false;
	}

	async function submitImport() {
		const source = importSource;
		if (!source.trim() || importing) return;
		importing = true;
		importError = "";
		try {
			const stack = await fetchTianziStack(source);
			const added = workspaceComponent?.importStack(stack) ?? 0;
			if (added === 0) {
				importError = "没有找到可导入的积木";
				return;
			}
			importOpen = false;
			importSource = "";
		} catch (error) {
			importError = error instanceof Error ? error.message : String(error);
		} finally {
			importing = false;
		}
	}

	// Primes the shared list cache used by the lexicon name dropdown.
	resource(() => "list", async () => loadLexiconList());

	const executeResource = resource(
		() => compiledCode,
		async (cmd, _, { signal }) => {
			const res = await fetch(tianziUrl("/api/tianzi"), {
				signal,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cmd }),
			});
			const data = await res.json();
			return data.msg;
		},
	);
</script>

<section>
	<Workspace
		{toolbox}
		bind:this={workspaceComponent}
		bind:value={compiledCode}
		bind:error={compileError}
	/>
	<div id="outputDiv" style="top: 0;">
		<button type="button" class="refresh" onclick={openImport}>从文本导入</button>
		{#if compileError}
			<pre><code class="error">{compileError}</code></pre>
		{:else if compiledCode}
			<pre><code>{compiledCode}</code></pre>
		{/if}
		{#if !compileError}
			{#if executeResource.error}
				<pre><code class="error">{executeResource.error}</code></pre>
			{:else if executeResource.current}
				<pre class:stale={executeResource.loading}><code>{executeResource.current}</code></pre>
			{/if}
			{#if compiledCode}
				<button
					type="button"
					class="refresh"
					disabled={executeResource.loading}
					onclick={() => executeResource.refetch()}
				>
					{executeResource.loading ? "生成中…" : "↻ 刷新结果"}
				</button>
			{/if}
		{/if}
	</div>
</section>

{#if importOpen}
	<div
		class="modal-backdrop"
		role="presentation"
		onclick={closeImport}
	>
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="import-title"
			tabindex="-1"
			onclick={(event) => event.stopPropagation()}
			onkeydown={(event) => {
				if (event.key === "Escape") closeImport();
			}}
		>
			<h2 id="import-title">从文本导入积木</h2>
			<p class="hint">
				粘贴填字指令，服务端会解析成语法树，再把对应的积木加到画布上。
			</p>
			<textarea
				bind:this={importTextarea}
				bind:value={importSource}
				placeholder="例如：[[#5]] 或 [[1-9:.2f;d@n<读>写，=3]]"
				spellcheck="false"
			></textarea>
			{#if importError}
				<pre class="error import-error">{importError}</pre>
			{/if}
			<div class="modal-actions">
				<button type="button" onclick={closeImport} disabled={importing}>
					取消
				</button>
				<button
					type="button"
					class="primary"
					onclick={submitImport}
					disabled={importing || !importSource.trim()}
				>
					{importing ? "导入中…" : "导入"}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	#outputDiv {
		position: fixed;
		right: 0;
		margin: 1em;
		max-width: 50vw;
		max-height: 40vh;
		overflow: auto;
		user-select: none;
		display: flex;
		flex-direction: column;
		align-items: end;
		gap: 0.5em;
		scrollbar-width: thin;
		scrollbar-color: rgba(107, 99, 117, 0.45) transparent;
	}

	#outputDiv::-webkit-scrollbar {
		width: 6px;
		height: 6px;
	}

	#outputDiv::-webkit-scrollbar-thumb {
		background: rgba(107, 99, 117, 0.45);
		border-radius: 3px;
	}

	#outputDiv::-webkit-scrollbar-track {
		background: transparent;
	}

	.refresh {
		font: inherit;
		font-size: 12px;
		line-height: 1.2;
		padding: 2px 10px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--bg);
		color: var(--text);
		cursor: pointer;
	}

	.refresh:hover:not(:disabled) {
		color: var(--text-h);
		border-color: currentColor;
	}

	.refresh:disabled {
		cursor: default;
		opacity: 0.6;
	}

	/* A result from the previous request, kept visible until the new one lands. */
	.stale {
		opacity: 0.5;
	}

	code {
		user-select: text;
	}

	.error {
		color: red;
	}

	/* Import dialog ========================================================= */

	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(16, 14, 20, 0.35);
	}

	.modal {
		box-sizing: border-box;
		width: min(36rem, calc(100vw - 2rem));
		padding: 1.25rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--bg);
		box-shadow: 0 12px 40px rgba(16, 14, 20, 0.25);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.modal h2 {
		font-size: 1.1rem;
		color: var(--text-h);
	}

	.hint {
		font-size: 0.85rem;
	}

	.modal textarea {
		box-sizing: border-box;
		width: 100%;
		min-height: 9rem;
		resize: vertical;
		padding: 0.6rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--code-bg);
		color: var(--text-h);
		font: 14px/1.45 var(--mono);
	}

	.modal textarea:focus {
		outline: 2px solid #8a7fa8;
		outline-offset: 1px;
	}

	.import-error {
		max-height: 8rem;
		overflow: auto;
		margin: 0;
		font-size: 13px;
		white-space: pre-wrap;
		user-select: text;
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.modal-actions button {
		font: inherit;
		font-size: 14px;
		padding: 4px 14px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
		cursor: pointer;
	}

	.modal-actions button:hover:not(:disabled) {
		color: var(--text-h);
		border-color: currentColor;
	}

	.modal-actions button:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.modal-actions .primary {
		background: #6b5b8e;
		border-color: #6b5b8e;
		color: #fff;
	}

	.modal-actions .primary:hover:not(:disabled) {
		color: #fff;
		background: #5b4c7c;
	}
</style>
