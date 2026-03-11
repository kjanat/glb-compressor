#!/usr/bin/env bun

import { DEFAULT_PORT, ErrorCode, formatBytes } from '@glb-compressor/core';
import type { CompressionStreamEventMap } from '@glb-compressor/shared-types';
import { join, resolve } from 'node:path';
import { CORS_HEADERS, jsonError, parseCompressRequest } from './http';
import { CompressionJobQueue } from './job-queue';
import type { JobResult } from './job-queue';
import { resolveTls } from './tls';

const PORT = parseInt(process.env.PORT || String(DEFAULT_PORT), 10);

// Static frontend serving — resolved once at startup
const FRONTEND_DIR = resolve(process.env.FRONTEND_DIR ?? join(process.cwd(), 'dist', 'frontend'));
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

const jobQueue = new CompressionJobQueue();

function contentDisposition(filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7E]/g, '_');
	const encoded = encodeURIComponent(filename);
	if (ascii === filename) {
		return `attachment; filename="${filename}"`;
	}
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

interface JobRoute {
	requestId: string;
	kind: 'status' | 'result';
}

function parseJobRoute(pathname: string): JobRoute | undefined {
	if (!pathname.startsWith('/jobs/')) {
		return undefined;
	}

	const suffix = pathname.slice('/jobs/'.length);
	if (suffix.length === 0) {
		return undefined;
	}

	const parts = suffix.split('/');
	const [rawRequestId] = parts;
	if (rawRequestId === undefined || rawRequestId.length === 0) {
		return undefined;
	}

	let requestId: string;
	try {
		requestId = decodeURIComponent(rawRequestId);
	} catch {
		return undefined;
	}

	if (parts.length === 1) {
		return { requestId, kind: 'status' };
	}

	if (parts.length === 2 && parts[1] === 'result') {
		return { requestId, kind: 'result' };
	}

	return undefined;
}

function handleOptions(): Response {
	return new Response(null, {
		status: 204,
		headers: CORS_HEADERS,
	});
}

async function handleCompress(req: globalThis.Request): Promise<Response> {
	const requestId = crypto.randomUUID();

	const parsed = await parseCompressRequest(req, requestId, false);
	if (parsed instanceof Response) {
		return parsed;
	}

	const { input, filename, preset, simplifyRatio, resources } = parsed;

	console.log(`[${requestId}] Enqueue ${filename}: ${formatBytes(input.byteLength)} (preset: ${preset})`);

	jobQueue.submit({
		requestId,
		input,
		filename,
		preset,
		simplifyRatio,
		resources,
	});

	let result: JobResult;
	try {
		result = await jobQueue.waitForCompletion(requestId);
	} catch (error) {
		console.error(`[${requestId}] Compression failed:`, error);
		return jsonError(
			ErrorCode.COMPRESSION_FAILED,
			error instanceof Error ? error.message : 'Compression failed',
			500,
			requestId,
		);
	}

	console.log(
		`[${requestId}] ${formatBytes(result.originalSize)} -> ${formatBytes(
			result.compressedSize,
		)} (${result.ratio}% reduction, ${result.method})`,
	);

	return new Response(result.buffer, {
		headers: {
			...CORS_HEADERS,
			'Content-Type': 'model/gltf-binary',
			'Content-Disposition': contentDisposition(result.filename),
			'Content-Length': String(result.buffer.byteLength),
			'X-Request-ID': requestId,
			'X-Original-Size': String(result.originalSize),
			'X-Compressed-Size': String(result.compressedSize),
			'X-Compression-Method': result.method,
			'X-Compression-Ratio': String(result.ratio),
		},
	});
}

async function handleCompressStream(req: globalThis.Request): Promise<Response> {
	const requestId = crypto.randomUUID();

	const parsed = await parseCompressRequest(req, requestId, true);
	if (parsed instanceof Response) {
		return parsed;
	}

	const { input, filename, preset, simplifyRatio, resources } = parsed;

	jobQueue.submit({
		requestId,
		input,
		filename,
		preset,
		simplifyRatio,
		resources,
	});

	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	function cleanup() {
		if (heartbeat !== undefined) {
			clearInterval(heartbeat);
			heartbeat = undefined;
		}
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = undefined;
		}
	}

	const stream = new ReadableStream({
		start(controller) {
			heartbeat = setInterval(() => {
				controller.enqueue(encoder.encode(':keepalive\n\n'));
			}, 15_000);

			const send = <EventName extends keyof CompressionStreamEventMap>(
				event: EventName,
				data: CompressionStreamEventMap[EventName],
			) => {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			unsubscribe = jobQueue.subscribe(requestId, (event) => {
				if (event.type === 'log') {
					send('log', { message: event.message });
					return;
				}

				if (event.type === 'error') {
					send('error', {
						message: event.error.message,
						requestId,
						code: event.error.code,
					});
					cleanup();
					controller.close();
					return;
				}

				const result = jobQueue.getResult(requestId);
				if (!result) {
					send('error', {
						message: 'Compression completed without result payload',
						requestId,
						code: ErrorCode.COMPRESSION_FAILED,
					});
					cleanup();
					controller.close();
					return;
				}

				send('result', {
					requestId,
					filename: result.filename,
					data: Buffer.from(result.buffer).toString('base64'),
					originalSize: result.originalSize,
					compressedSize: result.compressedSize,
					ratio: result.ratio,
					method: result.method,
				});

				cleanup();
				controller.close();
			});
		},
		cancel() {
			cleanup();
		},
	});

	return new Response(stream, {
		headers: {
			...CORS_HEADERS,
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'X-Request-ID': requestId,
			Connection: 'keep-alive',
		},
	});
}

