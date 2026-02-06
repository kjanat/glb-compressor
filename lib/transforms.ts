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

/**
 * Merge vertices by position within a distance tolerance (like Blender's "Merge by Distance").
 * Unlike glTF-Transform's weld(), this only compares positions, ignoring normals/UVs.
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
					const x: number = Math.round(positions[i * 3] * precision);
					const y: number = Math.round(positions[i * 3 + 1] * precision);
					const z: number = Math.round(positions[i * 3 + 2] * precision);
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
					newIndices[i] = remap[indices[i]];
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
					) => typeof oldArray;
					const newArray: TypedArray = new TypedArrayCtor(
						newToOld.length * itemSize,
					)!;

					for (let i: number = 0; i < newToOld.length; i++) {
						const oldIdx: number = newToOld[i];
						for (let j: number = 0; j < itemSize; j++) {
							newArray[i * itemSize + j] = oldArray[oldIdx * itemSize + j];
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
 * Auto-decimate bloated meshes (like notso-glb's bloat detection).
 * Meshes with vertex count > threshold get simplified.
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
 * Remove unused texture coordinates (UV maps not referenced by materials).
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
						const idx: number = parseInt(semantic.split('_')[1], 10);
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
 * Normalize bone weights so they sum to exactly 1.0.
 * Fixes ACCESSOR_WEIGHTS_NON_NORMALIZED validation errors.
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
						sum += arr[i * elementSize + j];
					}
					if (sum > 0 && Math.abs(sum - 1.0) > 1e-6) {
						for (let j: number = 0; j < elementSize; j++) {
							arr[i * elementSize + j] /= sum;
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
 * Log mesh complexity analysis (like notso-glb's bloat warnings).
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
 * Remove degenerate (zero-area) triangles.
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
					const i0: number = indices[i],
						i1: number = indices[i + 1],
						i2: number = indices[i + 2];

					// Skip if indices are the same (degenerate)
					if (i0 === i1 || i1 === i2 || i0 === i2) {
						totalRemoved++;
						continue;
					}

					// Get vertices
					const v0: number[] = [
						positions[i0 * 3],
						positions[i0 * 3 + 1],
						positions[i0 * 3 + 2],
					];
					const v1: number[] = [
						positions[i1 * 3],
						positions[i1 * 3 + 1],
						positions[i1 * 3 + 2],
					];
					const v2: number[] = [
						positions[i2 * 3],
						positions[i2 * 3 + 1],
						positions[i2 * 3 + 2],
					];

					// Compute triangle area via cross product
					const ax: number = v1[0] - v0[0],
						ay: number = v1[1] - v0[1],
						az: number = v1[2] - v0[2];
					const bx: number = v2[0] - v0[0],
						by: number = v2[1] - v0[1],
						bz: number = v2[2] - v0[2];
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
 * Remove static animation tracks using global consensus.
 *
 * A track is only removed if ALL of these conditions are met for a given node+path:
 *   1. Every animation that targets this node+path has a static track (all keyframes identical)
 *   2. All those static values agree (same value across every animation)
 *   3. That consensus value matches the node's base transform
 *
 * This preserves animation "coverage" — each animation still claims ownership of the
 * bones it controls, which is critical for correct blending/switching at runtime.
 */
export function removeStaticTracksWithBake(tolerance = 1e-6): Transform {
	return (doc: Document): void => {
		let removedTracks: number = 0;
		let skippedNoConsensus: number = 0;

		const animations: Animation[] = doc.getRoot().listAnimations();
		if (animations.length === 0) return;

		// ── Pass 1: Analyze every channel across all animations ──────────
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
								Math.abs(outputArray[i * elementSize + j] - firstValues[j]) >
								tolerance
							) {
								isStatic = false;
								break;
							}
						}
					}
				}

				if (!globalTrackMap.has(key)) globalTrackMap.set(key, []);
				globalTrackMap.get(key)!.push({
					isStatic,
					staticValue: isStatic ? firstValues : null,
				});
			}
		}

		// ── Pass 2: Determine which node+paths have global consensus ────
		const removableKeys = new Set<string>();

		for (const [key, tracks] of globalTrackMap) {
			// ALL channels for this node+path must be static
			if (tracks.some((t: TrackInfo): boolean => !t.isStatic)) continue;

			// All static values must agree
			const reference: number[] = tracks[0].staticValue!;
			const allAgree: boolean = tracks.every((t: TrackInfo): boolean => {
				if (!t.staticValue || t.staticValue.length !== reference.length) {
					return false;
				}
				return t.staticValue.every(
					(v: number, i: number): boolean =>
						Math.abs(v - reference[i]) <= tolerance,
				);
			});
			if (!allAgree) continue;

			// The consensus value must match the node's base transform
			const [nodeIdxStr, path] = key.split('::');
			const nodeIdx: number = parseInt(nodeIdxStr, 10);
			const allNodes: Node[] = doc.getRoot().listNodes();
			if (nodeIdx < 0 || nodeIdx >= allNodes.length) continue;
			const node = allNodes[nodeIdx];

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
						Math.abs(v - reference[i]) <= tolerance,
				);

			if (matchesBase) {
				removableKeys.add(key);
			}
		}

		// ── Pass 3: Remove only globally-consensed tracks ────────────────
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
											outputArray[i * elementSize + j] - outputArray[j],
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
 * Log animation statistics.
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
