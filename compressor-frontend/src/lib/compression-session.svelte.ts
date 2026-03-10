import { extractErrorMessage, parseSSE } from './sse';
import type { LogEntry, LogType, PresetId, QueuedFile } from './types';
import { formatBytes, timestamp } from './utils';

const STORAGE_KEY = 'glb-compressor:server-url';
const DEFAULT_URL: string = import.meta.env.VITE_SERVER_URL || 'http://localhost:8080';

interface CompressionState {
	serverUrl: string;
	serverOnline: boolean;
	files: QueuedFile[];
	selectedPreset: PresetId;
	simplifyEnabled: boolean;
	simplifyRatio: number;
	isCompressing: boolean;
	logOpen: boolean;
	logs: LogEntry[];
}

export interface CompressionSession {
	state: CompressionState;
	addFiles: (input: File[]) => void;
	removeFile: (id: number) => void;
	clearFiles: () => void;
	compressAll: () => Promise<void>;
	handleServerUrlChange: (url: string) => void;
	restoreServerUrl: () => void;
	startHealthPolling: () => () => void;
}

function normalizeUrl(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, '');
	try {
		new URL(trimmed);
		return trimmed;
	} catch {
		return DEFAULT_URL;
	}
}

export function createCompressionSession(): CompressionSession {
	const state = $state<CompressionState>({
		serverUrl: DEFAULT_URL,
		serverOnline: false,
		files: [],
		selectedPreset: 'balanced',
		simplifyEnabled: false,
		simplifyRatio: 0.5,
		isCompressing: false,
		logOpen: false,
		logs: [],
	});

	let fileIdCounter = 0;
	let logIdCounter = 0;

	function addLog(message: string, type: LogType = 'info') {
		state.logOpen = true;
		state.logs.push({ id: ++logIdCounter, time: timestamp(), message, type });
	}

	function updateFile(id: number, patch: Partial<QueuedFile>) {
		const file = state.files.find((candidate) => candidate.id === id);
		if (file) {
			Object.assign(file, patch);
		}
	}

	async function checkServer(reportError: boolean) {
		try {
			const response = await fetch(`${state.serverUrl}/healthz`, {
				signal: AbortSignal.timeout(3000),
			});
			state.serverOnline = response.ok;
		} catch {
			state.serverOnline = false;
			if (reportError) {
				addLog('Server health check failed. Is glb-server running?', 'error');
			}
		}
	}

	function addFiles(input: File[]) {
		const next = Array.from(input)
			.filter((file) => /\.(glb|gltf)$/i.test(file.name))
			.map(
				(file): QueuedFile => ({
					id: ++fileIdCounter,
					file,
					status: 'pending',
					result: null,
					error: null,
				}),
			);

		if (next.length > 0) {
			state.files.push(...next);
		}
	}

	function removeFile(id: number) {
		state.files = state.files.filter((file) => file.id !== id);
	}

	function clearFiles() {
		state.files = state.files.filter((file) => file.status === 'compressing');
	}

	async function compressFile(queued: QueuedFile) {
		updateFile(queued.id, { status: 'compressing' });
		addLog(`-> ${queued.file.name} (${formatBytes(queued.file.size)})`, 'phase');

		const form = new FormData();
		form.append('file', queued.file);

		let url = `${state.serverUrl}/compress-stream?preset=${state.selectedPreset}`;
		if (state.simplifyEnabled) {
			url += `&simplify=${state.simplifyRatio}`;
		}

		try {
			const response = await fetch(url, { method: 'POST', body: form });
			const contentType = response.headers.get('content-type') ?? '';

			if (!contentType.includes('text/event-stream')) {
				let message = `Server error ${response.status}`;
				try {
					const body: unknown = await response.json();
					const extracted = extractErrorMessage(body);
					if (extracted) {
						message = extracted;
					}
				} catch {
					// keep fallback message
				}
				throw new Error(message);
			}

			await parseSSE(response, {
				onLog: (event) => addLog(event.message),
				onResult: (event) => {
					updateFile(queued.id, {
						status: 'done',
						result: event,
						error: null,
					});
					addLog(
						`OK ${queued.file.name}: ${formatBytes(event.originalSize)} -> ${formatBytes(event.compressedSize)} (-${event.ratio}%, ${event.method})`,
						'success',
					);
				},
				onError: (event) => {
					const message = event.message ?? 'Compression failed';
					updateFile(queued.id, { status: 'error', error: message });
					addLog(`x ${queued.file.name}: ${message}`, 'error');
				},
			});

			const latest = state.files.find((file) => file.id === queued.id);
			if (latest?.status === 'compressing') {
				throw new Error('Stream ended without result');
			}
		} catch (error) {
			const latest = state.files.find((file) => file.id === queued.id);
			if (latest?.status !== 'compressing') {
				return;
			}

			const message =
				error instanceof Error && error.message.includes('Failed to fetch')
					? 'Cannot reach server. Is glb-server running?'
					: error instanceof Error
						? error.message
						: 'Compression failed';

			updateFile(queued.id, { status: 'error', error: message });
			addLog(`x ${queued.file.name}: ${message}`, 'error');
		}
	}

	async function compressAll() {
		const pending = state.files.filter((file) => file.status === 'pending');
		if (pending.length === 0 || state.isCompressing) {
			return;
		}

		state.isCompressing = true;
		state.logs.length = 0;
		state.logOpen = true;

		addLog(
			`Starting batch: ${pending.length} file${pending.length === 1 ? '' : 's'}, preset=${state.selectedPreset}`,
			'phase',
		);

		for (const queued of pending) {
			await compressFile(queued);
		}

		state.isCompressing = false;

		const doneCount = state.files.filter((file) => file.status === 'done').length;
		const errorCount = state.files.filter((file) => file.status === 'error').length;

		if (errorCount > 0) {
			addLog(`Finished: ${doneCount} compressed, ${errorCount} failed`, 'error');
		} else {
			addLog(`All ${doneCount} file${doneCount === 1 ? '' : 's'} compressed successfully`, 'success');
		}
	}

	function handleServerUrlChange(url: string) {
		const normalized = normalizeUrl(url);
		state.serverUrl = normalized;
		try {
			localStorage.setItem(STORAGE_KEY, normalized);
		} catch {
			// localStorage unavailable
		}
		state.serverOnline = false;
		void checkServer(true);
	}

	function restoreServerUrl() {
		try {
			const saved = localStorage.getItem(STORAGE_KEY);
			if (saved) {
				state.serverUrl = normalizeUrl(saved);
			}
		} catch {
			// localStorage unavailable
		}
	}

	function startHealthPolling() {
		void checkServer(true);
		const interval = setInterval(() => {
			void checkServer(false);
		}, 5000);
		return () => {
			clearInterval(interval);
		};
	}

	return {
		state,
		addFiles,
		removeFile,
		clearFiles,
		compressAll,
		handleServerUrlChange,
		restoreServerUrl,
		startHealthPolling,
	};
}