async function handleCreateJob(req: globalThis.Request): Promise<Response> {
	const requestId = crypto.randomUUID();

	const parsed = await parseCompressRequest(req, requestId, false);
	if (parsed instanceof Response) {
		return parsed;
	}

	jobQueue.submit({
		requestId,
		input: parsed.input,
		filename: parsed.filename,
		preset: parsed.preset,
		simplifyRatio: parsed.simplifyRatio,
		resources: parsed.resources,
	});

	return Response.json(
		{
			requestId,
			status: 'queued',
			statusUrl: `/jobs/${encodeURIComponent(requestId)}`,
			resultUrl: `/jobs/${encodeURIComponent(requestId)}/result`,
		},
		{
			status: 202,
			headers: {
				...CORS_HEADERS,
				'X-Request-ID': requestId,
			},
		},
	);
}

function handleGetJobStatus(requestId: string): Response {
	const snapshot = jobQueue.getSnapshot(requestId);
	if (!snapshot) {
		return jsonError('JOB_NOT_FOUND', `Job not found: ${requestId}`, 404, requestId);
	}

	return Response.json(snapshot, {
		headers: {
			...CORS_HEADERS,
			'X-Request-ID': requestId,
		},
	});
}

function handleGetJobResult(requestId: string): Response {
	const snapshot = jobQueue.getSnapshot(requestId);
	if (!snapshot) {
		return jsonError('JOB_NOT_FOUND', `Job not found: ${requestId}`, 404, requestId);
	}

	if (snapshot.status === 'queued' || snapshot.status === 'running') {
		return jsonError('JOB_NOT_READY', 'Job is not finished yet', 409, requestId);
	}

	if (snapshot.status === 'error') {
		return jsonError(
			snapshot.error?.code ?? ErrorCode.COMPRESSION_FAILED,
			snapshot.error?.message ?? 'Compression failed',
			500,
			requestId,
		);
	}

	const result = jobQueue.getResult(requestId);
	if (!result) {
		return jsonError('JOB_RESULT_MISSING', 'Job finished but no result is available', 500, requestId);
	}

	return new Response(result.buffer, {
		headers: {
			...CORS_HEADERS,
			'Content-Type': 'model/gltf-binary',
			'Content-Disposition': contentDisposition(result.filename),
			'Content-Length': String(result.buffer.byteLength),
			'X-Request-ID': requestId,
			'X-Original-Size': String(result.originalSize),
			'X-Compressed-Size': String(result.compressedSize),
			'X-Compression-Method': result.method,
			'X-Compression-Ratio': String(result.ratio),
		},
	});
}

export async function startServer() {
	const tls = await resolveTls();

	const server = Bun.serve({
		port: PORT,
		hostname: '0.0.0.0',
		tls,

		routes: {
			'/healthz': new Response('ok', { headers: CORS_HEADERS }),
			'/compress': {
				POST: handleCompress,
				OPTIONS: handleOptions,
			},
			'/compress-stream': {
				POST: handleCompressStream,
				OPTIONS: handleOptions,
			},
		},

		fetch: async (req: globalThis.Request) => {
			const url = new URL(req.url);

			if (url.pathname === '/jobs') {
				if (req.method === 'POST') {
					return handleCreateJob(req);
				}
				if (req.method === 'OPTIONS') {
					return handleOptions();
				}
			}

			const route = parseJobRoute(url.pathname);
			if (route) {
				if (req.method === 'GET') {
					return route.kind === 'status' ? handleGetJobStatus(route.requestId) : handleGetJobResult(route.requestId);
				}
				if (req.method === 'OPTIONS') {
					return handleOptions();
				}
			}

			// Static file serving
			const filePath = resolve(join(FRONTEND_DIR, url.pathname));
			if (filePath === FRONTEND_DIR || filePath.startsWith(`${FRONTEND_DIR}/`)) {
				const file = Bun.file(filePath);
				if (await file.exists()) {
					const cacheControl = url.pathname.startsWith('/_app/immutable/') ? IMMUTABLE_CACHE : 'no-cache';
					return new Response(file, {
						headers: { ...CORS_HEADERS, 'Cache-Control': cacheControl },
					});
				}

				// SPA fallback — serve index.html for client-side routing
				const indexFile = Bun.file(join(FRONTEND_DIR, 'index.html'));
				if (await indexFile.exists()) {
					return new Response(indexFile, {
						headers: { ...CORS_HEADERS, 'Content-Type': 'text/html;charset=utf-8' },
					});
				}
			}

			return new Response('Not found', { status: 404, headers: CORS_HEADERS });
		},

		error(error: Error) {
			console.error('Server error:', error);
			return Response.json({ error: 'Internal server error' }, { status: 500, headers: CORS_HEADERS });
		},
	});

	console.log(`Compression server running at ${server.url}`);
	return server;
}

if (import.meta.main) {
	startServer();
}
