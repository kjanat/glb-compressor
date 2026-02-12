/**
 * Custom glTF-Transform transforms for geometry cleanup, animation optimization,
 * and mesh analysis.
 *
 * These transforms complement the standard `@gltf-transform/functions` library
 * with operations specifically tuned for avatar and game-asset workflows:
 *
 * - **Geometry**: spatial vertex dedup, degenerate face removal, bloat detection
 * - **Animation**: global-consensus static track removal
 * - **Validation**: bone weight normalization, unused UV cleanup
 * - **Diagnostics**: mesh complexity and animation statistics
 *
 * @module transforms
 */

import type {
	Accessor,
	Animation,
	AnimationChannel,
	AnimationSampler,
	Document,
	GLTF,
	Mesh,
	Node,
	TextureInfo,
	Transform,
	TypedArray,
} from '@gltf-transform/core';
import * as transform from '@gltf-transform/functions';
import type { MeshoptSimplifier as MeshoptSimplifierType } from 'meshoptimizer';

/** Index into a `TypedArray`, asserting the value is defined.
 *
 * > safe under `noUncheckedIndexedAccess`.
 */
function at(arr: TypedArray | number[], i: number): number {
	const v = arr[i];
	if (v === undefined)
		throw new RangeError(`Index ${i} out of bounds (length ${arr.length})`);
	return v;
}

/**
 * Merge vertices by position within a distance tolerance (like Blender's "Merge by Distance").
 *
 * Unlike glTF-Transform's `weld()`, this only compares **positions**, ignoring
 * normals and UVs. Vertices whose quantized positions match are collapsed into a
 * single vertex, and all attributes (normals, UVs, colors, etc.) are compacted
 * accordingly. The index buffer is remapped to reference the deduplicated vertices.
 *
 * Best suited for static (non-skinned) meshes — merging skinned vertices can
 * break weight assignments.
 *
 * @param tolerance - Maximum distance between two positions to consider them identical.
 *                    Internally converted to a spatial-hash precision of `1 / tolerance`.
 * @returns A glTF-Transform `Transform` function.
 */
export function mergeByDistance(tolerance = 0.0001): Transform {
	return (doc: Document): void => {
		const precision: number = 1 / tolerance;
		let totalRemoved: number = 0;

		for (const mesh of doc.getRoot().listMeshes()) {
			for (const prim of mesh.listPrimitives()) {
				const posAccessor: Accessor | null = prim.getAttribute('POSITION');
				const indicesAccessor: Accessor | null = prim.getIndices();
				if (!posAccessor || !indicesAccessor) continue;

				const positions: TypedArray | null = posAccessor.getArray();
				const indices: TypedArray | null = indicesAccessor.getArray();
				if (!positions || !indices) continue;

				const vertCount: number = positions.length / 3;
				const vertexMap = new Map<string, number>();
				const remap = new Uint32Array(vertCount);
				const newToOld: number[] = [];

				// Build spatial hash - map position to canonical vertex index
				for (let i: number = 0; i < vertCount; i++) {
					const x: number = Math.round(at(positions, i * 3) * precision);
					const y: number = Math.round(at(positions, i * 3 + 1) * precision);
					const z: number = Math.round(at(positions, i * 3 + 2) * precision);
					const key = `${x},${y},${z}`;

					const existing: number | undefined = vertexMap.get(key);
					if (existing !== undefined) {
						remap[i] = existing;
					} else {
						const newIdx: number = newToOld.length;
						vertexMap.set(key, newIdx);
						newToOld.push(i);
						remap[i] = newIdx;
					}
				}

				const removed: number = vertCount - newToOld.length;
				if (removed === 0) continue;
				totalRemoved += removed;

				// Remap indices
				const newIndices = new Uint32Array(indices.length);
				for (let i: number = 0; i < indices.length; i++) {
					newIndices[i] = at(remap, at(indices, i));
				}

				// Compact all vertex attributes
				for (const semantic of prim.listSemantics()) {
					const attr: Accessor | null = prim.getAttribute(semantic);
					if (!attr) continue;

					const oldArray: TypedArray | null = attr.getArray();
					if (!oldArray) continue;

					const itemSize: number = attr.getElementSize();
					const TypedArrayCtor = oldArray.constructor as new (
						len: number,
					) => TypedArray;
					const newArray: TypedArray = new TypedArrayCtor(
						newToOld.length * itemSize,
					);

					for (let i: number = 0; i < newToOld.length; i++) {
						const oldIdx: number = at(newToOld, i);
						for (let j: number = 0; j < itemSize; j++) {
							newArray[i * itemSize + j] = at(oldArray, oldIdx * itemSize + j);
						}
					}
					attr.setArray(newArray);
				}

				indicesAccessor.setArray(newIndices);
			}
		}

		if (totalRemoved > 0) {
			console.log(
				`  mergeByDistance: removed ${totalRemoved} duplicate vertices`,
			);
		}
	};
}

