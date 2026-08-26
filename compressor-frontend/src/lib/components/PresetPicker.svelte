<script lang="ts">
	import type { PresetId } from '$lib/types';
	import { PRESETS } from '$lib/types';

	let {
		selected = $bindable<PresetId>('balanced'),
		disabled = false,
	}: {
		selected: PresetId;
		disabled?: boolean;
	} = $props();
</script>

<div class="presets">
	{#each PRESETS as preset (preset.id)}
		<button
			type="button"
			class="preset-btn"
			class:active={selected === preset.id}
			onclick={() => {
				if (!disabled) selected = preset.id;
			}}
		>
			<span class="preset-name">{preset.name}</span>
			<span class="preset-reduction">{preset.reduction}</span>
			<span class="preset-desc">{preset.desc}</span>
		</button>
	{/each}
</div>

<style>
	.presets {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 8px;
		margin-bottom: 20px;
	}
	.preset-btn {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 14px 8px;
		cursor: pointer;
		text-align: center;
		transition: all 0.15s;
		color: var(--text);
		font-family: var(--sans);
	}
	.preset-btn:hover {
		border-color: var(--accent-dim);
	}
	.preset-btn.active {
		border-color: var(--accent);
		background: var(--accent-bg);
	}
	.preset-name {
		font-size: 13px;
		font-weight: 600;
		display: block;
		margin-bottom: 4px;
	}
	.preset-reduction {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--accent);
	}
	.preset-btn:not(.active) .preset-reduction {
		color: var(--muted);
	}
	.preset-desc {
		font-size: 10px;
		color: var(--muted);
		margin-top: 4px;
		display: block;
		font-family: var(--mono);
		line-height: 1.4;
	}
	@media (max-width: 500px) {
		.presets {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
