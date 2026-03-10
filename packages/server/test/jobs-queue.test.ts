import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

interface ApiErrorResponse {
	error: {
		code: string;
		message: string;
	};
	requestId: string;
}

interface JobCreateResponse {
	requestId: string;
	statusUrl: string;
	resultUrl: string;
}

type JobStatus = 'queued' | 'running' | 'done' | 'error';

interface JobStatusResponse {
	status: JobStatus;
	errorCode: string | undefined;
	errorMessage: string | undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isJobStatus(value: string): value is JobStatus {
	return value === 'queued' || value === 'running' || value === 'done' || value === 'error';
}

function readStringField(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	if (typeof value !== 'string') {
		throw new Error(`Expected string field: ${field}`);
	}
	return value;
}

function parseApiError(value: unknown): ApiErrorResponse {
	if (!isObjectRecord(value)) {
		throw new Error('Expected API error object');
	}

	const errorValue = value.error;
	if (!isObjectRecord(errorValue)) {
		throw new Error('Expected nested error object');
	}

	return {
		error: {
			code: readStringField(errorValue, 'code'),
			message: readStringField(errorValue, 'message'),
		},
		requestId: readStringField(value, 'requestId'),
	};
}

function parseJobCreate(value: unknown): JobCreateResponse {
	if (!isObjectRecord(value)) {
		throw new Error('Expected job create object');
	}

	return {
		requestId: readStringField(value, 'requestId'),
		statusUrl: readStringField(value, 'statusUrl'),
		resultUrl: readStringField(value, 'resultUrl'),
	};
}

function parseJobStatus(value: unknown): JobStatusResponse {
	if (!isObjectRecord(value)) {
		throw new Error('Expected job status object');
	}

	const rawStatus = readStringField(value, 'status');
	if (!isJobStatus(rawStatus)) {
		throw new Error(`Unexpected job status: ${rawStatus}`);
	}

	let errorCode: string | undefined;
	let errorMessage: string | undefined;

	const errorValue = value.error;
	if (errorValue !== undefined) {
		if (!isObjectRecord(errorValue)) {
			throw new Error('Expected error object');
		}
		errorCode = readStringField(errorValue, 'code');
		errorMessage = readStringField(errorValue, 'message');
	}

	return {
		status: rawStatus,
		errorCode,
		errorMessage,
	};
}

async function getFreePort(): Promise<number> {
	const probe = Bun.serve({
		port: 0,
		fetch: () => new Response('ok'),
	});

	const port = Number(new URL(probe.url).port);
	probe.stop(true);

	if (!Number.isInteger(port) || port <= 0) {
		throw new Error('Failed to resolve free port');
	}

	return port;
}

async function waitForHealth(baseUrl: string): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) {
				return;
			}
		} catch {
			// keep retrying
		}
		await Bun.sleep(50);
	}

	throw new Error('Server did not become healthy in time');
}

const FIXTURES_DIR = resolve(import.meta.dir, 'fixtures');

let baseUrl = '';
let stopServer: (() => void) | undefined;

function createFixtureForm(filename: string): FormData {
	const form = new FormData();
	form.append('file', Bun.file(resolve(FIXTURES_DIR, filename)), filename);
	return form;
}

async function createJob(filename: string): Promise<JobCreateResponse> {
	const response = await fetch(`${baseUrl}/jobs?preset=default`, {
		method: 'POST',
		body: createFixtureForm(filename),
	});
	expect(response.status).toBe(202);

	const payload: unknown = await response.json();
	return parseJobCreate(payload);
}

async function waitForTerminalStatus(statusUrl: string, timeoutMs = 20_000): Promise<JobStatusResponse> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const health = await fetch(`${baseUrl}/healthz`);
		if (!health.ok) {
			throw new Error(`Health endpoint failed during polling: ${health.status}`);
		}

		const response = await fetch(`${baseUrl}${statusUrl}`);
		expect(response.status).toBe(200);
		const payload: unknown = await response.json();
		const status = parseJobStatus(payload);
		if (status.status === 'done' || status.status === 'error') {
			return status;
		}

		await Bun.sleep(100);
	}

	throw new Error(`Timed out waiting for terminal status: ${statusUrl}`);
}

describe('jobs queue error handling', () => {
	beforeAll(async () => {
		const port = await getFreePort();
		process.env.PORT = String(port);
		const { startServer } = await import('../src/main.ts');
		const server = startServer();

		baseUrl = `http://127.0.0.1:${port}`;
		stopServer = () => {
			server.stop(true);
		};

		await waitForHealth(baseUrl);
	});

	afterAll(() => {
		if (stopServer) {
			stopServer();
		}
	});

	test('returns INVALID_GLB for malformed .glb uploads', async () => {
		const response = await fetch(`${baseUrl}/jobs?preset=default`, {
			method: 'POST',
			body: createFixtureForm('invalid.glb'),
		});

		expect(response.status).toBe(400);
		const payload: unknown = await response.json();
		const error = parseApiError(payload);
		expect(error.error.code).toBe('INVALID_GLB');
		expect(error.error.message.length).toBeGreaterThan(0);
	});

	test('continues queue processing after invalid .gltf failure between valid jobs', async () => {
		const first = await createJob('valid-minimal.gltf');
		const middle = await createJob('invalid.gltf');
		const last = await createJob('valid-minimal.gltf');

		const firstStatus = await waitForTerminalStatus(first.statusUrl);
		expect(firstStatus.status).toBe('done');

		const middleStatus = await waitForTerminalStatus(middle.statusUrl);
		expect(middleStatus.status).toBe('error');
		expect(middleStatus.errorCode).toBe('COMPRESSION_FAILED');
		expect(middleStatus.errorMessage).toBeDefined();

		const lastStatus = await waitForTerminalStatus(last.statusUrl);
		expect(lastStatus.status).toBe('done');

		const firstResult = await fetch(`${baseUrl}${first.resultUrl}`);
		expect(firstResult.status).toBe(200);
		const firstType = firstResult.headers.get('content-type') ?? '';
		expect(firstType).toContain('model/gltf-binary');
		expect((await firstResult.arrayBuffer()).byteLength).toBeGreaterThan(0);

		const middleResult = await fetch(`${baseUrl}${middle.resultUrl}`);
		expect(middleResult.status).toBe(500);
		const middlePayload: unknown = await middleResult.json();
		const middleError = parseApiError(middlePayload);
		expect(middleError.error.code).toBe('COMPRESSION_FAILED');

		const lastResult = await fetch(`${baseUrl}${last.resultUrl}`);
		expect(lastResult.status).toBe(200);
		expect((await lastResult.arrayBuffer()).byteLength).toBeGreaterThan(0);
	});
});
