#!/usr/bin/env node

import { CORS_HEADERS, jsonError, parseCompressRequest } from '#http';
import { CompressionJobQueue } from '#job-queue';
import type { JobResult } from '#job-queue';
import { resolveTls } from '#tls';
import { DEFAULT_PORT, ErrorCode, formatBytes } from '@glb-compressor/core';
import type { CompressionStreamEventMap } from '@glb-compressor/shared-types';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { createServer as createHttpsServer } from 'node:https';
import { extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(process.env.PORT || String(DEFAULT_PORT), 10);

// Static frontend serving — resolved once at startup
const FRONTEND_DIR = resolve(process.env.FRONTEND_DIR ?? join(process.cwd(), 'dist', 'frontend'));
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	'.css': 'text/css;charset=utf-8',
	'.html': 'text/html;charset=utf-8',
	'.ico': 'image/x-icon',
	'.js': 'text/javascript;charset=utf-8',
	'.json': 'application/json;charset=utf-8',
	'.map': 'application/json;charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.txt': 'text/plain;charset=utf-8',
	'.wasm': 'application/wasm',
	'.webp': 'image/webp',
};

const jobQueue = new CompressionJobQueue();

function contentDisposition(filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7E]/g, '_');
	const encoded = encodeURIComponent(filename);
	if (ascii === filename) return `attachment; filename="${filename}"`;
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

interface JobRoute {
	requestId: string;
	kind: 'status' | 'result';
}

function parseJobRoute(pathname: string): JobRoute | undefined {
	if (!pathname.startsWith('/jobs/')) return undefined;

	const suffix = pathname.slice('/jobs/'.length);
	if (suffix.length === 0) return undefined;

	const parts = suffix.split('/');
	const [rawRequestId] = parts;
	if (rawRequestId === undefined || rawRequestId.length === 0) return undefined;

	let requestId: string;
	try {
		requestId = decodeURIComponent(rawRequestId);
	} catch {
		return undefined;
	}

	if (parts.length === 1) return { requestId, kind: 'status' };
	if (parts.length === 2 && parts[1] === 'result') return { requestId, kind: 'result' };

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
	if (parsed instanceof Response) return parsed;
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
		`[${requestId}] ${formatBytes(result.originalSize)} -> ${
			formatBytes(
				result.compressedSize,
			)
		} (${result.ratio}% reduction, ${result.method})`,
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
	if (!snapshot) return jsonError('JOB_NOT_FOUND', `Job not found: ${requestId}`, 404, requestId);

	return Response.json(snapshot, {
		headers: {
			...CORS_HEADERS,
			'X-Request-ID': requestId,
		},
	});
}

function handleGetJobResult(requestId: string): Response {
	const snapshot = jobQueue.getSnapshot(requestId);
	if (!snapshot) return jsonError('JOB_NOT_FOUND', `Job not found: ${requestId}`, 404, requestId);

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
	if (!result) return jsonError('JOB_RESULT_MISSING', 'Job finished but no result is available', 500, requestId);

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

async function staticFileResponse(path: string, cacheControl: string): Promise<Response | undefined> {
	try {
		const metadata = await stat(path);
		if (!metadata.isFile()) return undefined;
		const body = await readFile(path);
		const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
		return new Response(body, {
			headers: { ...CORS_HEADERS, 'Cache-Control': cacheControl, 'Content-Type': contentType },
		});
	} catch {
		return undefined;
	}
}

async function handleRequest(req: globalThis.Request): Promise<Response> {
	const url = new URL(req.url);

	if (url.pathname === '/healthz') return new Response('ok', { headers: CORS_HEADERS });

	if (url.pathname === '/compress') {
		if (req.method === 'POST') return handleCompress(req);
		if (req.method === 'OPTIONS') return handleOptions();
	}

	if (url.pathname === '/compress-stream') {
		if (req.method === 'POST') return handleCompressStream(req);
		if (req.method === 'OPTIONS') return handleOptions();
	}

	if (url.pathname === '/jobs') {
		if (req.method === 'POST') return handleCreateJob(req);
		if (req.method === 'OPTIONS') return handleOptions();
	}

	const route = parseJobRoute(url.pathname);
	if (route) {
		if (req.method === 'GET') {
			return route.kind === 'status' ? handleGetJobStatus(route.requestId) : handleGetJobResult(route.requestId);
		}
		if (req.method === 'OPTIONS') return handleOptions();
	}

	const filePath = resolve(join(FRONTEND_DIR, url.pathname));
	if (filePath === FRONTEND_DIR || filePath.startsWith(`${FRONTEND_DIR}/`)) {
		const cacheControl = url.pathname.startsWith('/_app/immutable/') ? IMMUTABLE_CACHE : 'no-cache';
		const fileResponse = await staticFileResponse(filePath, cacheControl);
		if (fileResponse) return fileResponse;

		const indexResponse = await staticFileResponse(join(FRONTEND_DIR, 'index.html'), 'no-cache');
		if (indexResponse) return indexResponse;
	}

	return new Response('Not found', { status: 404, headers: CORS_HEADERS });
}

interface NodeRequestInit extends RequestInit {
	duplex?: 'half';
}

function toWebRequest(nodeRequest: IncomingMessage, protocol: 'http' | 'https', port: number): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(nodeRequest.headers)) {
		if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
	}

	const method = nodeRequest.method ?? 'GET';
	const hasBody = method !== 'GET' && method !== 'HEAD';
	const url = new URL(nodeRequest.url ?? '/', `${protocol}://${nodeRequest.headers.host ?? `localhost:${port}`}`);
	const init: NodeRequestInit = {
		method,
		headers,
		body: hasBody ? Readable.toWeb(nodeRequest) : null,
		duplex: hasBody ? 'half' : undefined,
	};
	return new Request(url.href, init);
}

