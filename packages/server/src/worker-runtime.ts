import type { WorkerResponseMessage } from './job-protocol';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export function parseWorkerResponse(value: unknown): WorkerResponseMessage | undefined {
	if (!isObjectRecord(value) || typeof value.type !== 'string' || typeof value.requestId !== 'string') {
		return undefined;
	}

	if (value.type === 'log') {
		if (typeof value.message !== 'string') {
			return undefined;
		}

		return {
			type: 'log',
			requestId: value.requestId,
			message: value.message,
		};
	}

	if (value.type === 'result') {
		if (
			typeof value.filename !== 'string' ||
			!(value.buffer instanceof Uint8Array) ||
			typeof value.originalSize !== 'number' ||
			typeof value.compressedSize !== 'number' ||
			typeof value.ratio !== 'number' ||
			typeof value.method !== 'string'
		) {
			return undefined;
		}

		return {
			type: 'result',
			requestId: value.requestId,
			filename: value.filename,
			buffer: value.buffer,
			originalSize: value.originalSize,
			compressedSize: value.compressedSize,
			ratio: value.ratio,
			method: value.method,
		};
	}

	if (value.type === 'error') {
		if (typeof value.code !== 'string' || typeof value.message !== 'string') {
			return undefined;
		}

		return {
			type: 'error',
			requestId: value.requestId,
			code: value.code,
			message: value.message,
		};
	}

	return undefined;
}

export function resolveWorkerSpecifier(currentModuleUrl: string): string {
	const pathname = new URL(currentModuleUrl).pathname;
	if (pathname.endsWith('.ts')) {
		return new URL('./worker.ts', currentModuleUrl).href;
	}
	if (pathname.endsWith('.cjs')) {
		return new URL('./worker.cjs', currentModuleUrl).href;
	}
	return new URL('./worker.js', currentModuleUrl).href;
}
