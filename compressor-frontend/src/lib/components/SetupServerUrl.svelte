<script lang="ts">
	let {
		serverUrl,
		serverOnline,
		onurlchange,
	}: {
		serverUrl: string;
		serverOnline: boolean;
		onurlchange: (url: string) => void;
	} = $props();

	let localEdit = $state<string | null>(null);
	let urlInput = $derived(localEdit ?? serverUrl);
	let urlDirty = $derived(
		localEdit !== null && localEdit.trim().replace(/\/+$/, '') !== serverUrl,
	);

	function applyUrl() {
		const trimmed = urlInput.trim().replace(/\/+$/, '');
		if (trimmed.length > 0) {
			onurlchange(trimmed);
		}
		localEdit = null;
	}
</script>

<div class="url-bar">
	<label class="url-label" for="server-url">Server</label>
	<div class="url-input-row">
		<span
			class="url-dot"
			class:online={serverOnline}
			class:offline={!serverOnline}
		></span>
		<input
			id="server-url"
			type="url"
			class="url-input"
			value={urlInput}
			placeholder="http://localhost:8080"
			oninput={(event) => {
				localEdit = event.currentTarget.value;
			}}
			onkeydown={(event) => {
				if (
					event.key === 'Enter' ||
					(event.key === 's' && (event.ctrlKey || event.metaKey))
				) {
					event.preventDefault();
					applyUrl();
				}
			}}
		>
		{#if urlDirty}
			<button type="button" class="url-apply" onclick={applyUrl}>Apply</button>
		{/if}
	</div>
</div>

<style>
	.url-bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 16px;
		border-bottom: 1px solid var(--border-dim);
	}
	.url-label {
		font-family: var(--mono);
		font-size: 10px;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		flex-shrink: 0;
	}
	.url-input-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 0;
	}
	.url-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--muted);
		transition: all 0.3s;
	}
	.url-dot.online {
		background: var(--accent);
		box-shadow: 0 0 6px var(--accent-dim);
	}
	.url-dot.offline {
		background: var(--danger);
	}
	.url-input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		font-family: var(--mono);
		font-size: 12px;
		color: var(--text);
		padding: 4px 8px;
		outline: none;
		transition: border-color 0.15s, background 0.15s;
	}
	.url-input:hover {
		border-color: var(--border);
	}
	.url-input:focus {
		border-color: var(--accent-dim);
		background: #070707;
	}
	.url-input::placeholder {
		color: var(--muted);
		opacity: 0.5;
	}
	.url-apply {
		flex-shrink: 0;
		background: #1a2400;
		border: 1px solid var(--accent-dim);
		color: var(--accent);
		font-family: var(--mono);
		font-size: 10px;
		padding: 4px 10px;
		border-radius: 3px;
		cursor: pointer;
		transition: background 0.15s;
		letter-spacing: 0.05em;
	}
	.url-apply:hover {
		background: #263500;
	}
</style>
