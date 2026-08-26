import type { CompressPreset } from '@glb-compressor/core';
import {
	ErrorCode,
	formatBytes,
	MAX_FILE_SIZE,
	parseSimplifyRatio,
	PRESETS,
	sanitizeFilename,
	validateGlbMagic,
} from '@glb-compressor/core';
import { MaxFileSizeExceededError, MultipartParseError, parseMultipartRequest } from '@mjackson/multipart-parser';

const isPreset = (value: string): value is CompressPreset => {
	return value === 'default' || value === 'balanced' || value === 'aggressive' || value === 'max';
};

interface ApiError {
	error: {
		code: string;
		message: string;
	};
	requestId: string;
}

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Request-ID',
	'Access-Control-Expose-Headers':
		'X-Request-ID, X-Original-Size, X-Compressed-Size, X-Compression-Method, X-Compression-Ratio',
};

interface ParsedRequest {
	input: Uint8Array;
	filename: string;
	preset: CompressPreset;
	simplifyRatio: number | undefined;
	resources: Record<string, Uint8Array> | undefined;
}

interface UploadedFile {
	bytes: Uint8Array;
	filename: string;
}

type MultipartField = { type: 'file'; value: UploadedFile } | { type: 'text'; value: string };

function jsonError(code: string, message: string, status: number, requestId: string): Response {
	const body: ApiError = {
		error: { code, message },
		requestId,
	};

	return Response.json(body, {
		status,
		headers: { ...CORS_HEADERS, 'X-Request-ID': requestId },
	});
}

async function parseCompressRequest(
	req: globalThis.Request,
	requestId: string,
	requireMultipart: boolean,
): Promise<ParsedRequest | Response> {
	const url = new URL(req.url);
	const contentType = req.headers.get('content-type') ?? '';

	let input: Uint8Array;
	let filename = 'model.glb';
	let resources: Record<string, Uint8Array> | undefined;
	let isGltfInput = false;

	const queryPreset = url.searchParams.get('preset');
	let preset: CompressPreset = 'default';
	if (queryPreset !== null && queryPreset.length > 0) {
		if (!isPreset(queryPreset)) {
			return jsonError(
				ErrorCode.INVALID_PRESET,
				`Invalid preset: ${queryPreset} (must be one of: ${Object.keys(PRESETS).join(', ')})`,
				400,
				requestId,
			);
		}
		preset = queryPreset;
	}

	const querySimplify = url.searchParams.get('simplify');
	let simplifyRatio: number | undefined = parseSimplifyRatio(querySimplify);
	if (querySimplify !== null && simplifyRatio === undefined) {
		return jsonError(
			ErrorCode.INVALID_SIMPLIFY_RATIO,
			`Invalid simplify ratio: ${querySimplify} (must be between 0 and 1)`,
			400,
			requestId,
		);
	}

	if (contentType.includes('multipart/form-data')) {
		const uploads: UploadedFile[] = [];
		let fileField: MultipartField | undefined;
		let simplifyField: MultipartField | undefined;
		let presetField: MultipartField | undefined;

		try {
			for await (const part of parseMultipartRequest(req, { maxFileSize: MAX_FILE_SIZE })) {
				let field: MultipartField;
				if (part.isFile) {
					const upload: UploadedFile = {
						bytes: part.bytes,
						filename: part.filename ?? '',
					};
					uploads.push(upload);
					field = { type: 'file', value: upload };
				} else {
					field = { type: 'text', value: part.text };
				}

				if (part.name === 'file' && fileField === undefined) {
					fileField = field;
				} else if (part.name === 'simplify' && simplifyField === undefined) {
					simplifyField = field;
				} else if (part.name === 'preset' && presetField === undefined) {
					presetField = field;
				}
			}
		} catch (error) {
			if (error instanceof MaxFileSizeExceededError) {
				return jsonError(
					ErrorCode.FILE_TOO_LARGE,
					`File too large: exceeds ${formatBytes(MAX_FILE_SIZE)} limit`,
					413,
					requestId,
				);
			}
			if (error instanceof MultipartParseError) {
				return jsonError(ErrorCode.INVALID_FILE, `Invalid multipart form data: ${error.message}`, 400, requestId);
			}
			throw error;
		}

		if (fileField === undefined) {
			return jsonError(ErrorCode.NO_FILE_PROVIDED, 'No file provided in form data', 400, requestId);
		}
		if (fileField.type !== 'file') {
			return jsonError(ErrorCode.INVALID_FILE, 'Invalid multipart file field', 400, requestId);
		}
		const file = fileField.value;
		input = file.bytes;
		filename = file.filename;
		isGltfInput = /\.gltf$/i.test(filename);

		if (isGltfInput) {
			resources = {};
			let totalBytes = input.byteLength;
			for (const upload of uploads) {
				if (upload === file) {
					continue;
				}
				totalBytes += upload.bytes.byteLength;
				if (totalBytes > MAX_FILE_SIZE) {
					return jsonError(
						ErrorCode.FILE_TOO_LARGE,
						`File bundle too large: exceeds ${formatBytes(MAX_FILE_SIZE)} limit`,
						413,
						requestId,
					);
				}
				resources[upload.filename] = upload.bytes;
			}
		}

		if (simplifyField?.type === 'text' && simplifyField.value.length > 0) {
			simplifyRatio = parseSimplifyRatio(simplifyField.value);
			if (simplifyRatio === undefined) {
				return jsonError(
					ErrorCode.INVALID_SIMPLIFY_RATIO,
					`Invalid simplify ratio: ${simplifyField.value} (must be between 0 and 1)`,
					400,
					requestId,
				);
			}
		} else if (simplifyField !== undefined) {
			return jsonError(ErrorCode.INVALID_SIMPLIFY_RATIO, 'Invalid simplify ratio field type', 400, requestId);
		}

		if (presetField?.type === 'text' && presetField.value.length > 0) {
			if (!isPreset(presetField.value)) {
				return jsonError(
					ErrorCode.INVALID_PRESET,
					`Invalid preset: ${presetField.value} (must be one of: ${Object.keys(PRESETS).join(', ')})`,
					400,
					requestId,
				);
			}
			preset = presetField.value;
		} else if (presetField !== undefined) {
			return jsonError(ErrorCode.INVALID_PRESET, 'Invalid preset field type', 400, requestId);
		}
	} else if (requireMultipart) {
		return jsonError(ErrorCode.INVALID_CONTENT_TYPE, 'Use multipart/form-data for streaming endpoint', 415, requestId);
	} else {
		isGltfInput = contentType.includes('application/json') || contentType.includes('model/gltf+json');

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

	if (!isGltfInput) {
		try {
			validateGlbMagic(input);
		} catch (error) {
			return jsonError(
				ErrorCode.INVALID_GLB,
				error instanceof Error ? error.message : 'Invalid GLB file',
				400,
				requestId,
			);
		}
	}

	return {
		input,
		filename: sanitizeFilename(filename),
		preset,
		simplifyRatio,
		resources,
	};
}

export type { ApiError, ParsedRequest };
export { CORS_HEADERS, jsonError, parseCompressRequest };
