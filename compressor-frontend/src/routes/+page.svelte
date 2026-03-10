<script lang="ts">
	import { onMount } from 'svelte';
	import Dropzone from '$lib/components/Dropzone.svelte';
	import FileList from '$lib/components/FileList.svelte';
	import Header from '$lib/components/Header.svelte';
	import LogConsole from '$lib/components/LogConsole.svelte';
	import PresetPicker from '$lib/components/PresetPicker.svelte';
	import SetupAccordion from '$lib/components/SetupAccordion.svelte';
	import { createCompressionSession } from '$lib/compression-session.svelte';
	import { downloadCompressionResult } from '$lib/utils';

	const session = createCompressionSession();
	const state = session.state;

	const pendingCount = $derived(
		state.files.filter((file) => file.status === 'pending').length,
	);

	function handleDownload(id: number) {
		const item = state.files.find((file) => file.id === id);
		if (!item?.result) {
			return;
		}

		downloadCompressionResult(item.result);
	}

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
		ondownload={handleDownload}
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
				style={`--slider-value: ${state.simplifyRatio * 100}%`}
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
		gap: 14px;
		margin-bottom: 28px;
		padding: 12px 14px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		flex-wrap: nowrap;
	}
	.option-label {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
		font-family: var(--mono);
		font-size: 11px;
		color: var(--muted);
		cursor: pointer;
		white-space: nowrap;
		user-select: none;
	}
	.option-label input[type="checkbox"] {
		appearance: none;
		-webkit-appearance: none;
		width: 32px;
		height: 18px;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: #090909;
		position: relative;
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
	}
	.option-label input[type="checkbox"]::before {
		content: "";
		position: absolute;
		top: 2px;
		left: 2px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #3d3d3d;
		transition: transform 0.15s, background 0.15s;
	}
	.option-label input[type="checkbox"]:checked {
		background: #182100;
		border-color: var(--accent-dim);
	}
	.option-label input[type="checkbox"]:checked::before {
		transform: translateX(14px);
		background: var(--accent);
	}
	.option-label input[type="checkbox"]:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
	}
	.simplify-slider {
		display: flex;
		flex: 1;
		min-width: 0;
		align-items: center;
		gap: 8px;
		opacity: 0;
		visibility: hidden;
		pointer-events: none;
		transition: opacity 0.15s;
	}
	.simplify-slider.active {
		opacity: 1;
		visibility: visible;
		pointer-events: auto;
	}
	.simplify-slider input[type="range"] {
		flex: 1;
		min-width: 0;
		appearance: none;
		-webkit-appearance: none;
		height: 16px;
		background: transparent;
		cursor: pointer;
	}
	.simplify-slider input[type="range"]::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 999px;
		background: linear-gradient(
			90deg,
			var(--accent) 0,
			var(--accent) var(--slider-value),
			#262626 var(--slider-value),
			#262626 100%
		);
	}
	.simplify-slider input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 12px;
		height: 12px;
		margin-top: -4px;
		border-radius: 50%;
		border: 1px solid #0d0d0d;
		background: #f4ffbc;
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
	}
	.simplify-slider input[type="range"]::-moz-range-track {
		height: 4px;
		border-radius: 999px;
		background: #262626;
	}
	.simplify-slider input[type="range"]::-moz-range-progress {
		height: 4px;
		border-radius: 999px;
		background: var(--accent);
	}
	.simplify-slider input[type="range"]::-moz-range-thumb {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 1px solid #0d0d0d;
		background: #f4ffbc;
	}
	.simplify-slider input[type="range"]:focus-visible {
		outline: none;
	}
	.simplify-slider input[type="range"]:focus-visible::-webkit-slider-thumb {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
	}
	.simplify-slider input[type="range"]:focus-visible::-moz-range-thumb {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
	}
	.simplify-value {
		font-family: var(--mono);
		font-size: 12px;
		color: var(--accent);
		min-width: 28px;
		text-align: right;
		font-variant-numeric: tabular-nums;
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
			gap: 10px;
			padding: 10px 11px;
		}
		.option-label {
			font-size: 10px;
			gap: 6px;
		}
		.option-label input[type="checkbox"] {
			width: 28px;
			height: 16px;
		}
		.option-label input[type="checkbox"]::before {
			width: 10px;
			height: 10px;
		}
		.option-label input[type="checkbox"]:checked::before {
			transform: translateX(12px);
		}
		.simplify-slider {
			gap: 6px;
		}
		.simplify-value {
			font-size: 11px;
			min-width: 24px;
		}
	}
</style>
