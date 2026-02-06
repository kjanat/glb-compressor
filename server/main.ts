#!/usr/bin/env bun
/**
 * HTTP compression server built on `Bun.serve()`.
 *
 * Exposes two compression endpoints:
 *
 * - **`POST /compress`** — synchronous compression returning the compressed GLB binary
 *   with metadata in response headers. Accepts `multipart/form-data` or raw binary body.
 *
 * - **`POST /compress-stream`** — SSE (Server-Sent Events) streaming endpoint that
 *   delivers real-time progress logs and the final compressed GLB as base64.
 *
 * Both endpoints accept `?preset=` and `?simplify=` query params (or form fields).
 * Full CORS support, GLB magic-byte validation, 100 MB file size limit, and
 * structured JSON error responses with request ID tracking.
 *
 * @example
 * ```sh
 * # Start the server
 * PORT=3000 bun server/main.ts
 *
 * # Upload a file
 * curl -X POST -F "file=@model.glb" "http://localhost:3000/compress?preset=aggressive" -o out.glb
 * ```
 *
 * @module server
 */

import type { CompressPreset } from '$lib/mod';
import {
	compress,
	DEFAULT_PORT,
	ErrorCode,
	formatBytes,
	MAX_FILE_SIZE,
	PRESETS,
	parseSimplifyRatio,
	sanitizeFilename,
	validateGlbMagic,
} from '$lib/mod';

const VALID_PRESETS = new Set(Object.keys(PRESETS));

/**
 * Parse and validate a compression preset string.
 * Returns `"default"` for null, empty, or unrecognized values.
 */
function parsePreset(raw: string | null): CompressPreset {
	if (!raw || !VALID_PRESETS.has(raw)) return 'default';
	return raw as CompressPreset;
}

/** Resolved server port from `PORT` env var or {@link DEFAULT_PORT}. */
const PORT = parseInt(process.env.PORT || String(DEFAULT_PORT), 10);

/** Shape of JSON error responses returned by all endpoints. */
interface ApiError {
	error: {
		code: string;
		message: string;
	};
	requestId: string;
}

/** Standard CORS headers included in every response. */
const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Request-ID',
	'Access-Control-Expose-Headers':
		'X-Request-ID, X-Original-Size, X-Compressed-Size, X-Compression-Method, X-Compression-Ratio',
};

/**
 * Parsed and validated compression request data extracted from an incoming HTTP request.
 */
interface ParsedRequest {
	input: Uint8Array;
	filename: string;
	preset: CompressPreset;
	simplifyRatio: number | undefined;
}

/**
 * Parse and validate a compression request from multipart form data or raw binary body.
 *
 * Extracts the file, validates size and GLB magic bytes, and resolves preset/simplify
 * options from query params and form fields (form fields take precedence).
 *
 * @param req            - Incoming HTTP request.
 * @param requestId      - UUID tracking this request.
 * @param requireMultipart - If `true`, reject non-multipart requests with 415.
 * @returns Parsed request data or an error Response.
 */
async function parseCompressRequest(
	req: globalThis.Request,
	requestId: string,
	requireMultipart: boolean,
): Promise<ParsedRequest | Response> {
	const url = new URL(req.url);
	const contentType = req.headers.get('content-type') ?? '';

	let input: Uint8Array;
	let filename = 'model.glb';
	let simplifyRatio: number | undefined = parseSimplifyRatio(
		url.searchParams.get('simplify'),
	);
	let preset = parsePreset(url.searchParams.get('preset'));

	if (contentType.includes('multipart/form-data')) {
		const formData = await req.formData();
		const file = formData.get('file') as File | null;
		if (!file) {
			return jsonError(
				ErrorCode.NO_FILE_PROVIDED,
				'No file provided in form data',
				400,
				requestId,
			);
		}
		if (file.size > MAX_FILE_SIZE) {
			return jsonError(
				ErrorCode.FILE_TOO_LARGE,
				`File too large: ${formatBytes(file.size)} exceeds ${formatBytes(MAX_FILE_SIZE)} limit`,
				413,
				requestId,
			);
		}
		input = new Uint8Array(await file.arrayBuffer());
		filename = file.name;
		// Form data overrides query params
		const formSimplify = formData.get('simplify');
		if (formSimplify) {
			simplifyRatio = parseSimplifyRatio(String(formSimplify));
		}
		const formPreset = formData.get('preset');
		if (formPreset) {
			preset = parsePreset(String(formPreset));
		}
	} else if (requireMultipart) {
		return jsonError(
			ErrorCode.INVALID_CONTENT_TYPE,
			'Use multipart/form-data for streaming endpoint',
			415,
			requestId,
		);
	} else {
		const contentLength = req.headers.get('content-length');
		if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
			return jsonError(
				ErrorCode.FILE_TOO_LARGE,
				`File too large: exceeds ${formatBytes(MAX_FILE_SIZE)} limit`,
				413,
				requestId,
			);
		}
		input = new Uint8Array(await req.arrayBuffer());
		if (input.byteLength > MAX_FILE_SIZE) {
			return jsonError(
				ErrorCode.FILE_TOO_LARGE,
				`File too large: ${formatBytes(input.byteLength)} exceeds ${formatBytes(MAX_FILE_SIZE)} limit`,
				413,
				requestId,
			);
		}
	}

	// GLB magic byte validation
	try {
		validateGlbMagic(input);
	} catch (err) {
		return jsonError(
			ErrorCode.INVALID_GLB,
			err instanceof Error ? err.message : 'Invalid GLB file',
			400,
			requestId,
		);
	}

	return { input, filename: sanitizeFilename(filename), preset, simplifyRatio };
}

