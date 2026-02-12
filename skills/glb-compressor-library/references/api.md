# API Reference

Full type surface and utilities exported from `glb-compressor`.

## Types

### CompressPreset

```ts
type CompressPreset = 'default' | 'balanced' | 'aggressive' | 'max';
```

### CompressOptions

```ts
interface CompressOptions {
	simplifyRatio?: number; // (0, 1) - additional mesh simplification
	onLog?: (msg: string) => void; // Progress callback
	quiet?: boolean; // Suppress console output
	preset?: CompressPreset; // Default: 'default'
}
```

### CompressResult

```ts
interface CompressResult {
	buffer: Uint8Array; // Compressed GLB binary
	method: string; // 'gltfpack' | 'meshopt'
	originalSize?: number; // Input byte count
}
```

## Constants

| Constant               | Value        | Description                         |
| ---------------------- | ------------ | ----------------------------------- |
| `MAX_FILE_SIZE`        | `104857600`  | 100 MB server upload limit          |
| `GLB_MAGIC`            | `0x46546c67` | GLB magic bytes (ASCII `"glTF"`)    |
| `GLTFPACK_TIMEOUT_MS`  | `60000`      | 60s gltfpack subprocess timeout     |
| `DEFAULT_PORT`         | `8080`       | Server default port                 |
| `MESH_WARN_THRESHOLD`  | `2000`       | Per-mesh vertex warning threshold   |
| `TOTAL_WARN_THRESHOLD` | `15000`      | Scene total vertex warning          |
| `MERGE_TOLERANCE`      | `0.0001`     | Spatial hash merge tolerance        |
| `TEXTURE_MAX_SIZE`     | `1024`       | Max texture dimension after resize  |
| `INSTANCE_MIN`         | `2`          | Min identical meshes for instancing |

## Error Codes

```ts
const ErrorCode = {
	INVALID_FILE: 'INVALID_FILE',
	FILE_TOO_LARGE: 'FILE_TOO_LARGE',
	INVALID_GLB: 'INVALID_GLB',
	COMPRESSION_FAILED: 'COMPRESSION_FAILED',
	NO_FILE_PROVIDED: 'NO_FILE_PROVIDED',
	INVALID_CONTENT_TYPE: 'INVALID_CONTENT_TYPE',
} as const;

type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];
```

## Utility Functions

### `formatBytes(bytes: number): string`

Format byte count to human-readable string (`"1.5 KB"`, `"3.21 MB"`).

### `validateGlbMagic(input: Uint8Array): void`

Validate GLB magic bytes. Throws if invalid.

### `sanitizeFilename(name: string): string`

Strip path traversal, invalid chars, cap at 200 chars. Returns `"model.glb"` if
empty.

### `parseSimplifyRatio(raw: string | null): number | undefined`

Parse string to simplify ratio in `(0, 1)`. Returns `undefined` if invalid.

### `withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T>`

Execute callback with auto-cleaned temp directory.

## PRESETS Object

```ts
const PRESETS: Record<CompressPreset, {
  skinned: string[];  // gltfpack flags for skinned models
  static: string[];   // gltfpack flags for static models
}>;
```

Access preset configs for custom gltfpack invocations or inspection.

## Compression Extensions

```ts
const COMPRESSION_EXTENSIONS = [
	'KHR_draco_mesh_compression',
	'EXT_meshopt_compression',
];
```

Stripped from documents before re-compression to avoid double-encoding.