async function writeWebResponse(response: Response, nodeResponse: ServerResponse): Promise<void> {
	nodeResponse.writeHead(response.status, Object.fromEntries(response.headers.entries()));
	if (response.body === null) {
		nodeResponse.end();
		return;
	}

	const reader = response.body.getReader();
	let finished = false;
	nodeResponse.once('close', () => {
		if (!finished) void reader.cancel();
	});

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!nodeResponse.write(value)) await once(nodeResponse, 'drain');
		}
		finished = true;
		nodeResponse.end();
	} catch (error) {
		void reader.cancel();
		throw error;
	}
}

async function handleNodeRequest(
	nodeRequest: IncomingMessage,
	nodeResponse: ServerResponse,
	protocol: 'http' | 'https',
	port: number,
): Promise<void> {
	try {
		await writeWebResponse(await handleRequest(toWebRequest(nodeRequest, protocol, port)), nodeResponse);
	} catch (error) {
		console.error('Server error:', error);
		if (nodeResponse.headersSent) {
			nodeResponse.destroy();
			return;
		}
		await writeWebResponse(
			Response.json({ error: 'Internal server error' }, { status: 500, headers: CORS_HEADERS }),
			nodeResponse,
		);
	}
}

type NodeServer = HttpServer | HttpsServer;

export interface CompressionServer {
	url: URL;
	stop(force?: boolean): Promise<void>;
}

async function listen(server: NodeServer, port: number): Promise<void> {
	await new Promise<void>((resolveListen, reject) => {
		const onError = (error: Error) => reject(error);
		server.once('error', onError);
		server.listen(port, '0.0.0.0', () => {
			server.off('error', onError);
			resolveListen();
		});
	});
}

export async function startServer(port = PORT): Promise<CompressionServer> {
	const tls = await resolveTls();
	const protocol = tls === undefined ? 'http' : 'https';
	const listener = (request: IncomingMessage, response: ServerResponse) => {
		void handleNodeRequest(request, response, protocol, port);
	};
	const server: NodeServer = tls === undefined ? createHttpServer(listener) : createHttpsServer(tls, listener);

	await listen(server, port);
	const address = server.address();
	if (address === null || typeof address === 'string') {
		server.close();
		throw new Error('Failed to resolve listening server address');
	}

	const url = new URL(`${protocol}://0.0.0.0:${address.port}/`);
	console.log(`Compression server running at ${url}`);

	return {
		url,
		async stop(force = false) {
			if (force) server.closeAllConnections();
			await new Promise<void>((resolveClose, reject) => {
				server.close((error) => error === undefined ? resolveClose() : reject(error));
			});
		},
	};
}

const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath)) {
	void startServer().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
