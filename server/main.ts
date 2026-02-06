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

/** Build the standard CORS headers included in every response. */
function corsHeaders(): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, X-Request-ID',
		'Access-Control-Expose-Headers':
			'X-Request-ID, X-Original-Size, X-Compressed-Size, X-Compression-Method, X-Compression-Ratio',
	};
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
		headers: { ...corsHeaders(), 'X-Request-ID': requestId },
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
	const url = new URL(req.url);
	const contentType = req.headers.get('content-type') ?? '';

	let input: Uint8Array;
	let filename = 'model.glb';
	let simplifyRatio: number | undefined = parseSimplifyRatio(
		url.searchParams.get('simplify'),
	);
	let preset = parsePreset(url.searchParams.get('preset'));

	// Handle multipart/form-data (file upload) or raw binary
	if (contentType.includes('multipart/form-data')) {
		const formData = await req.formData(); // TODO: `formData` is deprecated...
		const file = formData.get('file') as File | null;
		if (!file) {
			return jsonError(
				ErrorCode.NO_FILE_PROVIDED,
				'No file provided in form data',
				400,
				requestId,
			);
		}
		// File size validation
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
		// Check form data for simplify param
		const formSimplify = formData.get('simplify');
		if (formSimplify && !simplifyRatio) {
			simplifyRatio = parseSimplifyRatio(String(formSimplify));
		}
		// Check form data for preset param
		const formPreset = formData.get('preset');
		if (formPreset) {
			preset = parsePreset(String(formPreset));
		}
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

	// GLB magic byte validation (returns 400, not 500)
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

	console.log(
		`[${requestId}] Received ${filename}: ${formatBytes(input.byteLength)} (preset: ${preset})`,
	);
	const { buffer, method } = await compress(input, { simplifyRatio, preset });
	const ratio: string = (
		(1 - buffer.byteLength / input.byteLength) *
		100
	).toFixed(1);
	console.log(
		`[${requestId}] ${formatBytes(input.byteLength)} -> ${formatBytes(
			buffer.byteLength,
		)} (${ratio}% reduction, ${method})`,
	);

	return new Response(new Uint8Array(buffer).buffer, {
		headers: {
			...corsHeaders(),
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
	const contentType = req.headers.get('content-type') ?? '';

	let input: Uint8Array;
	let filename = 'model.glb';
	let simplifyRatio: number | undefined;
	let preset: CompressPreset = 'default';

	if (contentType.includes('multipart/form-data')) {
		const formData = await req.formData(); // TODO: `formData` is deprecated...
		const file = formData.get('file') as File | null;
		if (!file) {
			return jsonError(
				ErrorCode.NO_FILE_PROVIDED,
				'No file provided in form data',
				400,
				requestId,
			);
		}
		// File size validation
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
		const formSimplify = formData.get('simplify');
		if (formSimplify) {
			simplifyRatio = parseSimplifyRatio(String(formSimplify));
		}
		const formPreset = formData.get('preset');
		if (formPreset) {
			preset = parsePreset(String(formPreset));
		}
	} else {
		return jsonError(
			ErrorCode.INVALID_CONTENT_TYPE,
			'Use multipart/form-data for streaming endpoint',
			415,
			requestId,
		);
	}

	// GLB magic byte validation (returns 400, not 500)
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

	const safeFilename = sanitizeFilename(filename);
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				controller.enqueue(
					encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
				);
			};

			send('log', {
				message: `[${requestId}] Received ${safeFilename}: ${formatBytes(input.byteLength)} (preset: ${preset})`,
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

				// Send result as base64
				const base64 = Buffer.from(buffer).toString('base64');
				send('result', {
					requestId,
					filename: safeFilename.replace(/\.(glb|gltf)$/i, '-compressed.glb'),
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
			...corsHeaders(),
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
		headers: corsHeaders(),
	});
}

if (import.meta.main) {
	const server = Bun.serve({
		port: PORT,

		routes: {
			'/healthz': new Response('ok', { headers: corsHeaders() }),
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
			new Response('Not found', { status: 404, headers: corsHeaders() }),

		error(error) {
			console.error('Server error:', error);
			return Response.json(
				{ error: String(error) },
				{ status: 500, headers: corsHeaders() },
			);
		},
	});

	console.log(`Compression server running at ${server.url}`);
}
