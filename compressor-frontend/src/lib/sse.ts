import type { CompressionErrorEvent, CompressionLogEvent, CompressionResultEvent } from '@glb-compressor/shared-types';

export type StreamLogEvent = CompressionLogEvent;
export type StreamErrorEvent = CompressionErrorEvent;

export interface ParseHandlers {
	onLog?: (event: StreamLogEvent) => void;
	onResult?: (event: CompressionResultEvent) => void;
	onError?: (event: StreamErrorEvent) => void;
}

function readFieldValue(line: string): string {
	const separator = line.indexOf(':');
	if (separator < 0) {
		return '';
	}

	const value = line.slice(separator + 1);
	return value.startsWith(' ') ? value.slice(1) : value;
}

function findEventBoundary(buffer: string): { index: number; length: number } | undefined {
	const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
	if (!match || match.index < 0) {
		return undefined;
	}

	return { index: match.index, length: match[0].length };
}

function handleRawEvent(raw: string, handlers: ParseHandlers): void {
	if (!raw.trim()) {
		return;
	}

	let type = '';
	const dataLines: string[] = [];

	for (const line of raw.split(/\r\n|\n|\r/)) {
		if (!line || line.startsWith(':')) {
			continue;
		}

		if (line.startsWith('event:')) {
			type = readFieldValue(line);
			continue;
		}

		if (line.startsWith('data:')) {
			dataLines.push(readFieldValue(line));
		}
	}

	if (!type || dataLines.length === 0) {
		return;
	}

	const data = dataLines.join('\n');
	if (!data) {
		return;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		console.warn('Malformed SSE JSON');
		return;
	}

	if (type === 'log' && isLogEvent(parsed)) {
		handlers.onLog?.(parsed);
	} else if (type === 'result') {
		const result = toCompressResult(parsed);
		if (result) {
			handlers.onResult?.(result);
		}
	} else if (type === 'error' && isErrorEvent(parsed)) {
		handlers.onError?.(parsed);
	}
}

function isLogEvent(value: unknown): value is StreamLogEvent {
	return typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string';
}

function parseRatio(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

function toCompressResult(value: unknown): CompressionResultEvent | undefined {
	if (typeof value !== 'object' || value === null) return undefined;

	if (
		!('requestId' in value) ||
		typeof value.requestId !== 'string' ||
		!('filename' in value) ||
		typeof value.filename !== 'string' ||
		!('data' in value) ||
		typeof value.data !== 'string' ||
		!('originalSize' in value) ||
		typeof value.originalSize !== 'number' ||
		!('compressedSize' in value) ||
		typeof value.compressedSize !== 'number' ||
		!('method' in value) ||
		typeof value.method !== 'string' ||
		!('ratio' in value)
	) {
		return undefined;
	}

	const ratio = parseRatio(value.ratio);
	if (ratio === undefined) {
		return undefined;
	}

	return {
		filename: value.filename,
		data: value.data,
		requestId: value.requestId,
		originalSize: value.originalSize,
		compressedSize: value.compressedSize,
		ratio,
		method: value.method,
	} satisfies CompressionResultEvent;
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
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });

			for (;;) {
				const boundary = findEventBoundary(buffer);
				if (!boundary) {
					break;
				}

				const raw = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary.length);
				handleRawEvent(raw, handlers);
			}
		}

		buffer += decoder.decode();

		for (;;) {
			const boundary = findEventBoundary(buffer);
			if (!boundary) {
				break;
			}

			const raw = buffer.slice(0, boundary.index);
			buffer = buffer.slice(boundary.index + boundary.length);
			handleRawEvent(raw, handlers);
		}

		handleRawEvent(buffer, handlers);
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
