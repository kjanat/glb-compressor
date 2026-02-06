/**
 * Shared constants used across the compression library, CLI, and server.
 *
 * @module constants
 */

/** Maximum upload file size accepted by the server (100 MB). */
export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

/** GLB binary container magic number — ASCII "glTF" as a little-endian uint32. */
export const GLB_MAGIC = 0x46546c67; // "glTF" in little-endian

/** Maximum time (ms) to wait for a `gltfpack` subprocess before killing it. */
export const GLTFPACK_TIMEOUT_MS = 60_000; // 60 seconds

/** Default HTTP server port when `PORT` env var is not set. */
export const DEFAULT_PORT = 8080;

/** Per-mesh vertex count above which {@linkcode analyzeMeshComplexity} emits a warning. */
export const MESH_WARN_THRESHOLD = 2000;

/** Total scene vertex count above which {@linkcode analyzeMeshComplexity} emits a warning. */
export const TOTAL_WARN_THRESHOLD = 15000;

/** Spatial-hash precision for {@linkcode mergeByDistance} — vertices within this distance are merged. */
export const MERGE_TOLERANCE = 0.0001;

/** Maximum texture dimension (width or height) after compression. Textures are downscaled to fit. */
export const TEXTURE_MAX_SIZE = 1024;

/** Minimum number of identical meshes required before `instance()` creates GPU instances. */
export const INSTANCE_MIN = 2;

/**
 * Machine-readable error codes returned by the server in JSON error responses.
 *
 * @example
 * ```jsonl
 * { "error": { "code": "INVALID_GLB", "message": "..." }, "requestId": "..." }
 * ```
 */
export const ErrorCode = {
	INVALID_FILE: 'INVALID_FILE',
	FILE_TOO_LARGE: 'FILE_TOO_LARGE',
	INVALID_GLB: 'INVALID_GLB',
	COMPRESSION_FAILED: 'COMPRESSION_FAILED',
	NO_FILE_PROVIDED: 'NO_FILE_PROVIDED',
	INVALID_CONTENT_TYPE: 'INVALID_CONTENT_TYPE',
} as const;

/** Union type of all possible {@link ErrorCode} string values. */
export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * glTF extension names that represent mesh compression.
 *
 * These are stripped from the document before re-compression to avoid double-encoding.
 */
export const COMPRESSION_EXTENSIONS = [
	'KHR_draco_mesh_compression',
	'EXT_meshopt_compression',
];
