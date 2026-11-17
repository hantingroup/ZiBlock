<script lang="ts">
	import { resource } from "runed";
	import toolbox from "./lib/toolbox.yml";
	import Workspace from "./lib/Workspace.svelte";
	import { loadLexiconList, LEXICON_API_ORIGIN } from "./lib/lexicons";

	let compiledCode = $state("");
	let compileError = $state("");

	// Primes the shared list cache used by the lexicon name dropdown.
	const lexicons = resource(
		() => "list",
		async () => loadLexiconList(),
	);

	const executeResource = resource(
		() => compiledCode,
		async (cmd, _, { signal }) => {
			const res = await fetch(`${LEXICON_API_ORIGIN}/api/tianzi`, {
				signal,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cmd }),
			});
			const data = await res.json();
			console.log(data);
			return data.msg;
		},
	);
</script>

<section>
	<Workspace {toolbox} bind:value={compiledCode} bind:error={compileError} />
	<div id="outputDiv" style="top: 0;">
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
</style>
