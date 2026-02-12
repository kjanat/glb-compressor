# Custom Transforms

A-la-carte glTF-Transform `Transform` functions for advanced usage outside the
main pipeline. All return `Transform` for use with `document.transform()`.

## Import

```ts
import {
	mergeByDistance,
	decimateBloatedMeshes,
	removeUnusedUVs,
	normalizeWeights,
	analyzeMeshComplexity,
	removeDegenerateFaces,
	removeStaticTracksWithBake,
	analyzeAnimations,
} from 'glb-compressor';
```

## Geometry Transforms

### `mergeByDistance(tolerance?: number): Transform`

Merge vertices by position within a distance tolerance (like Blender's "Merge by
Distance"). Only compares positions, ignoring normals/UVs. **Static meshes
only** - breaks weight assignments on skinned models.

- Default tolerance: `0.0001`
- Uses spatial hashing (`1 / tolerance` precision)

### `decimateBloatedMeshes(threshold?, targetRatio?, simplifier): Transform`

Auto-simplify meshes exceeding a vertex-count threshold. Uses meshoptimizer.

- `threshold`: Vertex count trigger (default: `2000`)
- `targetRatio`: Desired reduction factor (default: `0.5`)
- `simplifier`: `MeshoptSimplifier` WASM module instance

### `removeDegenerateFaces(minArea?: number): Transform`

Remove zero-area triangles from TRIANGLES-mode primitives. Checks for duplicate
indices and cross-product area below `minArea` (default: `1e-10`).

### `removeUnusedUVs(): Transform`

Strip `TEXCOORD_N` attributes not referenced by any material. Inspects base
color, normal, occlusion, emissive, and metallic-roughness texture infos. Falls
back to keeping `TEXCOORD_0` if textures exist but no explicit UV is referenced.

## Animation Transforms

### `removeStaticTracksWithBake(tolerance?: number): Transform`

Remove static animation tracks using a 3-pass global-consensus algorithm:

1. **Static** - every animation targeting node+path has identical keyframes
2. **Consensus** - all static values agree across animations
3. **Matches base** - agreed value equals node's rest-pose transform

Intentionally conservative: preserves animation "coverage" for correct blending.
Tracks that are individually static but lack cross-animation consensus are
reported but kept.

- Default tolerance: `1e-6`

## Skinned Model Transforms

### `normalizeWeights(): Transform`

Renormalize `WEIGHTS_0` so components sum to exactly `1.0`. Fixes
`ACCESSOR_WEIGHTS_NON_NORMALIZED` glTF validation errors after mesh transforms.

## Diagnostic Transforms (read-only)

### `analyzeMeshComplexity(warnThreshold?, totalWarnThreshold?): Transform`

Log scene stats: mesh count, vertex count, skin count, animation count. Lists
meshes exceeding `warnThreshold` (default: `2000`) and warns if total exceeds
`totalWarnThreshold` (default: `15000`). Does not modify the document.

### `analyzeAnimations(): Transform`

Log animation stats: clip count, channel count, total keyframe count. Does not
modify the document.

## Example: Custom Pipeline

```ts
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld } from '@gltf-transform/functions';
import {
	mergeByDistance,
	removeDegenerateFaces,
	removeUnusedUVs,
	analyzeMeshComplexity,
} from 'glb-compressor';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read('model.glb');

await doc.transform(
	analyzeMeshComplexity(),
	dedup(),
	prune(),
	removeUnusedUVs(),
	weld(),
	mergeByDistance(0.0001),
	removeDegenerateFaces(),
);

const output = await io.writeBinary(doc);
```

## Safety Matrix

| Transform                    | Static | Skinned | Notes                        |
| ---------------------------- | ------ | ------- | ---------------------------- |
| `mergeByDistance`            | safe   | SKIP    | Breaks weight assignments    |
| `decimateBloatedMeshes`      | safe   | SKIP    | Can distort skinned geometry |
| `removeDegenerateFaces`      | safe   | safe    |                              |
| `removeUnusedUVs`            | safe   | safe    |                              |
| `normalizeWeights`           | n/a    | safe    | Only relevant for skinned    |
| `removeStaticTracksWithBake` | safe   | safe    |                              |
| `analyzeMeshComplexity`      | safe   | safe    | Read-only                    |
| `analyzeAnimations`          | safe   | safe    | Read-only                    |
