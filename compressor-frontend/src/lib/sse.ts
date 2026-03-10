import type { CompressResult } from './types';

export interface StreamLogEvent {
	message: string;
}

export interface StreamErrorEvent {
	message?: string;
}

export interface ParseHandlers {
	onLog?: (event: StreamLogEvent) => void;
	onResult?: (event: CompressResult) => void;
	onError?: (event: StreamErrorEvent) => void;
}

function isLogEvent(value: unknown): value is StreamLogEvent {
	return typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string';
}

function isCompressResult(value: unknown): value is CompressResult {
	return (
		typeof value === 'object' &&
		value !== null &&
		'filename' in value &&
		typeof value.filename === 'string' &&
		'data' in value &&
		typeof value.data === 'string' &&
		'originalSize' in value &&
		typeof value.originalSize === 'number' &&
		'compressedSize' in value &&
		typeof value.compressedSize === 'number' &&
		'ratio' in value &&
		typeof value.ratio === 'number' &&
		'method' in value &&
		typeof value.method === 'string'
	);
}

function isErrorEvent(value: unknown): value is StreamErrorEvent {
	if (typeof value !== 'object' || value === null) return false;
	if ('message' in value && typeof value.message !== 'string') return false;
	return true;
}

/**
 * Parse an SSE stream from a `fetch` response body.
 * Handles `log`, `result`, and `error` event types.
 */
export async function parseSSE(response: Response, handlers: ParseHandlers): Promise<void> {
	if (!response.body) throw new Error('Missing response stream');

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split('\n\n');
			buffer = parts.pop() ?? '';

			for (const raw of parts) {
				if (!raw.trim()) continue;

				let type = '';
				let data = '';

				for (const line of raw.split('\n')) {
					if (line.startsWith('event: ')) type = line.slice(7);
					if (line.startsWith('data: ')) data += line.slice(6);
				}

				if (!type || !data) continue;

				try {
					const parsed: unknown = JSON.parse(data);

					if (type === 'log' && isLogEvent(parsed)) {
						handlers.onLog?.(parsed);
					} else if (type === 'result' && isCompressResult(parsed)) {
						handlers.onResult?.(parsed);
					} else if (type === 'error' && isErrorEvent(parsed)) {
						handlers.onError?.(parsed);
					}
				} catch {
					console.warn('Malformed SSE JSON');
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Safely extract an error message from a JSON response body
 * shaped like `{ error: { message: string } }`.
 */
export function extractErrorMessage(body: unknown): string | undefined {
	if (typeof body !== 'object' || body === null) return undefined;
	if (!('error' in body)) return undefined;
	const errorField: unknown = body.error;
	if (typeof errorField !== 'object' || errorField === null) return undefined;
	if (!('message' in errorField)) return undefined;
	return typeof errorField.message === 'string' ? errorField.message : undefined;
}
