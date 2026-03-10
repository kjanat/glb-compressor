<script lang="ts">
	import type { QueuedFile } from '$lib/types';
	import { formatBytes } from '$lib/utils';

	let {
		files,
		onremove,
		onclear,
		ondownload,
	}: {
		files: QueuedFile[];
		onremove: (id: number) => void;
		onclear: () => void;
		ondownload: (base64: string, filename: string) => void;
	} = $props();

	const doneCount = $derived(files.filter((f) => f.status === 'done').length);
</script>

{#if files.length > 0}
	<div class="file-list">
		<div class="file-list-header">
			<span class="file-count">
				{files.length} file{files.length === 1 ? '' : 's'}
				{#if doneCount > 0}&middot; {doneCount} compressed{/if}
			</span>
			<button type="button" class="file-clear" onclick={onclear}>
				Clear all
			</button>
		</div>

		{#each files as item (item.id)}
			<div class="file-item {item.status}">
				<span class="file-icon">
					{#if item.status === 'pending'}&#9675;{/if}
					{#if item.status === 'compressing'}<span class="spinner"
						>&#10227;</span>{/if}
					{#if item.status === 'done'}&#10003;{/if}
					{#if item.status === 'error'}&#10007;{/if}
				</span>
				<span class="file-name" title={item.file.name}>{item.file.name}</span>
				<span class="file-size">
					{#if item.status === 'done' && item.result}
						{formatBytes(item.result.originalSize)} &rarr; {
							formatBytes(item.result.compressedSize)
						}
						<span class="file-ratio">-{item.result.ratio}%</span>
					{:else}
						{formatBytes(item.file.size)}
					{/if}
				</span>
				<span class="file-actions">
					{#if item.status === 'done' && item.result}
						{@const result = item.result}
						<button
							type="button"
							class="file-dl"
							title="Download"
							onclick={() => ondownload(result.data, result.filename)}
						>
							&darr;
						</button>
					{/if}
					{#if item.status !== 'compressing'}
						<button
							type="button"
							class="file-rm"
							title="Remove"
							onclick={() => onremove(item.id)}
						>
							&times;
						</button>
					{/if}
				</span>
			</div>
		{/each}
	</div>
{/if}

<style>
	.file-list {
		margin-bottom: 24px;
	}
	.file-list-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 8px;
	}
	.file-count {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--muted);
	}
	.file-clear {
		font-family: var(--mono);
		font-size: 10px;
		color: var(--muted);
		background: none;
		border: none;
		cursor: pointer;
		padding: 2px 6px;
		border-radius: 3px;
		transition: color 0.15s;
	}
	.file-clear:hover {
		color: var(--danger);
	}
	.file-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		margin-bottom: 4px;
		font-family: var(--mono);
		font-size: 12px;
		transition: all 0.15s;
	}
	.file-item.compressing {
		border-color: var(--accent-dim);
		background: var(--accent-bg);
	}
	.file-item.done {
		border-color: var(--accent-border);
	}
	.file-item.error {
		border-color: var(--danger-border);
		background: var(--danger-bg);
	}
	.file-icon {
		flex-shrink: 0;
		width: 20px;
		text-align: center;
		font-size: 13px;
	}
	.file-item.done .file-icon {
		color: var(--accent);
	}
	.file-item.error .file-icon {
		color: var(--danger);
	}
	.file-item.compressing .file-icon {
		color: var(--accent);
	}
	.file-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text);
	}
	.file-size {
		flex-shrink: 0;
		color: var(--muted);
		font-size: 11px;
	}
	.file-ratio {
		color: var(--accent);
		margin-left: 4px;
	}
	.file-actions {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}
	.file-dl {
		background: var(--accent);
		color: #000;
		border: none;
		font-family: var(--mono);
		font-size: 11px;
		font-weight: 700;
		padding: 3px 8px;
		border-radius: 3px;
		cursor: pointer;
		transition: background 0.15s;
	}
	.file-dl:hover {
		background: #d9ff3a;
	}
	.file-rm {
		background: none;
		border: 1px solid var(--border);
		color: var(--muted);
		font-size: 14px;
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 3px;
		cursor: pointer;
		transition: all 0.15s;
		line-height: 1;
	}
	.file-rm:hover {
		border-color: var(--danger-border);
		color: var(--danger);
	}
	.spinner {
		display: inline-block;
		animation: spin 1s linear infinite;
	}
	@media (max-width: 500px) {
		.file-name {
			max-width: 140px;
		}
	}
</style>
