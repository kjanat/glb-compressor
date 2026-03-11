import type { CompressPreset } from '@glb-compressor/core';
import { compress, ErrorCode, formatBytes } from '@glb-compressor/core';
import type { WorkerCompressRequest, WorkerRequestMessage, WorkerResponseMessage } from './job-protocol';
import { COMPRESSED_FILENAME_PATTERN, COMPRESSED_FILENAME_SUFFIX } from './job-types';

declare var self: Worker;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCompressPreset(value: unknown): value is CompressPreset {
	return value === 'default' || value === 'balanced' || value === 'aggressive' || value === 'max';
}

function isResourceMap(value: unknown): value is Record<string, Uint8Array> {
	if (!isObjectRecord(value)) {
		return false;
	}

	for (const item of Object.values(value)) {
		if (!(item instanceof Uint8Array)) {
			return false;
		}
	}

	return true;
}

function parseWorkerRequest(value: unknown): WorkerRequestMessage | undefined {
	if (!isObjectRecord(value)) {
		return undefined;
	}

	if (
		value.type !== 'compress' ||
		typeof value.requestId !== 'string' ||
		typeof value.filename !== 'string' ||
		!(value.input instanceof Uint8Array) ||
		!isCompressPreset(value.preset)
	) {
		return undefined;
	}

	const simplifyRatio =
		typeof value.simplifyRatio === 'number'
			? value.simplifyRatio
			: value.simplifyRatio === undefined
				? undefined
				: null;
	if (simplifyRatio === null) {
		return undefined;
	}

	const resources = value.resources === undefined ? undefined : isResourceMap(value.resources) ? value.resources : null;
	if (resources === null) {
		return undefined;
	}

	const message: WorkerCompressRequest = {
		type: 'compress',
		requestId: value.requestId,
		filename: value.filename,
		input: value.input,
		preset: value.preset,
		simplifyRatio,
		resources,
	};

	return message;
}

function send(message: WorkerResponseMessage) {
	postMessage(message);
}

self.onmessage = async (event: MessageEvent<unknown>) => {
	const message = parseWorkerRequest(event.data);
	if (!message) {
		return;
	}

	const { requestId, filename, input, preset, simplifyRatio, resources } = message;

	send({
		type: 'log',
		requestId,
		message: `[${requestId}] Received ${filename}: ${formatBytes(input.byteLength)} (preset: ${preset})`,
	});

	try {
		const { buffer, method } = await compress(input, {
			simplifyRatio,
			preset,
			resources,
			onLog: (logMessage) => send({ type: 'log', requestId, message: logMessage }),
		});

		const ratio = input.byteLength > 0 ? Number(((1 - buffer.byteLength / input.byteLength) * 100).toFixed(1)) : 0;
		send({
			type: 'log',
			requestId,
			message: `Done: ${formatBytes(input.byteLength)} -> ${formatBytes(buffer.byteLength)} (${ratio}% reduction)`,
		});

		send({
			type: 'result',
			requestId,
			filename: filename.replace(COMPRESSED_FILENAME_PATTERN, COMPRESSED_FILENAME_SUFFIX),
			buffer,
			originalSize: input.byteLength,
			compressedSize: buffer.byteLength,
			ratio,
			method,
		});
	} catch (error) {
		send({
			type: 'error',
			requestId,
			code: ErrorCode.COMPRESSION_FAILED,
			message: error instanceof Error ? error.message : 'Compression failed',
		});
	}
};
