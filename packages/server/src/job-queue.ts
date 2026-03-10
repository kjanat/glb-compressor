import { compress, ErrorCode } from '@glb-compressor/core';
import type { WorkerCompressRequest } from './job-protocol';
import {
	createJobRecord,
	type JobEvent,
	type JobRecord,
	type JobResult,
	type JobSnapshot,
	type JobSubmission,
	summarizeResult,
	toIso,
} from './job-types';
import { parseWorkerResponse, resolveWorkerSpecifier } from './worker-runtime';

const JOB_RETENTION_MS = 10 * 60_000;
const MAX_LOG_ENTRIES = 200;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function getEventMessage(event: unknown): string | undefined {
	if (!isObjectRecord(event)) {
		return undefined;
	}

	const message = event.message;
	return typeof message === 'string' && message.length > 0 ? message : undefined;
}

export type {
	CompressionJobStatus,
	JobError,
	JobEvent,
	JobResult,
	JobResultSummary,
	JobSnapshot,
	JobSubmission,
} from './job-types';

export class CompressionJobQueue {
	private readonly jobs = new Map<string, JobRecord>();
	private readonly pendingJobIds: string[] = [];
	private activeJobId: string | undefined;
	private worker: Worker | undefined;

	constructor() {
		this.worker = this.createWorker();
	}

	submit(submission: JobSubmission): string {
		this.prune();

		if (this.jobs.has(submission.requestId)) {
			throw new Error(`Duplicate job id: ${submission.requestId}`);
		}

		const job = createJobRecord(submission);
		this.jobs.set(job.requestId, job);
		this.pendingJobIds.push(job.requestId);
		this.dispatchNext();
		return job.requestId;
	}

	waitForCompletion(requestId: string): Promise<JobResult> {
		const job = this.jobs.get(requestId);
		if (!job) {
			return Promise.reject(new Error(`Job not found: ${requestId}`));
		}
		return job.completion;
	}

	getSnapshot(requestId: string): JobSnapshot | undefined {
		this.prune();
		const job = this.jobs.get(requestId);
		if (!job) {
			return undefined;
		}

		let queuePosition: number | undefined;
		if (job.status === 'queued') {
			const queueIndex = this.pendingJobIds.indexOf(job.requestId);
			queuePosition = queueIndex >= 0 ? queueIndex + 1 : undefined;
		}

		return {
			requestId: job.requestId,
			filename: job.filename,
			preset: job.preset,
			simplifyRatio: job.simplifyRatio,
			status: job.status,
			queuePosition,
			createdAt: toIso(job.createdAtMs) ?? new Date(job.createdAtMs).toISOString(),
			updatedAt: toIso(job.updatedAtMs) ?? new Date(job.updatedAtMs).toISOString(),
			startedAt: toIso(job.startedAtMs),
			finishedAt: toIso(job.finishedAtMs),
			logs: [...job.logs],
			result: job.result === undefined ? undefined : summarizeResult(job.result),
			error: job.error,
		};
	}

	getResult(requestId: string): JobResult | undefined {
		this.prune();
		const job = this.jobs.get(requestId);
		if (!job || job.result === undefined) {
			return undefined;
		}

		return job.result;
	}

	subscribe(requestId: string, listener: (event: JobEvent) => void): () => void {
		const job = this.jobs.get(requestId);
		if (!job) {
			return () => {};
		}

		for (const message of job.logs) {
			listener({ type: 'log', message });
		}

		if (job.result !== undefined) {
			listener({ type: 'result', result: summarizeResult(job.result) });
			return () => {};
		}

		if (job.error !== undefined) {
			listener({ type: 'error', error: job.error });
			return () => {};
		}

		job.listeners.add(listener);
		return () => {
			job.listeners.delete(listener);
		};
	}

	private createWorker(): Worker | undefined {
		if (typeof Worker === 'undefined' || typeof Bun === 'undefined') {
			return undefined;
		}

		try {
			const worker = new Worker(resolveWorkerSpecifier(import.meta.url));
			worker.addEventListener('message', (event: MessageEvent<unknown>) => {
				this.handleWorkerMessage(event.data);
			});
			worker.addEventListener('error', (event: Event) => {
				this.failActiveJob(ErrorCode.COMPRESSION_FAILED, getEventMessage(event) ?? 'Worker thread crashed');
				this.worker = this.createWorker();
			});
			return worker;
		} catch (error) {
			console.warn('Worker initialization failed, falling back to main-thread compression.', error);
			return undefined;
		}
	}

