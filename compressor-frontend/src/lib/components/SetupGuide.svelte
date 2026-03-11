<script lang="ts">
import SetupCommand from './SetupCommand.svelte';

let open = $state(false);
</script>

<button
	type="button"
	class="setup-header"
	class:open
	onclick={() => (open = !open)}
>
	<div class="setup-header-left">
		<span class="setup-badge">First time?</span>
		<span class="setup-title">Click here for setup instructions</span>
	</div>
	<span class="setup-chevron" class:open>&#9660;</span>
</button>

{#if open}
	<div class="setup-body">
		<p class="setup-intro">
			You only need to do steps 1&ndash;3 <strong>once ever</strong>.<br>
			Step 4 you do <strong>each time</strong> you want to use this page.
		</p>

		<div class="step">
			<div class="step-num">1</div>
			<div class="step-content">
				<div class="step-title">Open PowerShell</div>
				<div class="step-desc">
					Press the <strong>Windows key</strong> on your keyboard (bottom-left,
					looks like &#8862;).<br>
					Type <strong>PowerShell</strong> and press <strong>Enter</strong>.<br>
					A blue or black window will open &ndash; that is normal.
				</div>
			</div>
		</div>

		<div class="step">
			<div class="step-num">2</div>
			<div class="step-content">
				<div class="step-title">Install Bun &ndash; only once</div>
				<div class="step-desc">
					Click <strong>Copy</strong> below, then paste in PowerShell and press
					<strong>Enter</strong>.
				</div>
				<SetupCommand command='powershell -c "irm bun.sh/install.ps1 | iex"' />
				<div class="step-note">
					&#9888; When finished: close PowerShell completely, then reopen it.
				</div>
			</div>
		</div>

		<div class="step">
			<div class="step-num">3</div>
			<div class="step-content">
				<div class="step-title">Install the compressor &ndash; only once</div>
				<div class="step-desc">
					In the reopened PowerShell, click <strong>Copy</strong>, paste, then
					press <strong>Enter</strong>.
				</div>
				<SetupCommand command="bun i -g glb-compressor" />
				<div class="step-note">Wait for it to finish. Then continue.</div>
			</div>
		</div>

		<hr class="divider">

		<div class="step">
			<div class="step-num">4</div>
			<div class="step-content">
				<div class="step-title">
					Start the server &ndash; every time you use this page
				</div>
				<div class="step-desc">Open PowerShell, then run this:</div>
				<SetupCommand command="glb-server" />
				<div class="warning-box">
					<strong>&#9888; Keep PowerShell open!</strong>
					Do not close that window while using this page.
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
.setup-header {
	width: 100%;
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 16px 20px;
	background: transparent;
	appearance: none;
	text-align: left;
	font: inherit;
	color: inherit;
	cursor: pointer;
	user-select: none;
	border: none;
	border-bottom: 1px solid transparent;
	transition: border-color 0.2s, background 0.15s;
}
.setup-header:hover {
	background: var(--surface);
}
.setup-header.open {
	border-bottom-color: var(--border-dim);
}
.setup-header-left {
	display: flex;
	align-items: center;
	gap: 12px;
}
.setup-badge {
	background: #1a2400;
	border: 1px solid var(--accent-dim);
	color: var(--accent);
	font-family: var(--mono);
	font-size: 10px;
	padding: 3px 8px;
	border-radius: 3px;
	letter-spacing: 0.1em;
	text-transform: uppercase;
}
.setup-title {
	font-size: 14px;
	font-weight: 600;
	color: var(--text);
}
.setup-chevron {
	color: var(--muted);
	font-size: 12px;
	font-family: var(--mono);
	transition: transform 0.25s;
}
.setup-chevron.open {
	transform: rotate(180deg);
}
.setup-body {
	padding: 28px 24px;
}
.setup-intro {
	font-family: var(--mono);
	font-size: 11px;
	color: #666;
	margin-bottom: 24px;
	line-height: 1.8;
}
.setup-intro strong {
	color: #999;
}
.step {
	display: flex;
	gap: 16px;
	margin-bottom: 28px;
}
.step:last-child {
	margin-bottom: 0;
}
.step-num {
	flex-shrink: 0;
	width: 28px;
	height: 28px;
	background: #1a2400;
	border: 1px solid var(--accent-dim);
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
	font-family: var(--mono);
	font-size: 12px;
	color: var(--accent);
	margin-top: 2px;
}
.step-content {
	flex: 1;
}
.step-title {
	font-size: 14px;
	font-weight: 700;
	margin-bottom: 6px;
	color: var(--text);
}
.step-desc {
	font-family: var(--mono);
	font-size: 11px;
	color: #888;
	line-height: 1.9;
	margin-bottom: 10px;
}
.step-desc strong {
	color: #ccc;
}
.step-note {
	font-family: var(--mono);
	font-size: 10px;
	color: var(--muted);
	margin-top: 8px;
	line-height: 1.7;
}
.divider {
	border: none;
	border-top: 1px solid var(--border-dim);
	margin: 24px 0;
}
.warning-box {
	background: var(--warn-bg);
	border: 1px solid var(--warn-border);
	border-radius: 6px;
	padding: 14px 16px;
	font-family: var(--mono);
	font-size: 11px;
	color: #cc7a00;
	line-height: 1.8;
	margin-top: 8px;
}
.warning-box strong {
	color: var(--warn);
	display: block;
	margin-bottom: 4px;
}
</style>
