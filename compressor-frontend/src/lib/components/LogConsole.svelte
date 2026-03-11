<script lang="ts">
import type { LogEntry } from '$lib/types';

let {
	open = $bindable(false),
	logs,
}: {
	open: boolean;
	logs: LogEntry[];
} = $props();

let logContainer: HTMLDivElement | undefined = $state();

$effect(() => {
	if (open && logContainer && logs.length > 0) {
		logContainer.scrollTo({ top: logContainer.scrollHeight });
	}
});
</script>

{#if open}
	<div class="log-console">
		<div class="log-header">
			<span class="log-title">Compression log</span>
			<button
				type="button"
				class="log-close"
				title="Close"
				onclick={() => (open = false)}
			>
				&times;
			</button>
		</div>
		<div bind:this={logContainer} class="log-entries">
			{#each logs as line (line.id)}
				<div
					class="log-line"
					class:phase={line.type === 'phase'}
					class:success={line.type === 'success'}
					class:error={line.type === 'error'}
				>
					<span class="log-time">{line.time}</span>
					{line.message}
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
.log-console {
	background: #060606;
	border: 1px solid var(--border-dim);
	border-radius: 8px;
	margin-top: 20px;
	overflow: hidden;
}
.log-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 10px 14px;
	border-bottom: 1px solid var(--border-dim);
}
.log-title {
	font-family: var(--mono);
	font-size: 10px;
	color: #333;
	text-transform: uppercase;
	letter-spacing: 0.1em;
}
.log-close {
	background: none;
	border: none;
	color: #333;
	font-size: 14px;
	cursor: pointer;
	padding: 0 4px;
	line-height: 1;
}
.log-close:hover {
	color: var(--muted);
}
.log-entries {
	padding: 12px 14px;
	max-height: 260px;
	overflow-y: auto;
	scroll-behavior: smooth;
}
.log-entries::-webkit-scrollbar {
	width: 6px;
}
.log-entries::-webkit-scrollbar-track {
	background: transparent;
}
.log-entries::-webkit-scrollbar-thumb {
	background: #1a1a1a;
	border-radius: 3px;
}
.log-line {
	font-family: var(--mono);
	font-size: 11px;
	line-height: 1.8;
	color: #444;
	animation: logIn 0.15s ease;
}
.log-line.phase {
	color: var(--accent-dim);
}
.log-line.success {
	color: var(--accent);
}
.log-line.error {
	color: var(--danger);
}
.log-time {
	color: #282828;
	margin-right: 10px;
	user-select: none;
}
</style>
