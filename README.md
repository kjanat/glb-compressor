# glb-compressor

[![npm](https://img.shields.io/npm/v/glb-compressor)](https://www.npmjs.com/package/glb-compressor)

Multi-phase GLB/glTF 3D model compression toolkit built on [Bun].

Strips existing compression, cleans geometry, optimizes animations, compresses
textures to WebP, and applies mesh compression via [gltfpack] or
[meshoptimizer].\
Tuned for skinned avatar models with automatic conservative handling of skeleton
hierarchies.

Available as a **CLI tool**, **HTTP server** (with SSE streaming), and **library
API**.

## Requirements

- [Bun] >= 1.3
- [gltfpack] (optional, recommended &mdash; falls back to meshopt WASM if
  unavailable)

## Installation

```sh
# Global install (recommended for CLI & server usage)
bun i -g glb-compressor
```

This provides two binaries: `glb-compressor` (CLI) and `glb-server` (HTTP server
with SSE streaming).

```sh
# As a project dependency (for library usage)
bun add glb-compressor
```

## Usage

### CLI

```sh
# Compress a single file
glb-compressor model.glb

# Compress with a preset
glb-compressor model.glb -p aggressive

# Compress multiple files to an output directory
glb-compressor *.glb -o ./compressed/ -p balanced

# Additional mesh simplification (50%)
glb-compressor model.glb -s 0.5

# Quiet mode
glb-compressor model.glb -q -p max -f
```

**Options:**

| Flag                   | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `-o, --output <dir>`   | Output directory (default: same dir, `-compressed` suffix) |
| `-p, --preset <name>`  | Compression preset (see [Presets](#presets))               |
| `-s, --simplify <0-1>` | Mesh simplification ratio (e.g. `0.5` = 50%)               |
| `-q, --quiet`          | Suppress progress output                                   |
| `-f, --force`          | Overwrite existing files                                   |
| `-h, --help`           | Show help                                                  |
| `-v, --version`        | Show version                                               |

### Server

The `glb-server` binary starts an HTTP server that accepts GLB uploads and
returns compressed files — useful for integrating compression into web
pipelines, CI/CD, or editor plugins without shelling out to the CLI.

```sh
glb-server                  # default port 8080
PORT=3000 glb-server        # custom port
bun run dev                 # from source with hot-reload
```

**Endpoints:**

| Method | Path               | Description                                            |
| ------ | ------------------ | ------------------------------------------------------ |
| GET    | `/healthz`         | Health check                                           |
| POST   | `/compress`        | Synchronous compression, returns compressed GLB binary |
| POST   | `/compress-stream` | SSE streaming with progress logs and base64 result     |

**`POST /compress`** accepts `multipart/form-data` (field: `file`) or raw binary
body. Query params: `?simplify=0.5&preset=aggressive`.

Response headers include `X-Original-Size`, `X-Compressed-Size`,
`X-Compression-Method`, and `X-Compression-Ratio`.

```sh
# Upload with curl
curl -X POST -F "file=@model.glb" "http://localhost:8080/compress?preset=aggressive" -o compressed.glb
```

**`POST /compress-stream`** accepts `multipart/form-data` and returns
`text/event-stream` with `log`, `result`, and `error` events:

```sh
curl -X POST -F "file=@model.glb" "http://localhost:8080/compress-stream"
```

### Library

```ts
import { compress, init, type CompressOptions } from 'glb-compressor';

await init(); // Optional, called automatically by compress()

const glb = new Uint8Array(await Bun.file('model.glb').arrayBuffer());
const result = await compress(glb, {
	preset: 'aggressive',
	simplifyRatio: 0.5,
	onLog: (msg) => console.log(msg),
});

await Bun.write('compressed.glb', result.buffer);
console.log(
	`${result.method}: ${result.originalSize} -> ${result.buffer.byteLength}`,
);
```

Individual transforms are also exported for advanced use:

```ts
import {
	mergeByDistance,
	removeDegenerateFaces,
	removeStaticTracksWithBake,
	removeUnusedUVs,
	normalizeWeights,
	analyzeMeshComplexity,
	decimateBloatedMeshes,
} from 'glb-compressor';
```

## Presets

Empirically benchmarked against a 30 MB skinned avatar (77 animations, 89k
vertices):

| Preset       | Result  | Reduction | Description                                            |
| ------------ | ------- | --------- | ------------------------------------------------------ |
| `default`    | 5.95 MB | -80.4%    | Conservative, preserves all detail                     |
| `balanced`   | 5.37 MB | -82.3%    | Moderate animation quantization, 24 Hz resample        |
| `aggressive` | 4.83 MB | -84.1%    | Strong animation quantization, 15 Hz resample          |
| `max`        | 4.77 MB | -84.3%    | Aggressive + supercompression + lower vertex precision |

## Compression Pipeline

The pipeline runs in 5 phases with automatic skinned-model detection:

```diagram
Input GLB
  |
  v
Strip existing compression (Draco/Meshopt)
  |
  v
Phase 1 - Cleanup: dedup, prune, removeUnusedUVs
  |       [static only: flatten, join, weld]
  v
Phase 2 - Geometry (static only):
  |       mergeByDistance, removeDegenerateFaces, decimateBloatedMeshes
  v
Phase 3 - GPU optimizations:
  |       instance detection, vertex reorder (static only), sparse encoding
  v
Phase 4 - Animation + Weights:
  |       resample keyframes, remove static tracks (global consensus),
  |       normalize bone weights (skinned only)
  v
Phase 5 - Textures: compress to WebP (max 1024x1024)
  |
  v
Final compression: gltfpack (preferred) or meshopt WASM (fallback)
  |
  v
Output compressed GLB
```

Skinned models skip `flatten`, `join`, `weld`, `mergeByDistance`, `reorder`, and
`quantize` to protect skeleton hierarchies and vertex weight integrity.

## Docker

The Dockerfile builds gltfpack from source with BasisU texture compression
support:

```sh
docker build -t glb-compressor .
docker run -p 8080:8080 glb-compressor
```

## Development

```sh
bun run dev         # Hot-reload server
bun run cli         # Run CLI
bun run check       # Biome lint + format check
bun run lint        # Biome lint only
bun run fmt         # dprint format
bun run typecheck   # tsgo type check
```

## Acknowledgments

Built on the shoulders of:

- [glTF-Transform] by Don McCurdy — the core document model and standard
  transform library that powers the entire pipeline
- [meshoptimizer] / [gltfpack] by Arseny Kapoulkine — mesh compression, vertex
  reordering, simplification, and the final compression pass
- [sharp] — high-performance image processing for texture compression to WebP
- [draco3dgltf] — Google's mesh compression decoder for handling
  Draco-compressed input models
- [Bun] — the runtime, bundler, and test runner

## License

[MIT]

<!--link-definitions-->

[MIT]: https://github.com/kjanat/glb-compressor/blob/master/LICENSE
[sharp]: https://sharp.pixelplumbing.com
[draco3dgltf]: https://github.com/google/draco#readme
[meshoptimizer]: https://github.com/zeux/meshoptimizer
[gltfpack]: https://github.com/zeux/meshoptimizer/tree/master/gltf#readme
[glTF-Transform]: https://gltf-transform.dev/
[Bun]: https://bun.sh
