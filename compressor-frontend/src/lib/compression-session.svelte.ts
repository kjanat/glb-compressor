import { SvelteMap } from 'svelte/reactivity';
import type { CompressResult, LogEntry, LogType, PresetId, QueuedFile } from './types';
import { formatBytes, timestamp } from './utils';

const STORAGE_KEY = 'glb-compressor:server-url';
const DEFAULT_URL: string = import.meta.env.VITE_SERVER_URL || 'http://localhost:8080';
const MAX_POLL_TIMEOUT_MS = 10 * 60_000; // 10 minutes
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
	const keys = new Set<string>();
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
	const uris = new Set<string>();

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

type QueueJobStatus = 'queued' | 'running' | 'done' | 'error';

interface QueueCreateJobResponse {
	requestId: string;
	status: 'queued';
	statusUrl: string;
	resultUrl: string;
}

interface QueueJobSnapshot {
	requestId: string;
	status: QueueJobStatus;
	queuePosition: number | undefined;
	logs: string[];
	result:
		| {
				filename: string;
				originalSize: number;
				compressedSize: number;
				ratio: number;
				method: string;
		  }
		| undefined;
	error:
		| {
				code: string;
				message: string;
		  }
		| undefined;
}

function parseQueueJobStatus(value: unknown): QueueJobStatus | undefined {
	if (value === 'queued' || value === 'running' || value === 'done' || value === 'error') {
		return value;
	}
	return undefined;
}

function parseQueueCreateJobResponse(value: unknown): QueueCreateJobResponse | undefined {
	if (!isObjectRecord(value)) {
		return undefined;
	}

	const { requestId, status, statusUrl, resultUrl } = value;
	if (
		typeof requestId !== 'string' ||
		status !== 'queued' ||
		typeof statusUrl !== 'string' ||
		typeof resultUrl !== 'string'
	) {
		return undefined;
	}

	return {
		requestId,
		status,
		statusUrl,
		resultUrl,
	};
}

function parseQueueJobSnapshot(value: unknown): QueueJobSnapshot | undefined {
	if (!isObjectRecord(value)) {
		return undefined;
	}

	const requestId = value.requestId;
	const status = parseQueueJobStatus(value.status);
	if (typeof requestId !== 'string' || status === undefined) {
		return undefined;
	}

	let queuePosition: number | undefined;
	if (value.queuePosition !== undefined) {
		if (typeof value.queuePosition !== 'number' || !Number.isFinite(value.queuePosition)) {
			return undefined;
		}
		queuePosition = value.queuePosition;
	}

	const logsValue = value.logs;
	if (!Array.isArray(logsValue) || logsValue.some((entry) => typeof entry !== 'string')) {
		return undefined;
	}

	let result: QueueJobSnapshot['result'];
	if (value.result !== undefined) {
		if (!isObjectRecord(value.result)) {
			return undefined;
		}

		const filename = value.result.filename;
		const originalSize = value.result.originalSize;
		const compressedSize = value.result.compressedSize;
		const ratio = value.result.ratio;
		const method = value.result.method;

		if (
			typeof filename !== 'string' ||
			typeof originalSize !== 'number' ||
			typeof compressedSize !== 'number' ||
			typeof ratio !== 'number' ||
			typeof method !== 'string'
		) {
			return undefined;
		}

		result = {
			filename,
			originalSize,
			compressedSize,
			ratio,
			method,
		};
	}

	let error: QueueJobSnapshot['error'];
	if (value.error !== undefined) {
		if (!isObjectRecord(value.error)) {
			return undefined;
		}

		const code = value.error.code;
		const message = value.error.message;
		if (typeof code !== 'string' || typeof message !== 'string') {
			return undefined;
		}

		error = { code, message };
	}

	return {
		requestId,
		status,
		queuePosition,
		logs: logsValue,
		result,
		error,
	};
}

