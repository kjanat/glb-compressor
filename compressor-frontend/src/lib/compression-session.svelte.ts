import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { extractErrorMessage, parseSSE } from './sse';
import type { CompressResult, LogEntry, LogType, PresetId, QueuedFile } from './types';
import { formatBytes, timestamp } from './utils';

const STORAGE_KEY = 'glb-compressor:server-url';
const DEFAULT_URL: string = import.meta.env.VITE_SERVER_URL || 'http://localhost:8080';
const STREAM_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

function parseFiniteNumber(value: string | null): number | undefined {
	if (value === null) {
		return undefined;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function fallbackOutputFilename(name: string): string {
	return name.replace(/\.(glb|gltf)$/i, '-compressed.glb');
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isModelFile(name: string): boolean {
	return /\.(glb|gltf)$/i.test(name);
}

function isGltfFile(name: string): boolean {
	return /\.gltf$/i.test(name);
}

function isDataUri(uri: string): boolean {
	return uri.startsWith('data:');
}

function isRemoteUri(uri: string): boolean {
	return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(uri);
}

function decodeUriComponentSafe(uri: string): string {
	try {
		return decodeURIComponent(uri);
	} catch {
		return uri;
	}
}

function getUriBasename(uri: string): string {
	const normalized = uri.replace(/\\/g, '/');
	const lastSegment = normalized.split('/').pop();
	return lastSegment ?? normalized;
}

function normalizeResourceKey(value: string): string {
	return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function getResourceIdentity(file: File): string {
	if (file.webkitRelativePath.length > 0) {
		return normalizeResourceKey(file.webkitRelativePath);
	}
	return file.name;
}

function collectResourceKeys(file: File): string[] {
	const keys = new SvelteSet<string>();
	const push = (value: string) => {
		if (value.length === 0) {
			return;
		}
		keys.add(value);
		keys.add(normalizeResourceKey(value));
	};

	push(file.name);
	if (file.webkitRelativePath.length > 0) {
		push(file.webkitRelativePath);
	}

	const decodedName = decodeUriComponentSafe(file.name);
	if (decodedName !== file.name) {
		push(decodedName);
	}

	const basename = getUriBasename(decodedName);
	if (basename.length > 0) {
		push(basename);
	}

	return Array.from(keys);
}

function collectExternalResourceUris(root: Record<string, unknown>): string[] {
	const uris = new SvelteSet<string>();

	const collect = (value: unknown) => {
		if (!Array.isArray(value)) {
			return;
		}

		for (const item of value) {
			if (!isObjectRecord(item)) {
				continue;
			}

			const uri = item.uri;
			if (typeof uri !== 'string' || uri.length === 0 || isDataUri(uri) || isRemoteUri(uri)) {
				continue;
			}

			uris.add(uri);
		}
	};

	collect(root.buffers);
	collect(root.images);

	return Array.from(uris);
}

async function collectRequiredResources(gltfFile: File): Promise<string[]> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await gltfFile.text());
	} catch {
		throw new Error(`Invalid .gltf JSON: ${gltfFile.name}`);
	}

	if (!isObjectRecord(parsed)) {
		throw new Error(`Invalid .gltf JSON: ${gltfFile.name}`);
	}

	return collectExternalResourceUris(parsed);
}

function parseContentDispositionFilename(contentDisposition: string | null): string | undefined {
	if (!contentDisposition) {
		return undefined;
	}

	const starMatch = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
	if (starMatch?.[1]) {
		try {
			return decodeURIComponent(starMatch[1]);
		} catch {
			return starMatch[1];
		}
	}

	const quotedMatch = /filename="([^"]+)"/i.exec(contentDisposition);
	if (quotedMatch?.[1]) {
		return quotedMatch[1];
	}

	const bareMatch = /filename=([^;]+)/i.exec(contentDisposition);
	if (bareMatch?.[1]) {
		return bareMatch[1].trim();
	}

	return undefined;
}

function toRatioPercent(originalSize: number, compressedSize: number): number {
	if (originalSize <= 0) {
		return 0;
	}

	return Number(((1 - compressedSize / originalSize) * 100).toFixed(1));
}

