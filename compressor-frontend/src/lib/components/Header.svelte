<script lang="ts">
	let { serverOnline }: { serverOnline: boolean } = $props();
</script>

<header>
	<div class="header-row">
		<p class="tag">// glb-compressor</p>
		<div
			class="server-status"
			class:online={serverOnline}
			class:offline={!serverOnline}
		>
			<span class="server-dot"></span>
			<span>{serverOnline ? 'Connected' : 'Offline'}</span>
		</div>
	</div>
	<h1>
		Compress<br>
		<span>your GLB.</span>
	</h1>
	<p class="subtitle">Drop files. Pick a preset. Done.</p>
</header>

<style>
	header {
		margin-bottom: 40px;
	}
	.header-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 12px;
	}
	.tag {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--accent);
		letter-spacing: 0.15em;
		text-transform: uppercase;
	}
	h1 {
		font-size: 42px;
		font-weight: 800;
		line-height: 1;
		letter-spacing: -1px;
	}
	h1 span {
		color: var(--accent);
	}
	.subtitle {
		margin-top: 10px;
		font-size: 14px;
		color: var(--muted);
		font-family: var(--mono);
	}
	.server-status {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--mono);
		font-size: 10px;
		padding: 4px 10px;
		border-radius: 12px;
		border: 1px solid var(--border);
		color: var(--muted);
		transition: all 0.3s;
	}
	.server-status.online {
		border-color: var(--accent-dim);
		color: var(--accent-dim);
	}
	.server-status.offline {
		border-color: #4d2222;
		color: #994444;
	}
	.server-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--muted);
		transition: all 0.3s;
	}
	.server-status.online .server-dot {
		background: var(--accent);
		box-shadow: 0 0 6px var(--accent-dim);
	}
	.server-status.offline .server-dot {
		background: var(--danger);
	}
	@media (max-width: 500px) {
		h1 {
			font-size: 32px;
		}
		.header-row {
			flex-direction: column;
			align-items: flex-start;
			gap: 8px;
		}
	}
</style>
