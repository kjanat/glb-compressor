<script lang="ts">
	import { onMount } from 'svelte';
	import Dropzone from '$lib/components/Dropzone.svelte';
	import FileList from '$lib/components/FileList.svelte';
	import Header from '$lib/components/Header.svelte';
	import LogConsole from '$lib/components/LogConsole.svelte';
	import PresetPicker from '$lib/components/PresetPicker.svelte';
	import SetupAccordion from '$lib/components/SetupAccordion.svelte';
	import { createCompressionSession } from '$lib/compression-session.svelte';
	import { downloadBase64 } from '$lib/utils';

	const session = createCompressionSession();
	const state = session.state;

	const pendingCount = $derived(
		state.files.filter((file) => file.status === 'pending').length,
	);

	const buttonState = $derived.by(() => {
		if (!state.serverOnline) {
			return { text: 'Server offline \u2013 see setup above', disabled: true };
		}
		if (state.isCompressing) {
			const pending = state.files.filter(
				(file) => file.status === 'pending',
			).length;
			const total =
				pending +
				state.files.filter((file) => file.status === 'compressing').length;
			return {
				text:
					total > 0
						? `Compressing ${total - pending}/${total}...`
						: 'Compressing...',
				disabled: true,
			};
		}
		if (pendingCount === 0) {
			return {
				text:
					state.files.length > 0
						? 'All files processed'
						: 'Select files to compress',
				disabled: true,
			};
		}
		return {
			text:
				pendingCount === 1
					? 'Compress \u2192'
					: `Compress ${pendingCount} files \u2192`,
			disabled: false,
		};
	});

	onMount(() => {
		session.restoreServerUrl();
		return session.startHealthPolling();
	});
</script>

<svelte:head>
	<title>GLB Compressor</title>
	<meta
		name="description"
		content="Compress your GLB/glTF 3D models locally with live progress"
	>
</svelte:head>

<div class="wrapper">
	<Header serverOnline={state.serverOnline} />
	<SetupAccordion
		serverUrl={state.serverUrl}
		serverOnline={state.serverOnline}
		onurlchange={session.handleServerUrlChange}
	/>
	<Dropzone onfiles={session.addFiles} />
	<FileList
		files={state.files}
		onremove={session.removeFile}
		onclear={session.clearFiles}
		ondownload={downloadBase64}
	/>

	<p class="section-label">Compression preset</p>
	<PresetPicker
		bind:selected={state.selectedPreset}
		disabled={state.isCompressing}
	/>

	<div class="options-row">
		<label class="option-label">
			<input type="checkbox" bind:checked={state.simplifyEnabled}>
			<span>Mesh simplification</span>
		</label>
		<div class="simplify-slider" class:active={state.simplifyEnabled}>
			<input
				type="range"
				min={10}
				max={90}
				step={10}
				value={state.simplifyRatio * 100}
				oninput={(event) => {
					state.simplifyRatio = Number(event.currentTarget.value) / 100;
				}}
			>
			<span class="simplify-value">{state.simplifyRatio.toFixed(1)}</span>
		</div>
	</div>

	<button
		type="button"
		class="btn"
		onclick={session.compressAll}
		disabled={buttonState.disabled}
	>
		{buttonState.text}
	</button>

	<LogConsole bind:open={state.logOpen} logs={state.logs} />

	<footer>
		runs locally via glb-server &middot; configure the server URL above<br>
		your files never leave your machine &middot; streaming compression with live
		progress
	</footer>
</div>

<style>
	.wrapper {
		width: 100%;
		max-width: 660px;
		position: relative;
		z-index: 1;
	}
	.section-label {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--muted);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		margin-bottom: 12px;
	}
	.options-row {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-bottom: 28px;
		padding: 12px 14px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	.option-label {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--mono);
		font-size: 11px;
		color: var(--muted);
		cursor: pointer;
		white-space: nowrap;
		user-select: none;
	}
	.option-label input[type="checkbox"] {
		accent-color: var(--accent);
		width: 14px;
		height: 14px;
	}
	.simplify-slider {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 10px;
		opacity: 0;
		visibility: hidden;
		pointer-events: none;
	}
	.simplify-slider.active {
		opacity: 1;
		visibility: visible;
		pointer-events: auto;
	}
	.simplify-slider input[type="range"] {
		flex: 1;
		accent-color: var(--accent);
		height: 4px;
	}
	.simplify-value {
		font-family: var(--mono);
		font-size: 12px;
		color: var(--accent);
		min-width: 28px;
		text-align: right;
	}
	.btn {
		width: 100%;
		padding: 18px;
		background: var(--accent);
		color: #000;
		border: none;
		border-radius: 6px;
		font-family: var(--sans);
		font-size: 16px;
		font-weight: 800;
		cursor: pointer;
		letter-spacing: 0.05em;
		transition: background 0.15s, transform 0.1s;
		text-transform: uppercase;
	}
	.btn:hover:not(:disabled) {
		background: #d9ff3a;
	}
	.btn:active:not(:disabled) {
		transform: scale(0.99);
	}
	.btn:disabled {
		background: #1a2400;
		color: var(--muted);
		cursor: not-allowed;
	}
	footer {
		margin-top: 48px;
		font-family: var(--mono);
		font-size: 10px;
		color: #2a2a2a;
		text-align: center;
		line-height: 1.8;
	}
	@media (max-width: 500px) {
		.options-row {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
