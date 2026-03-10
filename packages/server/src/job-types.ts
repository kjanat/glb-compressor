import type { CompressPreset } from '@glb-compressor/core';

export type CompressionJobStatus = 'queued' | 'running' | 'done' | 'error';

export interface JobSubmission {
	requestId: string;
	input: Uint8Array;
	filename: string;
	preset: CompressPreset;
	simplifyRatio: number | undefined;
	resources: Record<string, Uint8Array> | undefined;
}

export interface JobResult {
	filename: string;
	buffer: Uint8Array;
	originalSize: number;
	compressedSize: number;
	ratio: number;
	method: string;
}

export interface JobResultSummary {
	filename: string;
	originalSize: number;
	compressedSize: number;
	ratio: number;
	method: string;
}

export interface JobError {
	code: string;
	message: string;
}

export interface JobSnapshot {
	requestId: string;
	filename: string;
	preset: CompressPreset;
	simplifyRatio: number | undefined;
	status: CompressionJobStatus;
	queuePosition: number | undefined;
	createdAt: string;
	updatedAt: string;
	startedAt: string | undefined;
	finishedAt: string | undefined;
	logs: string[];
	result: JobResultSummary | undefined;
	error: JobError | undefined;
}

export type JobEvent =
	| { type: 'log'; message: string }
	| { type: 'result'; result: JobResultSummary }
	| { type: 'error'; error: JobError };

export interface JobRecord {
	requestId: string;
	filename: string;
	preset: CompressPreset;
	simplifyRatio: number | undefined;
	input: Uint8Array;
	resources: Record<string, Uint8Array> | undefined;
	status: CompressionJobStatus;
	createdAtMs: number;
	updatedAtMs: number;
	startedAtMs: number | undefined;
	finishedAtMs: number | undefined;
	logs: string[];
	result: JobResult | undefined;
	error: JobError | undefined;
	listeners: Set<(event: JobEvent) => void>;
	completion: Promise<JobResult>;
	resolveCompletion: (value: JobResult) => void;
	rejectCompletion: (reason: Error) => void;
}

export function summarizeResult(result: JobResult): JobResultSummary {
	return {
		filename: result.filename,
		originalSize: result.originalSize,
		compressedSize: result.compressedSize,
		ratio: result.ratio,
		method: result.method,
	};
}

export function toIso(timestampMs: number | undefined): string | undefined {
	if (timestampMs === undefined) {
		return undefined;
	}
	return new Date(timestampMs).toISOString();
}

export function createJobRecord(submission: JobSubmission): JobRecord {
	let resolveCompletion: ((value: JobResult) => void) | undefined;
	let rejectCompletion: ((reason: Error) => void) | undefined;

	const completion = new Promise<JobResult>((resolve, reject) => {
		resolveCompletion = resolve;
		rejectCompletion = reject;
	});

	if (resolveCompletion === undefined || rejectCompletion === undefined) {
		throw new Error('Failed to initialize job completion handlers');
	}

	const now = Date.now();

	return {
		requestId: submission.requestId,
		filename: submission.filename,
		preset: submission.preset,
		simplifyRatio: submission.simplifyRatio,
		input: submission.input,
		resources: submission.resources,
		status: 'queued',
		createdAtMs: now,
		updatedAtMs: now,
		startedAtMs: undefined,
		finishedAtMs: undefined,
		logs: [],
		result: undefined,
		error: undefined,
		listeners: new Set(),
		completion,
		resolveCompletion,
		rejectCompletion,
	};
}
