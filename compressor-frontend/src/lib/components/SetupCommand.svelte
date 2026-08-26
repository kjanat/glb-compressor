<script lang="ts">
	import { onDestroy } from 'svelte';

	let { command }: { command: string } = $props();

	let copied = $state(false);
	let resetTimer: ReturnType<typeof setTimeout> | undefined;

	function copyCommand() {
		navigator.clipboard.writeText(command).then(() => {
			copied = true;
			if (resetTimer) {
				clearTimeout(resetTimer);
			}
			resetTimer = setTimeout(() => {
				copied = false;
			}, 2000);
		});
	}

	onDestroy(() => {
		if (resetTimer) {
			clearTimeout(resetTimer);
		}
	});
</script>

<div class="cmd-block">
	<span class="cmd-text">{command}</span>
	<button
		type="button"
		class="copy-btn"
		class:copied
		onclick={copyCommand}
	>
		{copied ? 'Copied!' : 'Copy'}
	</button>
</div>

<style>
	.cmd-block {
		background: #070707;
		border: 1px solid var(--border-dim);
		border-radius: 6px;
		padding: 12px 14px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-top: 8px;
	}
	.cmd-text {
		font-family: var(--mono);
		font-size: 13px;
		color: var(--accent);
		user-select: all;
		word-break: break-all;
	}
	.copy-btn {
		flex-shrink: 0;
		background: #1a2400;
		border: 1px solid var(--accent-dim);
		color: var(--accent);
		font-family: var(--mono);
		font-size: 10px;
		padding: 5px 12px;
		border-radius: 3px;
		cursor: pointer;
		transition: background 0.15s;
		letter-spacing: 0.05em;
	}
	.copy-btn:hover {
		background: #263500;
	}
	.copy-btn.copied {
		color: #aaa;
		border-color: #333;
		background: #1a1a1a;
	}
</style>