	private dispatchNext() {
		if (this.activeJobId !== undefined) {
			return;
		}

		const nextId = this.pendingJobIds.shift();
		if (nextId === undefined) {
			return;
		}

		const job = this.jobs.get(nextId);
		if (!job) {
			this.dispatchNext();
			return;
		}

		this.activeJobId = job.requestId;
		job.status = 'running';
		job.startedAtMs = Date.now();
		job.updatedAtMs = job.startedAtMs;

		if (this.worker) {
			const message: WorkerCompressRequest = {
				type: 'compress',
				requestId: job.requestId,
				filename: job.filename,
				input: job.input,
				preset: job.preset,
				simplifyRatio: job.simplifyRatio,
				resources: job.resources,
			};
			this.worker.postMessage(message);
			return;
		}

		void this.runInline(job);
	}

	private async runInline(job: JobRecord) {
		try {
			this.pushLog(job, `[${job.requestId}] Received ${job.filename} (preset: ${job.preset})`);
			const { buffer, method } = await compress(job.input, {
				simplifyRatio: job.simplifyRatio,
				preset: job.preset,
				resources: job.resources,
				onLog: (message) => this.pushLog(job, message),
			});

			const ratio = Number(((1 - buffer.byteLength / job.input.byteLength) * 100).toFixed(1));
			this.completeWithResult(job, {
				filename: job.filename.replace(/\.(glb|gltf)$/i, '-compressed.glb'),
				buffer,
				originalSize: job.input.byteLength,
				compressedSize: buffer.byteLength,
				ratio,
				method,
			});
		} catch (error) {
			this.completeWithError(
				job,
				ErrorCode.COMPRESSION_FAILED,
				error instanceof Error ? error.message : 'Compression failed',
			);
		}
	}

	private handleWorkerMessage(payload: unknown) {
		const message = parseWorkerResponse(payload);
		if (!message) {
			return;
		}

		const job = this.jobs.get(message.requestId);
		if (!job) {
			return;
		}

		if (message.type === 'log') {
			this.pushLog(job, message.message);
			return;
		}

		if (message.type === 'result') {
			this.completeWithResult(job, {
				filename: message.filename,
				buffer: message.buffer,
				originalSize: message.originalSize,
				compressedSize: message.compressedSize,
				ratio: message.ratio,
				method: message.method,
			});
			return;
		}

		this.completeWithError(job, message.code, message.message);
	}

	private pushLog(job: JobRecord, message: string) {
		job.logs.push(message);
		if (job.logs.length > MAX_LOG_ENTRIES) {
			job.logs.shift();
		}
		job.updatedAtMs = Date.now();
		this.notify(job, { type: 'log', message });
	}

	private completeWithResult(job: JobRecord, result: JobResult) {
		job.status = 'done';
		job.result = result;
		job.error = undefined;
		job.finishedAtMs = Date.now();
		job.updatedAtMs = job.finishedAtMs;

		this.notify(job, { type: 'result', result: summarizeResult(result) });
		job.resolveCompletion(result);
		this.finishActiveJob(job.requestId);
	}

	private completeWithError(job: JobRecord, code: string, message: string) {
		job.status = 'error';
		job.result = undefined;
		job.error = { code, message };
		job.finishedAtMs = Date.now();
		job.updatedAtMs = job.finishedAtMs;

		this.notify(job, { type: 'error', error: job.error });
		job.rejectCompletion(new Error(message));
		this.finishActiveJob(job.requestId);
	}

	private finishActiveJob(requestId: string) {
		if (this.activeJobId === requestId) {
			this.activeJobId = undefined;
		}
		this.dispatchNext();
	}

	private failActiveJob(code: string, message: string) {
		if (this.activeJobId === undefined) {
			return;
		}

		const job = this.jobs.get(this.activeJobId);
		if (!job) {
			this.activeJobId = undefined;
			return;
		}

		this.completeWithError(job, code, message);
	}

	private notify(job: JobRecord, event: JobEvent) {
		for (const listener of job.listeners) {
			listener(event);
		}

		if (event.type === 'result' || event.type === 'error') {
			job.listeners.clear();
		}
	}

	private prune(now = Date.now()) {
		for (const [requestId, job] of this.jobs.entries()) {
			if (job.finishedAtMs === undefined) {
				continue;
			}

			if (now - job.finishedAtMs <= JOB_RETENTION_MS) {
				continue;
			}

			this.jobs.delete(requestId);
		}
	}
}
