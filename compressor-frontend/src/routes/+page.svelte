<script lang="ts">
	import { onMount } from 'svelte';
	import Dropzone from '$lib/components/Dropzone.svelte';
	import FileList from '$lib/components/FileList.svelte';
	import Header from '$lib/components/Header.svelte';
	import LogConsole from '$lib/components/LogConsole.svelte';
	import PresetPicker from '$lib/components/PresetPicker.svelte';
	import SetupAccordion from '$lib/components/SetupAccordion.svelte';
	import { extractErrorMessage, parseSSE } from '$lib/sse';
	import type { LogEntry, LogType, PresetId, QueuedFile } from '$lib/types';
	import { downloadBase64, formatBytes, timestamp } from '$lib/utils';

	const STORAGE_KEY = 'glb-compressor:server-url';
	const DEFAULT_URL: string =
		import.meta.env.VITE_SERVER_URL || 'http://localhost:8080';

	let serverUrl = $state(DEFAULT_URL);

	let serverOnline = $state(false);
	let files = $state<QueuedFile[]>([]);
	let selectedPreset = $state<PresetId>('balanced');
	let simplifyEnabled = $state(false);
	let simplifyRatio = $state(0.5);
	let isCompressing = $state(false);
	let logOpen = $state(false);
	let logs = $state<LogEntry[]>([]);

	let fileIdCounter = 0;
	let logIdCounter = 0;

	const pendingCount = $derived(
		files.filter((f) => f.status === 'pending').length,
	);

	const buttonState = $derived.by(() => {
		if (!serverOnline) {
			return { text: 'Server offline \u2013 see setup above', disabled: true };
		}
		if (isCompressing) {
			const p = files.filter((f) => f.status === 'pending').length;
			const total = p + files.filter((f) => f.status === 'compressing').length;
			return {
				text:
					total > 0 ? `Compressing ${total - p}/${total}...` : 'Compressing...',
				disabled: true,
			};
		}
		if (pendingCount === 0) {
			return {
				text:
					files.length > 0 ? 'All files processed' : 'Select files to compress',
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

	function addLog(message: string, type: LogType = 'info') {
		logOpen = true;
		logs.push({ id: ++logIdCounter, time: timestamp(), message, type });
	}

	function updateFile(id: number, patch: Partial<QueuedFile>) {
		const file = files.find((f) => f.id === id);
		if (file) Object.assign(file, patch);
	}

	async function checkServer(reportError: boolean) {
		try {
			const res = await fetch(`${serverUrl}/healthz`, {
				signal: AbortSignal.timeout(3000),
			});
			serverOnline = res.ok;
		} catch {
			serverOnline = false;
			if (reportError)
				addLog('Server health check failed. Is glb-server running?', 'error');
		}
	}

	function addFiles(input: File[]) {
		const next = Array.from(input)
			.filter((f) => /\.(glb|gltf)$/i.test(f.name))
			.map((f) => ({
				id: ++fileIdCounter,
				file: f,
				status: 'pending' as const,
				result: null,
				error: null,
			}));
		if (next.length > 0) files.push(...next);
	}

	function removeFile(id: number) {
		files = files.filter((f) => f.id !== id);
	}

	function clearFiles() {
		files = files.filter((f) => f.status === 'compressing');
	}

	async function compressFile(queued: QueuedFile) {
		updateFile(queued.id, { status: 'compressing' });
		addLog(
			`\u2192 ${queued.file.name} (${formatBytes(queued.file.size)})`,
			'phase',
		);

		const form = new FormData();
		form.append('file', queued.file);

		let url = `${serverUrl}/compress-stream?preset=${selectedPreset}`;
		if (simplifyEnabled) url += `&simplify=${simplifyRatio}`;

		try {
			const response = await fetch(url, { method: 'POST', body: form });
			const ct = response.headers.get('content-type') ?? '';

			if (!ct.includes('text/event-stream')) {
				let message = `Server error ${response.status}`;
				try {
					const body: unknown = await response.json();
					const extracted = extractErrorMessage(body);
					if (extracted) message = extracted;
				} catch {
					/* keep default */
				}
				throw new Error(message);
			}

			await parseSSE(response, {
				onLog: (event) => addLog(event.message),
				onResult: (event) => {
					updateFile(queued.id, { status: 'done', result: event, error: null });
					addLog(
						`OK ${queued.file.name}: ${formatBytes(event.originalSize)} \u2192 ${formatBytes(event.compressedSize)} (-${event.ratio}%, ${event.method})`,
						'success',
					);
				},
				onError: (event) => {
					const msg = event.message ?? 'Compression failed';
					updateFile(queued.id, { status: 'error', error: msg });
					addLog(`\u2717 ${queued.file.name}: ${msg}`, 'error');
				},
			});

			const latest = files.find((f) => f.id === queued.id);
			if (latest?.status === 'compressing') {
				throw new Error('Stream ended without result');
			}
		} catch (error) {
			const latest = files.find((f) => f.id === queued.id);
			if (latest?.status !== 'compressing') return;

			const message =
				error instanceof Error && error.message.includes('Failed to fetch')
					? 'Cannot reach server. Is glb-server running?'
					: error instanceof Error
						? error.message
						: 'Compression failed';

			updateFile(queued.id, { status: 'error', error: message });
			addLog(`\u2717 ${queued.file.name}: ${message}`, 'error');
		}
	}

	async function compressAll() {
		const pending = files.filter((f) => f.status === 'pending');
		if (pending.length === 0 || isCompressing) return;

		isCompressing = true;
		logs.length = 0;
		logOpen = true;

		addLog(
			`Starting batch: ${pending.length} file${pending.length === 1 ? '' : 's'}, preset=${selectedPreset}`,
			'phase',
		);

		for (const queued of pending) {
			await compressFile(queued);
		}

		isCompressing = false;

		const doneCount = files.filter((f) => f.status === 'done').length;
		const errorCount = files.filter((f) => f.status === 'error').length;

		if (errorCount > 0) {
			addLog(`Finished: ${doneCount} compressed, ${errorCount} failed`, 'error');
		} else {
			addLog(
				`All ${doneCount} file${doneCount === 1 ? '' : 's'} compressed successfully`,
				'success',
			);
		}
	}

	/** Normalize URL: strip trailing slash, validate shape. */
	function normalizeUrl(raw: string): string {
		const trimmed = raw.trim().replace(/\/+$/, '');
		try {
			new URL(trimmed);
			return trimmed;
		} catch {
			return DEFAULT_URL;
		}
	}

	function handleServerUrlChange(url: string) {
		const normalized = normalizeUrl(url);
		serverUrl = normalized;
		try {
			localStorage.setItem(STORAGE_KEY, normalized);
		} catch {
			/* localStorage unavailable */
		}
		// Reset status and re-check immediately
		serverOnline = false;
		checkServer(true);
	}

	onMount(() => {
		// Restore saved URL from localStorage
		try {
			const saved = localStorage.getItem(STORAGE_KEY);
			if (saved) serverUrl = normalizeUrl(saved);
		} catch {
			/* localStorage unavailable */
		}

		checkServer(true);
		const interval = setInterval(() => checkServer(false), 5000);
		return () => clearInterval(interval);
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
	<Header {serverOnline} />
	<SetupAccordion
		{serverUrl}
		{serverOnline}
		onurlchange={handleServerUrlChange}
	/>
	<Dropzone onfiles={addFiles} />
	<FileList
		{files}
		onremove={removeFile}
		onclear={clearFiles}
		ondownload={downloadBase64}
	/>

	<p class="section-label">Compression preset</p>
	<PresetPicker bind:selected={selectedPreset} disabled={isCompressing} />

	<div class="options-row">
		<label class="option-label">
			<input type="checkbox" bind:checked={simplifyEnabled}>
			<span>Mesh simplification</span>
		</label>
		<div class="simplify-slider" class:active={simplifyEnabled}>
			<input
				type="range"
				min={10}
				max={90}
				step={10}
				value={simplifyRatio * 100}
				oninput={(e) => {
					simplifyRatio = Number(e.currentTarget.value) / 100;
				}}
			>
			<span class="simplify-value">{simplifyRatio.toFixed(1)}</span>
		</div>
	</div>

	<button
		type="button"
		class="btn"
		onclick={() => compressAll()}
		disabled={buttonState.disabled}
	>
		{buttonState.text}
	</button>

	<LogConsole bind:open={logOpen} {logs} />

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