/**
 * Auto-decimate meshes that exceed a vertex-count threshold.
 *
 * Scans every mesh primitive and identifies those with more vertices than
 * `threshold`. If any are found, applies meshoptimizer simplification with an
 * adaptive ratio derived from the worst offender's vertex count.
 *
 * @param threshold   - Vertex count above which a mesh is considered "bloated".
 * @param targetRatio - Desired vertex reduction factor (0.5 = target 50% of threshold).
 * @param simplifier  - The meshoptimizer `MeshoptSimplifier` WASM module instance.
 * @returns A glTF-Transform `Transform` function (async).
 */
export function decimateBloatedMeshes(
	threshold = 2000,
	targetRatio = 0.5,
	simplifier: typeof MeshoptSimplifierType,
): Transform {
	return async (doc: Document): Promise<void> => {
		const dominated: Array<{
			mesh: string;
			verts: number;
			targetVerts: number;
		}> = [];

		for (const mesh of doc.getRoot().listMeshes()) {
			for (const prim of mesh.listPrimitives()) {
				const posAccessor: Accessor | null = prim.getAttribute('POSITION');
				if (!posAccessor) continue;

				const vertCount: number = posAccessor.getCount();
				if (vertCount > threshold) {
					const targetVerts: number = Math.floor(threshold * targetRatio);
					dominated.push({
						mesh: mesh.getName() || 'unnamed',
						verts: vertCount,
						targetVerts,
					});
				}
			}
		}

		if (dominated.length > 0) {
			console.log(
				`  decimateBloated: ${dominated.length} mesh(es) exceed ${threshold} verts`,
			);
			for (const { mesh, verts, targetVerts } of dominated) {
				console.log(`    ${mesh}: ${verts} -> ~${targetVerts} verts`);
			}

			// Use glTF-Transform's simplify with aggressive ratio for bloated meshes
			const ratio: number =
				targetRatio *
				(threshold / Math.max(...dominated.map((d): number => d.verts)));
			await doc.transform(
				transform.simplify({
					simplifier,
					ratio: Math.max(0.1, Math.min(ratio, 0.8)),
					error: 0.01,
				}),
			);
		}
	};
}

/**
 * Remove unused texture coordinates (UV sets not referenced by any material).
 *
 * Inspects all materials for `TEXCOORD_N` references (base color, normal,
 * occlusion, emissive, metallic-roughness), then strips any `TEXCOORD_N`
 * attribute whose index is not in the referenced set. Falls back to keeping
 * `TEXCOORD_0` if textures exist but no explicit UV channel is referenced.
 *
 * @returns A glTF-Transform `Transform` function.
 */
