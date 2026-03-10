import type { CompressPreset } from '@glb-compressor/core';

export interface WorkerCompressRequest {
	type: 'compress';
	requestId: string;
	filename: string;
	input: Uint8Array;
	preset: CompressPreset;
	simplifyRatio: number | undefined;
	resources: Record<string, Uint8Array> | undefined;
}

export type WorkerRequestMessage = WorkerCompressRequest;

interface WorkerBaseMessage {
	requestId: string;
}

export interface WorkerLogMessage extends WorkerBaseMessage {
	type: 'log';
	message: string;
}

export interface WorkerResultMessage extends WorkerBaseMessage {
	type: 'result';
	filename: string;
	buffer: Uint8Array;
	originalSize: number;
	compressedSize: number;
	ratio: number;
	method: string;
}

export interface WorkerErrorMessage extends WorkerBaseMessage {
	type: 'error';
	code: string;
	message: string;
}

export type WorkerResponseMessage = WorkerLogMessage | WorkerResultMessage | WorkerErrorMessage;
