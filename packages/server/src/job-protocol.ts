import type { CompressPreset } from '@glb-compressor/core';

interface WorkerCompressRequest {
	type: 'compress';
	requestId: string;
	filename: string;
	input: Uint8Array;
	preset: CompressPreset;
	simplifyRatio: number | undefined;
	resources: Record<string, Uint8Array> | undefined;
}

type WorkerRequestMessage = WorkerCompressRequest;

interface WorkerBaseMessage {
	requestId: string;
}

interface WorkerLogMessage extends WorkerBaseMessage {
	type: 'log';
	message: string;
}

interface WorkerResultMessage extends WorkerBaseMessage {
	type: 'result';
	filename: string;
	buffer: Uint8Array;
	originalSize: number;
	compressedSize: number;
	ratio: number;
	method: string;
}

interface WorkerErrorMessage extends WorkerBaseMessage {
	type: 'error';
	code: string;
	message: string;
}

type WorkerResponseMessage = WorkerLogMessage | WorkerResultMessage | WorkerErrorMessage;

export type {
	WorkerCompressRequest,
	WorkerErrorMessage,
	WorkerLogMessage,
	WorkerRequestMessage,
	WorkerResponseMessage,
	WorkerResultMessage,
};