export function removeUnusedUVs(): Transform {
	return (doc: Document): void => {
		let removed: number = 0;

		// Collect UV sets actually used by materials
		const usedUVSets = new Set<number>();
		for (const mat of doc.getRoot().listMaterials()) {
			// Check all texture info for UV channel references
			const texInfos: (TextureInfo | null)[] = [
				mat.getBaseColorTextureInfo(),
				mat.getNormalTextureInfo(),
				mat.getOcclusionTextureInfo(),
				mat.getEmissiveTextureInfo(),
				mat.getMetallicRoughnessTextureInfo(),
			];
			for (const info of texInfos) {
				if (info) usedUVSets.add(info.getTexCoord());
			}
		}

		// Default to `TEXCOORD_0` if any textures exist
		if (doc.getRoot().listTextures().length > 0 && usedUVSets.size === 0) {
			usedUVSets.add(0);
		}

		// Remove unused `TEXCOORD_N` attributes
		for (const mesh of doc.getRoot().listMeshes()) {
			for (const prim of mesh.listPrimitives()) {
				for (const semantic of prim.listSemantics()) {
					if (semantic.startsWith('TEXCOORD_')) {
						const idx: number = parseInt(
							semantic.slice('TEXCOORD_'.length),
							10,
						);
						if (!usedUVSets.has(idx)) {
							prim.setAttribute(semantic, null);
							removed++;
						}
					}
				}
			}
		}

		if (removed > 0) {
			console.log(`  removeUnusedUVs: removed ${removed} unused UV set(s)`);
		}
	};
}

/**
 * Normalize bone weights so each vertex's `WEIGHTS_0` components sum to exactly 1.0.
 *
 * Iterates every vertex in every mesh primitive that has a `WEIGHTS_0` attribute.
 * If the weight sum deviates from 1.0 by more than `1e-6`, all components are
 * divided by their sum. This fixes `ACCESSOR_WEIGHTS_NON_NORMALIZED` glTF
 * validation errors that commonly appear after mesh transforms.
 *
 * @returns A glTF-Transform `Transform` function.
 */
export function normalizeWeights(): Transform {
	return (doc: Document): void => {
		let normalized: number = 0;

		for (const mesh of doc.getRoot().listMeshes()) {
			for (const prim of mesh.listPrimitives()) {
				const weights0: Accessor | null = prim.getAttribute('WEIGHTS_0');
				if (!weights0) continue;

				const arr: TypedArray | null = weights0.getArray();
				if (!arr) continue;

				const elementSize: number = weights0.getElementSize(); // Usually 4
				const count: number = arr.length / elementSize;

				for (let i: number = 0; i < count; i++) {
					let sum: number = 0;
					for (let j: number = 0; j < elementSize; j++) {
						sum += at(arr, i * elementSize + j);
					}
					if (sum > 0 && Math.abs(sum - 1.0) > 1e-6) {
						for (let j: number = 0; j < elementSize; j++) {
							arr[i * elementSize + j] = at(arr, i * elementSize + j) / sum;
						}
						normalized++;
					}
				}

				weights0.setArray(arr);
			}
		}

		if (normalized > 0) {
			console.log(`  normalizeWeights: fixed ${normalized} vertices`);
		}
	};
}

/**
 * Diagnostic transform that logs scene complexity statistics to the console.
 *
 * Reports total mesh count, vertex count, skin count, and animation count.
 * Individually lists meshes exceeding `warnThreshold` vertices (up to 5) and
 * emits a warning if the total scene vertex count exceeds `totalWarnThreshold`.
 *
 * This transform is read-only — it does not modify the document.
 *
 * @param warnThreshold      - Per-mesh vertex count that triggers a "bloated" warning.
 * @param totalWarnThreshold - Total scene vertex count that triggers a high-complexity warning.
 * @returns A glTF-Transform `Transform` function.
 */
export function analyzeMeshComplexity(
	warnThreshold = 2000,
	totalWarnThreshold = 15000,
): Transform {
	return (doc: Document): void => {
		let totalVerts: number = 0;
		const bloated: Array<{ name: string; verts: number }> = [];

		for (const mesh of doc.getRoot().listMeshes()) {
			let meshVerts: number = 0;
			for (const prim of mesh.listPrimitives()) {
				const pos: Accessor | null = prim.getAttribute('POSITION');
				if (pos) meshVerts += pos.getCount();
			}
			totalVerts += meshVerts;

			if (meshVerts > warnThreshold) {
				bloated.push({ name: mesh.getName() || 'unnamed', verts: meshVerts });
			}
		}

		const skins: number = doc.getRoot().listSkins().length;
		const animations: number = doc.getRoot().listAnimations().length;
		const meshCount: number = doc.getRoot().listMeshes().length;

		console.log(
			`  Scene: ${meshCount} meshes, ${totalVerts.toLocaleString()} verts, ${skins} skins, ${animations} animations`,
		);

		if (bloated.length > 0) {
			console.log(`  Bloated meshes (>${warnThreshold} verts):`);
			for (const { name, verts } of bloated.slice(0, 5)) {
				console.log(`    ${name}: ${verts.toLocaleString()} verts`);
			}
			if (bloated.length > 5) {
				console.log(`    ... and ${bloated.length - 5} more`);
			}
		}

		if (totalVerts > totalWarnThreshold) {
			console.log(
				`  Warning: High total vertex count (${totalVerts.toLocaleString()} > ${totalWarnThreshold.toLocaleString()})`,
			);
		}
	};
}

