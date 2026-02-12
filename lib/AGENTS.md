# lib/

Core compression library. Public API exported via `mod.ts` barrel.

## Module graph

```text
constants.ts  ← leaf, no internal deps
transforms.ts ← leaf, depends on @gltf-transform + meshoptimizer (type only)
utils.ts      ← depends on constants
compress.ts   ← depends on constants, transforms, utils
mod.ts        ← barrel re-export of all above
```

## Key files

### compress.ts (pipeline orchestrator)

- `compress(input, options?)` — main entry point, runs 5 phases
- `init()` — eager WASM warm-up (Draco + Meshopt), called automatically
- `PRESETS` — `Record<CompressPreset, PresetConfig>` with 4 levels
- `getHasGltfpack()` — checks for external binary availability
- Skinned-model detection happens here; skips destructive transforms when
  skeleton found

### transforms.ts (custom glTF-Transform transforms)

All return `Transform` functions for use with `document.transform()`:

- `mergeByDistance(tolerance?)` — merge vertices within tolerance
- `decimateBloatedMeshes(threshold?, targetRatio?, simplifier)` — auto-simplify
  meshes exceeding vertex threshold
- `removeUnusedUVs()` — strip UV sets with no material reference
- `normalizeWeights()` — renormalize bone weights (skinned models)
- `analyzeMeshComplexity(warnThreshold?, totalWarnThreshold?)` — log-only
  analysis
- `removeDegenerateFaces(minArea?)` — remove zero-area triangles
- `removeStaticTracksWithBake(tolerance?)` — remove animation tracks that don't
  move, using global consensus across all animations
- `analyzeAnimations()` — log-only animation stats

### constants.ts

`MAX_FILE_SIZE`, `GLB_MAGIC`, `ErrorCode`, `COMPRESSION_EXTENSIONS`,
texture/mesh thresholds.

### utils.ts

`formatBytes`, `sanitizeFilename`, `validateGlbMagic`, `withTempDir`,
`parseSimplifyRatio`.

## Anti-patterns (this directory)

- Don't add transforms that modify skinned meshes without checking `hasSkinning`
  in `compress.ts` first.
- Don't import from `cli/` or `server/` — lib is the dependency root.
- Don't bypass `mod.ts` barrel for public API additions.
