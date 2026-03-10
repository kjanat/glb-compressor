import type { CompressPreset } from '@glb-compressor/core';
import {
	ErrorCode,
	formatBytes,
	MAX_FILE_SIZE,
	PRESETS,
	parseSimplifyRatio,
	sanitizeFilename,
	validateGlbMagic,
} from '@glb-compressor/core';

const isPreset = (value: string): value is CompressPreset => {
	return value === 'default' || value === 'balanced' || value === 'aggressive' || value === 'max';
};

export interface ApiError {
	error: {
		code: string;
		message: string;
	};
	requestId: string;
}

export const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Request-ID',
	'Access-Control-Expose-Headers':
		'X-Request-ID, X-Original-Size, X-Compressed-Size, X-Compression-Method, X-Compression-Ratio',
};

export interface ParsedRequest {
	input: Uint8Array;
	filename: string;
	preset: CompressPreset;
	simplifyRatio: number | undefined;
	resources: Record<string, Uint8Array> | undefined;
}

export function jsonError(code: string, message: string, status: number, requestId: string): Response {
	const body: ApiError = {
		error: { code, message },
		requestId,
	};

	return Response.json(body, {
		status,
		headers: { ...CORS_HEADERS, 'X-Request-ID': requestId },
	});
}

export async function parseCompressRequest(
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
		const formData = await req.formData();
		const fileField = formData.get('file');
		if (!fileField) {
			return jsonError(ErrorCode.NO_FILE_PROVIDED, 'No file provided in form data', 400, requestId);
		}
		if (!(fileField instanceof File)) {
			return jsonError(ErrorCode.INVALID_FILE, 'Invalid multipart file field', 400, requestId);
		}
		const file = fileField;
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
		isGltfInput = /\.gltf$/i.test(filename);

		if (isGltfInput) {
			resources = {};
			let totalBytes = input.byteLength;
			for (const value of formData.values()) {
				if (!(value instanceof File) || value === file) {
					continue;
				}
				totalBytes += value.size;
				if (totalBytes > MAX_FILE_SIZE) {
					return jsonError(
						ErrorCode.FILE_TOO_LARGE,
						`File bundle too large: exceeds ${formatBytes(MAX_FILE_SIZE)} limit`,
						413,
						requestId,
					);
				}
				resources[value.name] = new Uint8Array(await value.arrayBuffer());
			}
		}

		const formSimplify = formData.get('simplify');
		if (typeof formSimplify === 'string' && formSimplify.length > 0) {
			simplifyRatio = parseSimplifyRatio(formSimplify);
			if (simplifyRatio === undefined) {
				return jsonError(
					ErrorCode.INVALID_SIMPLIFY_RATIO,
					`Invalid simplify ratio: ${formSimplify} (must be between 0 and 1)`,
					400,
					requestId,
				);
			}
		} else if (formSimplify !== null) {
			return jsonError(ErrorCode.INVALID_SIMPLIFY_RATIO, 'Invalid simplify ratio field type', 400, requestId);
		}

		const formPreset = formData.get('preset');
		if (typeof formPreset === 'string' && formPreset.length > 0) {
			if (!isPreset(formPreset)) {
				return jsonError(
					ErrorCode.INVALID_PRESET,
					`Invalid preset: ${formPreset} (must be one of: ${Object.keys(PRESETS).join(', ')})`,
					400,
					requestId,
				);
			}
			preset = formPreset;
		} else if (formPreset !== null) {
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