/**
 * Remove degenerate (zero-area) triangles from all TRIANGULAR mesh primitives.
 *
 * A triangle is considered degenerate if any two of its vertex indices are
 * identical, or if its cross-product area falls below `minArea`. The index
 * buffer is rewritten in-place with only the surviving triangles.
 *
 * @param minArea - Minimum triangle area (in world units squared) to keep.
 *                  Triangles smaller than this are discarded.
 * @returns A glTF-Transform `Transform` function.
 */
export function removeDegenerateFaces(minArea = 1e-10): Transform {
	return (doc: Document): void => {
		let totalRemoved: number = 0;

		for (const mesh of doc.getRoot().listMeshes()) {
			for (const prim of mesh.listPrimitives()) {
				if (prim.getMode() !== 4) continue; // Only TRIANGLES

				const posAccessor: Accessor | null = prim.getAttribute('POSITION');
				const indicesAccessor: Accessor | null = prim.getIndices();
				if (!posAccessor || !indicesAccessor) continue;

				const positions: TypedArray | null = posAccessor.getArray();
				const indices: TypedArray | null = indicesAccessor.getArray();
				if (!positions || !indices) continue;

				const validIndices: number[] = [];

				for (let i: number = 0; i < indices.length; i += 3) {
					const i0: number = at(indices, i),
						i1: number = at(indices, i + 1),
						i2: number = at(indices, i + 2);

					// Skip if indices are the same (degenerate)
					if (i0 === i1 || i1 === i2 || i0 === i2) {
						totalRemoved++;
						continue;
					}

					// Get vertices
					const v0x = at(positions, i0 * 3),
						v0y = at(positions, i0 * 3 + 1),
						v0z = at(positions, i0 * 3 + 2);
					const v1x = at(positions, i1 * 3),
						v1y = at(positions, i1 * 3 + 1),
						v1z = at(positions, i1 * 3 + 2);
					const v2x = at(positions, i2 * 3),
						v2y = at(positions, i2 * 3 + 1),
						v2z = at(positions, i2 * 3 + 2);

					// Compute triangle area via cross product
					const ax: number = v1x - v0x,
						ay: number = v1y - v0y,
						az: number = v1z - v0z;
					const bx: number = v2x - v0x,
						by: number = v2y - v0y,
						bz: number = v2z - v0z;
					const cx: number = ay * bz - az * by;
					const cy: number = az * bx - ax * bz;
					const cz: number = ax * by - ay * bx;
					const area: number = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);

					if (area < minArea) {
						totalRemoved++;
						continue;
					}

					validIndices.push(i0, i1, i2);
				}

				if (validIndices.length < indices.length) {
					indicesAccessor.setArray(new Uint32Array(validIndices));
				}
			}
		}

		if (totalRemoved > 0) {
			console.log(
				`  removeDegenerateFaces: removed ${totalRemoved} degenerate triangles`,
			);
		}
	};
}

