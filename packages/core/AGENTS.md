# @glb-compressor/core

Core compression library. Public API exported via `mod.ts` barrel.

## Module graph

```text
constants.ts  <- leaf, no internal deps
transforms.ts <- leaf, depends on @gltf-transform + meshoptimizer (type only)
utils.ts      <- depends on constants
compress.ts   <- depends on constants, transforms, utils
mod.ts        <- barrel re-export of all above
```

## Key files

### compress.ts (pipeline orchestrator, ~500 lines)

- `compress(input, options?)` — main entry point, runs 6 phases
- `init()` — eager WASM warm-up (Draco + Meshopt), called automatically at
  import time
- `PRESETS` — `Record<CompressPreset, GltfpackPresetConfig>` with 4 levels:
  `default`, `balanced`, `aggressive`, `max`
- `getHasGltfpack()` — checks for external binary availability
- `compressWithGltfpack()` — (private) subprocess with 60s timeout, temp file I/O
- `compressWithMeshopt()` — (private) pure WASM fallback when gltfpack unavailable

#### Pipeline phases

| Phase        | Transforms                                                          | Skinned?    |
| ------------ | ------------------------------------------------------------------- | ----------- |
| Parse        | `io.readBinary(input)`                                              | both        |
| Strip        | Remove Draco/Meshopt extension markers                              | both        |
| 1: Cleanup   | `dedup`, `prune`, `removeUnusedUVs` + `flatten/join/weld`           | static+     |
| 2: Geometry  | `mergeByDistance`, `removeDegenerateFaces`, `decimateBloatedMeshes` | static only |
| 3: GPU       | `instance`, `reorder`, `sparse`                                     | static+     |
| 4: Animation | `resample`, `removeStaticTracksWithBake`, `normalizeWeights`        | skinned+    |
| 5: Textures  | `textureCompress` (WebP via sharp, max 1024x1024)                   | both        |
| 6: Backend   | gltfpack subprocess or meshopt WASM fallback                        | both        |

The `hasSkins` boolean (detected via `doc.getRoot().listSkins()`) gates every
phase. Phases marked `static+` add transforms only for non-skinned models.
`skinned+` adds transforms only for skinned models.

### transforms.ts (custom glTF-Transform transforms, ~670 lines)

All return `Transform` functions for use with `document.transform()`:

| Function                       | Static | Skinned  | Purpose                                  |
| ------------------------------ | ------ | -------- | ---------------------------------------- |
| `mergeByDistance(tolerance?)`  | safe   | **SKIP** | Merge vertices within tolerance          |
| `decimateBloatedMeshes()`      | safe   | **SKIP** | Auto-simplify meshes exceeding threshold |
| `removeDegenerateFaces()`      | safe   | safe     | Remove zero-area triangles               |
| `removeUnusedUVs()`            | safe   | safe     | Strip UV sets with no material reference |
| `normalizeWeights()`           | n/a    | safe     | Renormalize bone weights                 |
| `removeStaticTracksWithBake()` | safe   | safe     | Remove animation tracks that don't move  |
| `analyzeMeshComplexity()`      | safe   | safe     | Log-only analysis (read-only)            |
| `analyzeAnimations()`          | safe   | safe     | Log-only animation stats (read-only)     |

### constants.ts

`MAX_FILE_SIZE`, `GLB_MAGIC`, `ErrorCode`, `COMPRESSION_EXTENSIONS`,
texture/mesh thresholds, `DEFAULT_PORT`.

### utils.ts

`formatBytes`, `sanitizeFilename`, `validateGlbMagic`, `withTempDir`,
`parseSimplifyRatio`.

## Barrel exports (`mod.ts`)

- `export *` for `constants.ts` and `transforms.ts` (everything auto-public)
- Named exports for `compress.ts` and `utils.ts` (curated)
- Adding any `export` to constants or transforms automatically becomes public API

## Complexity hotspots

- `compress()` (~130 lines) — 7 branch points on `hasSkins`
- Module-level eager init fires at import time; `.catch()` re-throws
- `compressWithGltfpack()` — manual timeout + temp file management
- `transforms.ts` logs to `console.log` unconditionally (bypasses `quiet`/`onLog`)
- `at()` helper in transforms.ts throws `RangeError` on out-of-bounds — compensates
  for `noUncheckedIndexedAccess`

## Anti-patterns (this package)

- Don't add transforms modifying skinned meshes without `hasSkins` guard in
  `compress.ts`.
- Don't import from `cli/` or `server/` — core is the dependency root.
- Don't bypass `mod.ts` barrel for public API additions.
- Adding exports to `constants.ts`/`transforms.ts` auto-exposes them publicly via
  `export *` in the barrel — be intentional.