function extractErrorMessage(body: unknown): string | undefined {
	if (!isObjectRecord(body)) {
		return undefined;
	}

	const errorValue = body.error;
	if (!isObjectRecord(errorValue)) {
		return undefined;
	}

	const message = errorValue.message;
	return typeof message === 'string' ? message : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

function resolveQueueUrl(urlOrPath: string, baseUrl: string): string {
	try {
		return new URL(urlOrPath, baseUrl).toString();
	} catch {
		const normalizedPath = urlOrPath.startsWith('/') ? urlOrPath : `/${urlOrPath}`;
		return `${baseUrl}${normalizedPath}`;
	}
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
	abort: () => void;
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
	let abortController: AbortController | undefined;
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
		if (state.files.length === 0) {
			resourcePool.clear();
		}
	}

	async function compressFile(queued: QueuedFile, signal?: AbortSignal) {
		updateFile(queued.id, { status: 'pending' });
		addLog(`-> ${queued.file.name} (${formatBytes(queued.file.size)})`, 'phase');

		try {
			const result = await compressWithQueueEndpoint(queued, signal);

			updateFile(queued.id, {
				status: 'done',
				result,
				error: null,
			});
			addLog(
				`OK ${queued.file.name}: ${formatBytes(result.originalSize)} -> ${formatBytes(
					result.compressedSize,
				)} (-${result.ratio}%, ${result.method})`,
				'success',
			);
		} catch (error) {
			const latest = state.files.find((file) => file.id === queued.id);
			if (!latest || latest.status === 'done') {
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

		const resourceIndex = new Map<string, File>();
		for (const resource of resourcePool.values()) {
			for (const key of collectResourceKeys(resource)) {
				if (!resourceIndex.has(key)) {
					resourceIndex.set(key, resource);
				}
			}
		}

		const attachedResources = new Set<string>();
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

	async function createQueuedJob(queued: QueuedFile, signal?: AbortSignal): Promise<QueueCreateJobResponse> {
		const form = await buildUploadForm(queued);

		let url = `${state.serverUrl}/jobs?preset=${state.selectedPreset}`;
		if (state.simplifyEnabled) {
			url += `&simplify=${state.simplifyRatio}`;
		}

		const response = await fetch(url, { method: 'POST', body: form, signal });
		if (!response.ok) {
			throw new Error(await readErrorMessage(response));
		}

		let parsedBody: unknown;
		try {
			parsedBody = await response.json();
		} catch {
			throw new Error('Invalid queue response');
		}

		const job = parseQueueCreateJobResponse(parsedBody);
		if (!job) {
			throw new Error('Invalid queue response');
		}

		return job;
	}

	async function pollJob(statusUrl: string, queued: QueuedFile, signal?: AbortSignal): Promise<QueueJobSnapshot> {
		let previousQueuePosition: number | undefined;
		let seenRunning = false;
		let processedLogCount = 0;
		const deadline = Date.now() + MAX_POLL_TIMEOUT_MS;

		for (;;) {
			if (Date.now() > deadline) {
				throw new Error(`Polling timed out after ${MAX_POLL_TIMEOUT_MS / 60_000} minutes`);
			}

			const response = await fetch(statusUrl, { signal });
			if (!response.ok) {
				throw new Error(await readErrorMessage(response));
			}

			let parsedBody: unknown;
			try {
				parsedBody = await response.json();
			} catch {
				throw new Error('Invalid job status response');
			}

			const snapshot = parseQueueJobSnapshot(parsedBody);
			if (!snapshot) {
				throw new Error('Invalid job status response');
			}

			if (snapshot.logs.length > processedLogCount) {
				for (const logLine of snapshot.logs.slice(processedLogCount)) {
					addLog(logLine);
				}
				processedLogCount = snapshot.logs.length;
			}

			if (snapshot.status === 'queued') {
				updateFile(queued.id, { status: 'pending' });
				if (snapshot.queuePosition !== previousQueuePosition) {
					addLog(
						snapshot.queuePosition !== undefined
							? `Queue: ${queued.file.name} is waiting (position ${snapshot.queuePosition})`
							: `Queue: ${queued.file.name} is waiting`,
						'info',
					);
					previousQueuePosition = snapshot.queuePosition;
				}
			} else if (snapshot.status === 'running') {
				updateFile(queued.id, { status: 'compressing' });
				if (!seenRunning) {
					addLog(`Running: ${queued.file.name}`, 'phase');
					seenRunning = true;
				}
			} else if (snapshot.status === 'done') {
				addLog(`Completed queue job: ${queued.file.name}`, 'info');
				return snapshot;
			} else {
				const message = snapshot.error?.message ?? 'Compression failed';
				addLog(`Queue job failed: ${queued.file.name} (${message})`, 'error');
				throw new Error(message);
			}

			await sleep(500, signal);
		}
	}

	async function downloadJobResult(
		requestId: string,
		resultUrl: string,
		queued: QueuedFile,
		snapshot: QueueJobSnapshot,
		signal?: AbortSignal,
	): Promise<CompressResult> {
		const response = await fetch(resultUrl, { signal });
		if (!response.ok) {
			throw new Error(await readErrorMessage(response));
		}

		const blob = await response.blob();

		const headerRequestId = response.headers.get('X-Request-ID');
		const originalSize =
			parseFiniteNumber(response.headers.get('X-Original-Size')) ?? snapshot.result?.originalSize ?? queued.file.size;
		const compressedSize =
			parseFiniteNumber(response.headers.get('X-Compressed-Size')) ?? snapshot.result?.compressedSize ?? blob.size;
		const method = response.headers.get('X-Compression-Method') ?? snapshot.result?.method ?? 'unknown';
		const ratio =
			parseFiniteNumber(response.headers.get('X-Compression-Ratio')) ??
			snapshot.result?.ratio ??
			toRatioPercent(originalSize, compressedSize);
		const filename =
			parseContentDispositionFilename(response.headers.get('content-disposition')) ??
			snapshot.result?.filename ??
			fallbackOutputFilename(queued.file.name);

		return {
			blob,
			requestId: headerRequestId ?? requestId,
			filename,
			originalSize,
			compressedSize,
			method,
			ratio,
		};
	}

	async function compressWithQueueEndpoint(queued: QueuedFile, signal?: AbortSignal): Promise<CompressResult> {
		const createdJob = await createQueuedJob(queued, signal);
		addLog(`Queued ${queued.file.name} (job ${createdJob.requestId})`, 'info');

		const statusUrl = resolveQueueUrl(createdJob.statusUrl, state.serverUrl);
		const resultUrl = resolveQueueUrl(createdJob.resultUrl, state.serverUrl);

		const snapshot = await pollJob(statusUrl, queued, signal);
		return downloadJobResult(createdJob.requestId, resultUrl, queued, snapshot, signal);
	}

	async function compressAll() {
		const pending = state.files.filter((file) => file.status === 'pending');
		if (pending.length === 0 || state.isCompressing) {
			return;
		}

		abortController = new AbortController();
		const { signal } = abortController;

		state.isCompressing = true;
		state.logs.length = 0;
		state.logOpen = true;

		addLog(
			`Starting batch: ${pending.length} file${pending.length === 1 ? '' : 's'}, preset=${state.selectedPreset}`,
			'phase',
		);

		for (const queued of pending) {
			if (signal.aborted) {
				break;
			}
			await compressFile(queued, signal);
		}

		abortController = undefined;
		state.isCompressing = false;

		const doneCount = state.files.filter((file) => file.status === 'done').length;
		const errorCount = state.files.filter((file) => file.status === 'error').length;

		if (errorCount > 0) {
			addLog(`Finished: ${doneCount} compressed, ${errorCount} failed`, 'error');
		} else {
			addLog(`All ${doneCount} file${doneCount === 1 ? '' : 's'} compressed successfully`, 'success');
		}
	}

	function abort() {
		if (abortController) {
			abortController.abort(new DOMException('Compression cancelled', 'AbortError'));
			abortController = undefined;
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
		abort,
		handleServerUrlChange,
		restoreServerUrl,
		startHealthPolling,
	};
}