async function readErrorMessage(response: Response): Promise<string> {
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

	return message;
}

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
	const resourcePool = new SvelteMap<string, File>();

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
			.filter((file) => {
				if (isModelFile(file.name)) {
					return true;
				}

				resourcePool.set(getResourceIdentity(file), file);
				return false;
			})
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

		try {
			const result =
				queued.file.size > STREAM_UPLOAD_MAX_BYTES
					? await compressWithBinaryEndpoint(queued)
					: await compressWithStreamEndpoint(queued);

			updateFile(queued.id, {
				status: 'done',
				result,
				error: null,
			});
			addLog(
				`OK ${queued.file.name}: ${formatBytes(result.originalSize)} -> ${formatBytes(result.compressedSize)} (-${result.ratio}%, ${result.method})`,
				'success',
			);
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

	async function buildUploadForm(queued: QueuedFile): Promise<FormData> {
		const form = new FormData();
		form.append('file', queued.file);

		if (!isGltfFile(queued.file.name)) {
			return form;
		}

		const requiredUris = await collectRequiredResources(queued.file);
		if (requiredUris.length === 0) {
			return form;
		}

		const resourceIndex = new SvelteMap<string, File>();
		for (const resource of resourcePool.values()) {
			for (const key of collectResourceKeys(resource)) {
				if (!resourceIndex.has(key)) {
					resourceIndex.set(key, resource);
				}
			}
		}

		const attachedResources = new SvelteSet<string>();
		const missingUris: string[] = [];

		for (const uri of requiredUris) {
			const normalizedUri = normalizeResourceKey(uri);
			const decodedUri = decodeUriComponentSafe(uri);
			const normalizedDecodedUri = normalizeResourceKey(decodedUri);
			const basename = getUriBasename(normalizedDecodedUri);

			const match =
				resourceIndex.get(uri) ??
				resourceIndex.get(normalizedUri) ??
				resourceIndex.get(decodedUri) ??
				resourceIndex.get(normalizedDecodedUri) ??
				resourceIndex.get(basename);

			if (!match) {
				missingUris.push(uri);
				continue;
			}

			const identity = getResourceIdentity(match);
			if (attachedResources.has(identity)) {
				continue;
			}

			attachedResources.add(identity);
			form.append('resource', match, match.name);
		}

		if (missingUris.length > 0) {
			throw new Error(`Missing external resources: ${missingUris.join(', ')}`);
		}

		return form;
	}

	async function compressWithStreamEndpoint(queued: QueuedFile): Promise<CompressResult> {
		const form = await buildUploadForm(queued);

		let url = `${state.serverUrl}/compress-stream?preset=${state.selectedPreset}`;
		if (state.simplifyEnabled) {
			url += `&simplify=${state.simplifyRatio}`;
		}

		const response = await fetch(url, { method: 'POST', body: form });
		const contentType = response.headers.get('content-type') ?? '';

		if (!contentType.includes('text/event-stream')) {
			throw new Error(await readErrorMessage(response));
		}

		let streamResult: CompressResult | null = null;

		await parseSSE(response, {
			onLog: (event) => addLog(event.message),
			onResult: (event) => {
				streamResult = {
					...event,
					payloadType: 'base64',
				};
			},
			onError: (event) => {
				const message = event.message ?? 'Compression failed';
				throw new Error(message);
			},
		});

		if (!streamResult) {
			throw new Error('Stream ended without result');
		}

		return streamResult;
	}

	async function compressWithBinaryEndpoint(queued: QueuedFile): Promise<CompressResult> {
		addLog(`Large file detected (${formatBytes(queued.file.size)}), using binary endpoint`, 'info');

		const form = await buildUploadForm(queued);

		let url = `${state.serverUrl}/compress?preset=${state.selectedPreset}`;
		if (state.simplifyEnabled) {
			url += `&simplify=${state.simplifyRatio}`;
		}

		const response = await fetch(url, { method: 'POST', body: form });
		if (!response.ok) {
			throw new Error(await readErrorMessage(response));
		}

		const blob = await response.blob();

		const requestId = response.headers.get('X-Request-ID') ?? crypto.randomUUID();
		const originalSize = parseFiniteNumber(response.headers.get('X-Original-Size')) ?? queued.file.size;
		const compressedSize = parseFiniteNumber(response.headers.get('X-Compressed-Size')) ?? blob.size;
		const method = response.headers.get('X-Compression-Method') ?? 'unknown';
		const ratio =
			parseFiniteNumber(response.headers.get('X-Compression-Ratio')) ?? toRatioPercent(originalSize, compressedSize);
		const filename =
			parseContentDispositionFilename(response.headers.get('content-disposition')) ??
			fallbackOutputFilename(queued.file.name);

		return {
			payloadType: 'blob',
			blob,
			requestId,
			filename,
			originalSize,
			compressedSize,
			method,
			ratio,
		};
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