/**
 * Remove static animation tracks using a 3-pass global-consensus algorithm.
 *
 * A track is only removed when **all** of these conditions hold for a given
 * `node + targetPath` combination across **every** animation in the document:
 *
 * 1. **Static** — every animation targeting this node+path has identical keyframes.
 * 2. **Consensus** — all those static values agree with each other.
 * 3. **Matches base** — the agreed-upon value equals the node's rest-pose transform.
 *
 * This is intentionally conservative: it preserves animation "coverage" so that
 * each clip still claims ownership of the bones it controls, which is critical
 * for correct blending and switching at runtime.
 *
 * Tracks that are individually static but lack cross-animation consensus are
 * counted and reported but **not** removed.
 *
 * @param tolerance - Maximum per-component difference to consider two values equal.
 * @returns A glTF-Transform `Transform` function.
 */
export function removeStaticTracksWithBake(tolerance = 1e-6): Transform {
	return (doc: Document): void => {
		let removedTracks: number = 0;
		let skippedNoConsensus: number = 0;

		const animations: Animation[] = doc.getRoot().listAnimations();
		if (animations.length === 0) return;

		// Pass 1: Analyze every channel across all animations
		// For each node+path, collect: is each channel static? what's its value?
		// Key: "nodeIndex::path"  (use index for uniqueness, not name)
		const nodeIndexMap = new Map<
			ReturnType<typeof doc.getRoot>['listNodes'] extends () => (infer N)[]
				? N
				: never,
			number
		>();
		for (const [i, node] of doc.getRoot().listNodes().entries()) {
			nodeIndexMap.set(node, i);
		}

		interface TrackInfo {
			isStatic: boolean;
			staticValue: number[] | null;
		}

		// node+path → per-animation track info
		const globalTrackMap = new Map<string, TrackInfo[]>();
		// Also count total channels per node+path (including dynamic ones)
		const totalChannelCount = new Map<string, number>();

		for (const animation of animations) {
			for (const channel of animation.listChannels()) {
				const sampler: AnimationSampler | null = channel.getSampler();
				const targetNode: Node | null = channel.getTargetNode();
				const targetPath: GLTF.AnimationChannelTargetPath | null =
					channel.getTargetPath();
				if (!sampler || !targetNode || !targetPath) continue;

				const nodeIdx: number = nodeIndexMap.get(targetNode) ?? -1;
				const key = `${nodeIdx}::${targetPath}`;
				totalChannelCount.set(key, (totalChannelCount.get(key) || 0) + 1);

				const output: Accessor | null = sampler.getOutput();
				if (!output) continue;

				const outputArray: TypedArray | null = output.getArray();
				if (!outputArray || outputArray.length === 0) continue;

				const elementSize: number = output.getElementSize();
				const keyframeCount: number = outputArray.length / elementSize;

				// Check if all keyframes are identical
				let isStatic: boolean = true;
				const firstValues: number[] = Array.from(
					outputArray.slice(0, elementSize),
				);

				if (keyframeCount > 1) {
					for (let i: number = 1; i < keyframeCount && isStatic; i++) {
						for (let j: number = 0; j < elementSize; j++) {
							if (
								Math.abs(
									at(outputArray, i * elementSize + j) - at(firstValues, j),
								) > tolerance
							) {
								isStatic = false;
								break;
							}
						}
					}
				}

				let trackList = globalTrackMap.get(key);
				if (!trackList) {
					trackList = [];
					globalTrackMap.set(key, trackList);
				}
				trackList.push({
					isStatic,
					staticValue: isStatic ? firstValues : null,
				});
			}
		}

		// Pass 2: Determine which node+paths have global consensus
		const removableKeys = new Set<string>();

		for (const [key, tracks] of globalTrackMap) {
			// ALL channels for this node+path must be static
			if (tracks.some((t: TrackInfo): boolean => !t.isStatic)) continue;

			// All static values must agree
			const firstTrack = tracks[0];
			if (!firstTrack) continue;
			const reference = firstTrack.staticValue;
			if (!reference) continue;
			const allAgree: boolean = tracks.every((t: TrackInfo): boolean => {
				if (!t.staticValue || t.staticValue.length !== reference.length) {
					return false;
				}
				return t.staticValue.every(
					(v: number, i: number): boolean =>
						Math.abs(v - at(reference, i)) <= tolerance,
				);
			});
			if (!allAgree) continue;

			// The consensus value must match the node's base transform
			const [nodeIdxStr, path] = key.split('::');
			if (!nodeIdxStr || !path) continue;
			const nodeIdx: number = parseInt(nodeIdxStr, 10);
			const allNodes: Node[] = doc.getRoot().listNodes();
			if (nodeIdx < 0 || nodeIdx >= allNodes.length) continue;
			const node = allNodes[nodeIdx];
			if (!node) continue;

			let baseValue: number[] | null = null;
			switch (path) {
				case 'translation':
					baseValue = Array.from(node.getTranslation());
					break;
				case 'rotation':
					baseValue = Array.from(node.getRotation());
					break;
				case 'scale':
					baseValue = Array.from(node.getScale());
					break;
				case 'weights': {
					const mesh: Mesh | null = node.getMesh();
					if (mesh) baseValue = mesh.getWeights();
					break;
				}
			}

			const matchesBase: boolean =
				baseValue !== null &&
				baseValue.length === reference.length &&
				baseValue.every(
					(v: number, i: number): boolean =>
						Math.abs(v - at(reference, i)) <= tolerance,
				);

			if (matchesBase) {
				removableKeys.add(key);
			}
		}

		// Pass 3: Remove only globally-consensed tracks
		for (const animation of animations) {
			for (const channel of animation.listChannels()) {
				const targetNode: Node | null = channel.getTargetNode();
				const targetPath: GLTF.AnimationChannelTargetPath | null =
					channel.getTargetPath();
				if (!targetNode || !targetPath) continue;

				const nodeIdx: number = nodeIndexMap.get(targetNode) ?? -1;
				const key = `${nodeIdx}::${targetPath}`;

				if (removableKeys.has(key)) {
					const sampler: AnimationSampler | null = channel.getSampler();
					channel.dispose();
					if (sampler && sampler.listParents().length <= 1) sampler.dispose();
					removedTracks++;
				} else {
					// Check if this specific track is static but didn't reach consensus
					const sampler: AnimationSampler | null = channel.getSampler();
					const output: Accessor | null | undefined = sampler?.getOutput();
					const outputArray: TypedArray | null | undefined = output?.getArray();
					if (outputArray && output) {
						const elementSize: number = output.getElementSize();
						const keyframeCount: number = outputArray.length / elementSize;
						if (keyframeCount > 1) {
							let isStatic: boolean = true;
							for (let i: number = 1; i < keyframeCount && isStatic; i++) {
								for (let j: number = 0; j < elementSize; j++) {
									if (
										Math.abs(
											at(outputArray, i * elementSize + j) - at(outputArray, j),
										) > tolerance
									) {
										isStatic = false;
									}
								}
							}
							if (isStatic) skippedNoConsensus++;
						}
					}
				}
			}
		}

		if (removedTracks > 0 || skippedNoConsensus > 0) {
			const parts: string[] = [
				`${removedTracks} tracks removed (global consensus)`,
			];
			if (skippedNoConsensus > 0) {
				parts.push(`${skippedNoConsensus} kept (no consensus)`);
			}
			console.log(`  removeStaticTracks: ${parts.join(', ')}`);
		}
	};
}

/**
 * Diagnostic transform that logs animation statistics to the console.
 *
 * Reports total animation clip count, channel count, and keyframe count.
 * This transform is read-only — it does not modify the document.
 *
 * @returns A glTF-Transform `Transform` function.
 */
export function analyzeAnimations(): Transform {
	return (doc: Document): void => {
		const animations: Animation[] = doc.getRoot().listAnimations();
		if (animations.length === 0) return;

		let totalKeyframes: number = 0;
		let totalChannels: number = 0;

		for (const animation of animations) {
			const channels: AnimationChannel[] = animation.listChannels();
			totalChannels += channels.length;

			for (const channel of channels) {
				const sampler: AnimationSampler | null = channel.getSampler();
				const input: Accessor | null | undefined = sampler?.getInput();
				if (input) totalKeyframes += input.getCount();
			}
		}

		console.log(
			`  Animations: ${animations.length} clips, ${totalChannels} channels, ${totalKeyframes.toLocaleString()} keyframes`,
		);
	};
}
