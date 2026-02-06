// === Shared constants ===
export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
export const GLB_MAGIC = 0x46546c67; // "glTF" in little-endian
export const GLTFPACK_TIMEOUT_MS = 60_000; // 60 seconds
export const DEFAULT_PORT = 8080;
export const MESH_WARN_THRESHOLD = 2000;
export const TOTAL_WARN_THRESHOLD = 15000;
export const MERGE_TOLERANCE = 0.0001;
export const TEXTURE_MAX_SIZE = 1024;
export const INSTANCE_MIN = 2;

export const ErrorCode = {
	INVALID_FILE: 'INVALID_FILE',
	FILE_TOO_LARGE: 'FILE_TOO_LARGE',
	INVALID_GLB: 'INVALID_GLB',
	COMPRESSION_FAILED: 'COMPRESSION_FAILED',
	NO_FILE_PROVIDED: 'NO_FILE_PROVIDED',
	INVALID_CONTENT_TYPE: 'INVALID_CONTENT_TYPE',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export const COMPRESSION_EXTENSIONS = [
	'KHR_draco_mesh_compression',
	'EXT_meshopt_compression',
];