/**
 * Create a structured JSON error response with CORS headers and request ID.
 *
 * @param code      - Machine-readable error code from {@link ErrorCode}.
 * @param message   - Human-readable error description.
 * @param status    - HTTP status code (e.g. 400, 413, 415, 500).
 * @param requestId - UUID tracking this request.
 */
function jsonError(
	code: string,
	message: string,
	status: number,
	requestId: string,
): Response {
	const body: ApiError = {
		error: { code, message },
		requestId,
	};
	return Response.json(body, {
		status,
		headers: { ...CORS_HEADERS, 'X-Request-ID': requestId },
	});
}

/**
 * Handle `POST /compress` — synchronous GLB compression.
 *
 * Accepts `multipart/form-data` (field: `file`) or raw `application/octet-stream`.
 * Compression options can be passed as query params (`?preset=&simplify=`) or
 * form fields. Returns the compressed GLB binary with metadata headers:
 *
 * - `X-Original-Size` / `X-Compressed-Size` — byte counts
 * - `X-Compression-Method` — `"gltfpack"` or `"meshopt"`
 * - `X-Compression-Ratio` — percentage reduction (e.g. `"84.1"`)
 * - `Content-Disposition` — suggested download filename
 */
async function handleCompress(req: globalThis.Request): Promise<Response> {
	const requestId = crypto.randomUUID();

	const parsed = await parseCompressRequest(req, requestId, false);
	if (parsed instanceof Response) return parsed;
	const { input, filename, preset, simplifyRatio } = parsed;

	console.log(
		`[${requestId}] Received ${filename}: ${formatBytes(input.byteLength)} (preset: ${preset})`,
	);

	let buffer: Uint8Array;
	let method: string;
	try {
		({ buffer, method } = await compress(input, { simplifyRatio, preset }));
	} catch (err) {
		console.error(`[${requestId}] Compression failed:`, err);
		return jsonError(
			ErrorCode.COMPRESSION_FAILED,
			err instanceof Error ? err.message : 'Compression failed',
			500,
			requestId,
		);
	}

	const ratio: string = (
		(1 - buffer.byteLength / input.byteLength) *
		100
	).toFixed(1);
	console.log(
		`[${requestId}] ${formatBytes(input.byteLength)} -> ${formatBytes(
			buffer.byteLength,
		)} (${ratio}% reduction, ${method})`,
	);

	return new Response(buffer, {
		headers: {
			...CORS_HEADERS,
			'Content-Type': 'model/gltf-binary',
			'Content-Disposition': `attachment; filename="${filename.replace(/\.(glb|gltf)$/i, '-compressed.glb')}"`,
			'Content-Length': String(buffer.byteLength),
			'X-Request-ID': requestId,
			'X-Original-Size': String(input.byteLength),
			'X-Compressed-Size': String(buffer.byteLength),
			'X-Compression-Method': method,
			'X-Compression-Ratio': ratio,
		},
	});
}

/**
 * Handle `POST /compress-stream` — SSE streaming GLB compression.
 *
 * Only accepts `multipart/form-data`. Returns a `text/event-stream` response
 * with three event types:
 *
 * - `log`    — `{ message: string }` — real-time progress messages
 * - `result` — `{ requestId, filename, data (base64), originalSize, compressedSize, ratio, method }`
 * - `error`  — `{ message, requestId, code }` — if compression fails
 *
 * The stream closes after the `result` or `error` event.
 */
async function handleCompressStream(
	req: globalThis.Request,
): Promise<Response> {
	const requestId = crypto.randomUUID();

	const parsed = await parseCompressRequest(req, requestId, true);
	if (parsed instanceof Response) return parsed;
	const { input, filename, preset, simplifyRatio } = parsed;

	// filename is already sanitized by parseCompressRequest
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				controller.enqueue(
					encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
				);
			};

			send('log', {
				message: `[${requestId}] Received ${filename}: ${formatBytes(input.byteLength)} (preset: ${preset})`,
			});

			try {
				const { buffer, method } = await compress(input, {
					simplifyRatio,
					preset,
					onLog: (msg) => send('log', { message: msg }),
				});

				const ratio = (
					(1 - buffer.byteLength / input.byteLength) *
					100
				).toFixed(1);
				send('log', {
					message: `Done: ${formatBytes(input.byteLength)} -> ${formatBytes(buffer.byteLength)} (${ratio}% reduction)`,
				});

				// Send result as base64.
				// NOTE: For very large files this creates a string ~33% larger than
				// the binary in memory. The SSE design inherently requires this; for
				// files approaching MAX_FILE_SIZE, prefer the /compress endpoint.
				const base64 = Buffer.from(buffer).toString('base64');
				send('result', {
					requestId,
					filename: filename.replace(/\.(glb|gltf)$/i, '-compressed.glb'),
					data: base64,
					originalSize: input.byteLength,
					compressedSize: buffer.byteLength,
					ratio,
					method,
				});
			} catch (err) {
				send('error', {
					message: String(err),
					requestId,
					code: ErrorCode.COMPRESSION_FAILED,
				});
			}

			controller.close();
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

/** Handle CORS preflight `OPTIONS` requests with a `204 No Content` response. */
function handleOptions(): Response {
	return new Response(null, {
		status: 204,
		headers: CORS_HEADERS,
	});
}

if (import.meta.main) {
	const server = Bun.serve({
		port: PORT,

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

		fetch: () =>
			new Response('Not found', { status: 404, headers: CORS_HEADERS }),

		error(error) {
			console.error('Server error:', error);
			return Response.json(
				{ error: String(error) },
				{ status: 500, headers: CORS_HEADERS },
			);
		},
	});

	console.log(`Compression server running at ${server.url}`);
}
