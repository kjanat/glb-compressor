/**
 * Core compression pipeline — the main entry point for GLB optimization.
 *
 * Orchestrates a multi-phase pipeline of glTF-Transform transforms followed by
 * a final binary compression pass via `gltfpack` (preferred) or meshoptimizer
 * WASM (fallback). Automatically detects skinned models and takes a conservative
 * transform path to protect skeleton hierarchies.
 *
 * @example
 * ```ts
 * import { compress, init } from './compress';
 *
 * await init();
 * const result = await compress(glbBytes, { preset: 'aggressive' });
 * await Bun.write('out.glb', result.buffer);
 * ```
 *
 * @module compress
 */

import { join } from 'node:path';
import { type Document, NodeIO, type Transform } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as transform from '@gltf-transform/functions';
import { $ } from 'bun';
import draco3d from 'draco3dgltf';
import {
	MeshoptDecoder,
	MeshoptEncoder,
	MeshoptSimplifier,
} from 'meshoptimizer';
import sharp from 'sharp';

import {
	COMPRESSION_EXTENSIONS,
	GLTFPACK_TIMEOUT_MS,
	INSTANCE_MIN,
	MERGE_TOLERANCE,
	MESH_WARN_THRESHOLD,
	TEXTURE_MAX_SIZE,
	TOTAL_WARN_THRESHOLD,
} from './constants';
import {
	analyzeMeshComplexity,
	decimateBloatedMeshes,
	mergeByDistance,
	normalizeWeights,
	removeDegenerateFaces,
	removeStaticTracksWithBake,
	removeUnusedUVs,
} from './transforms';
import { formatBytes, withTempDir } from './utils';

/**
 * Compression preset controlling gltfpack flags.
 *
 * - `default`  — conservative, preserves all detail
 * - `balanced` — moderate animation quantization, 24Hz resample
 * - `aggressive` — strong animation quantization, 15Hz resample (best tested for skinned avatars)
 * - `max` — aggressive + supercompression + lower vertex precision
 */
export type CompressPreset = 'default' | 'balanced' | 'aggressive' | 'max';

interface GltfpackPresetConfig {
	/** Extra gltfpack flags for skinned models */
	skinned: string[];
	/** Extra gltfpack flags for non-skinned models */
	static: string[];
}

/**
 * gltfpack flag presets, benchmarked against a 30MB skinned avatar (77 anims, 89k verts).
 *
 * Results on owen.glb:
 *   default    → 5.95 MB (-80.4%)
 *   balanced   → 5.37 MB (-82.3%)
 *   aggressive → 4.83 MB (-84.1%)  ← best quality/size for skinned avatars
 *   max        → 4.77 MB (-84.3%)  ← smallest, drops -kn (normals requantized)
 */
export const PRESETS: Record<CompressPreset, GltfpackPresetConfig> = {
	default: {
		// biome-ignore format: align cli flags with the values
		skinned: [
			'-vp', '20',
			'-kn'
		],
		// biome-ignore format: align cli flags with the values
		static: [
			'-vp', '16'
		],
	},
	balanced: {
		// biome-ignore format: align cli flags with the values
		skinned: [
			"-vp", "20",
			"-kn",
			"-at", "14",
			"-ar", "10",
			"-as", "14",
			"-af", "24",
		],
		// biome-ignore format: align cli flags with the values
		static: [
			'-vp', '16',
			'-at', '14',
			'-ar', '10',
			'-as', '14',
			'-af', '24'
		],
	},
	aggressive: {
		// biome-ignore format: align cli flags with the values
		skinned: [
			'-vp', '20',
			'-kn',
			'-at', '12',
			'-ar', '8',
			'-as', '12',
			'-af', '15',
		],
		// biome-ignore format: align cli flags with the values
		static: [
			'-vp', '14',
			'-at', '12',
			'-ar', '8',
			'-as', '12',
			'-af', '15'
		],
	},
	max: {
		// biome-ignore format: align cli flags with the values
		skinned: [
			'-cz',
			'-vp', '14',
			'-at', '12',
			'-ar', '8',
			'-as', '12',
			'-af', '15',
			'-si', '0.95',
			'-slb',
		],
		// biome-ignore format: align cli flags with the values
		static: [
			'-cz',
			'-vp', '14',
			'-at', '12',
			'-ar', '8',
			'-as', '12',
			'-af', '15',
			'-si', '0.95',
			'-slb',
		],
	},
};

/**
 * Options for the {@link compress} function.
 */
export interface CompressOptions {
	/**
	 * Additional mesh simplification ratio applied after all other transforms.
	 * Must be in `(0, 1)` — e.g. `0.5` keeps ~50% of vertices. Omit to skip.
	 */
	simplifyRatio?: number;

	/**
	 * Callback invoked with progress log messages during compression.
	 * Used by the SSE streaming endpoint to forward real-time updates.
	 */
	onLog?: (msg: string) => void;

	/** Suppress all `console.log` output (for quiet/script mode). */
	quiet?: boolean;

	/**
	 * Named compression preset controlling gltfpack flags.
	 * @default "default"
	 */
	preset?: CompressPreset;
}

/**
 * Result returned by {@link compress}.
 */
export interface CompressResult {
	/** The compressed GLB binary. */
	buffer: Uint8Array;

	/** Compression backend used: `"gltfpack"` or `"meshopt"`. */
	method: string;

	/** Original input size in bytes (set by {@link compress}, not the backend). */
	originalSize?: number;
}

let io: NodeIO;
let hasGltfpack: boolean = false;

// Pre-warm init on module load (eliminates cold start latency)
const initPromise: Promise<void> = doInit().catch((err) => {
	console.error('Init failed:', err);
	process.exit(1);
});

/**
 * Ensure all WASM modules (Draco, Meshopt) and the I/O layer are initialized.
 *
 * This is called automatically by {@link compress}, but can be called ahead of
 * time to eliminate cold-start latency (e.g. at server boot). The returned
 * promise is shared — multiple calls are safe and free.
 */
export async function init(): Promise<void> {
	return initPromise;
}

/**
 * Internal initialization — pre-warms Meshopt WASM, Draco WASM, configures
 * the glTF-Transform I/O with all extensions, and probes for the `gltfpack` binary.
 */
async function doInit(): Promise<void> {
	await Promise.all([
		MeshoptDecoder.ready,
		MeshoptEncoder.ready,
		MeshoptSimplifier.ready,
	]);

	const [dracoEncoder, dracoDecoder] = await Promise.all([
		draco3d.createEncoderModule(),
		draco3d.createDecoderModule(),
	]);

	io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
		'draco3d.encoder': dracoEncoder,
		'draco3d.decoder': dracoDecoder,
		'meshopt.encoder': MeshoptEncoder,
		'meshopt.decoder': MeshoptDecoder,
	});

	console.log('Initialized glTF-Transform with Draco + Meshopt');

	try {
		const gltfpackBin = Bun.which('gltfpack');
		if (!gltfpackBin) {
			console.warn('gltfpack not found, will use meshopt fallback');
		} else {
			const version =
				(await $`gltfpack -v`.text()).trim().split(/\s/, 2)[1] || 'unknown';
			if (version === 'unknown')
				console.warn('Could not determine gltfpack version');
			else console.log('gltfpack:', version);
			hasGltfpack = true;
		}
	} catch {
		console.warn('gltfpack not found, will use meshopt fallback');
	}
}

/**
 * Remove Draco and Meshopt compression extension markers from the document.
 *
 * By this point the I/O layer has already decoded the compressed data — these
 * extensions are metadata-only. Stripping them avoids conflicts when
 * re-compressing with a different backend.
 */
function stripCompressionExtensions(document: Document): void {
	for (const ext of document.getRoot().listExtensionsUsed()) {
		if (COMPRESSION_EXTENSIONS.includes(ext.extensionName)) {
			console.log(`  Removing extension: ${ext.extensionName}`);
			ext.dispose();
		}
	}
}

/**
 * Compress a GLB binary through the full multi-phase optimization pipeline.
 *
 * **Pipeline phases:**
 * 1. Cleanup — dedup, prune, remove unused UVs (+ flatten/join/weld for static models)
 * 2. Geometry — merge by distance, remove degenerate faces, auto-decimate (static only)
 * 3. GPU — instancing, vertex reorder (static only), sparse encoding
 * 4. Animation — resample keyframes, remove static tracks, normalize weights (skinned only)
 * 5. Textures — compress to WebP via sharp (max 1024x1024)
 * 6. Final — gltfpack subprocess (preferred) or meshopt WASM (fallback)
 *
 * Skinned models automatically take a conservative path that skips transforms
 * known to break skeleton hierarchies or denormalize vertex weights.
 *
 * @param input   - Raw GLB file bytes.
 * @param options - Compression options (preset, simplify ratio, logging).
 * @returns Compressed GLB buffer, compression method used, and original size.
 * @throws {Error} If the input cannot be parsed as valid GLB/glTF.
 */
export async function compress(
	input: Uint8Array,
	options: CompressOptions = {},
): Promise<CompressResult> {
	function log(msg: string): void {
		if (!options.quiet) console.log(msg);
		options.onLog?.(msg);
	}

	await init();

	let document: Document;
	try {
		document = await io.readBinary(input);
	} catch (err) {
		throw new Error(
			`Failed to parse GLB/glTF: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Debug: save immediately after read (before any transforms)
	if (process.env.DEBUG_RAW) {
		const rawBuffer = await io.writeBinary(document);
		await Bun.write('/tmp/debug-raw.glb', rawBuffer);
		log(
			`  Debug: saved /tmp/debug-raw.glb (${formatBytes(rawBuffer.byteLength)})`,
		);
	}

	// Strip existing compression (already decoded by NodeIO), then clean up geometry
	stripCompressionExtensions(document);

	// Check for skinned meshes - skip transforms that break skeleton hierarchy
	const hasSkins: boolean = document.getRoot().listSkins().length > 0;

	// BATCHED TRANSFORMS - reduces overhead by combining compatible transforms
	// Phase 1: Analysis + cleanup (sync transforms batched together)
	const cleanupTransforms: Transform[] = [
		analyzeMeshComplexity(MESH_WARN_THRESHOLD, TOTAL_WARN_THRESHOLD),
		transform.dedup(),
		transform.prune(),
		removeUnusedUVs(),
	];

	// For non-skinned models, add geometry optimization transforms
	// NOTE: For skinned models, skip transforms that cause mesh artifacts:
	// - flatten/join: break skeleton hierarchy
	// - weld: merges vertices across mesh boundaries (leg/shoe clipping)
	// - mergeByDistance: breaks vertex weights
	if (!hasSkins) {
		cleanupTransforms.push(
			transform.flatten(),
			transform.join(),
			transform.weld(),
		);
	} else {
		log('  Skinned model detected - using conservative transforms');
	}

	await document.transform(...cleanupTransforms);

	// Phase 2: Geometry processing (non-skinned only)
	if (!hasSkins) {
		await document.transform(
			mergeByDistance(MERGE_TOLERANCE),
			removeDegenerateFaces(),
			transform.prune(),
			// Auto-decimate bloated meshes (>threshold verts)
			decimateBloatedMeshes(MESH_WARN_THRESHOLD, 0.5, MeshoptSimplifier),
		);
	}

	// Phase 3: GPU optimizations (batched)
	const gpuTransforms: Transform[] = [
		transform.instance({ min: INSTANCE_MIN }),
		transform.sparse(),
	];
	// Skip reorder() for skinned models - causes weight denormalization
	if (!hasSkins) {
		gpuTransforms.splice(1, 0, transform.reorder({ encoder: MeshoptEncoder }));
	}
	await document.transform(...gpuTransforms);

	// Phase 4: Animation + weights (batched)
	const animTransforms: Transform[] = [
		transform.resample(),
		removeStaticTracksWithBake(),
	];
	if (hasSkins) {
		animTransforms.push(normalizeWeights());
	}
	await document.transform(...animTransforms);

	// Phase 5: Texture compression (async, separate call required)
	await document.transform(
		transform.textureCompress({
			targetFormat: 'webp',
			encoder: sharp,
			resize: [TEXTURE_MAX_SIZE, TEXTURE_MAX_SIZE],
		}),
	);

	// Final cleanup
	await document.transform(transform.prune());

	// Optional additional mesh simplification (user-requested)
	const { simplifyRatio } = options;
	if (simplifyRatio && simplifyRatio > 0 && simplifyRatio < 1) {
		log(`  User simplify: ${(simplifyRatio * 100).toFixed(0)}%`);
		await document.transform(
			transform.simplify({
				simplifier: MeshoptSimplifier,
				ratio: simplifyRatio,
			}),
		);
	}

	// Write a clean (uncompressed) GLB as input for gltfpack
	const cleanBuffer = await io.writeBinary(document);
	log(`Clean GLB: ${formatBytes(cleanBuffer.byteLength)}`);

	// Debug: save clean GLB for inspection
	if (process.env.DEBUG_CLEAN) {
		await Bun.write('/tmp/debug-clean.glb', cleanBuffer);
		log('  Debug: saved /tmp/debug-clean.glb');
	}

	// Try gltfpack first (better compression), fall back to glTF-Transform meshopt
	const preset = options.preset ?? 'default';
	if (hasGltfpack) {
		log(`  Running gltfpack (preset: ${preset})...`);
		const result = await compressWithGltfpack(cleanBuffer, hasSkins, preset);
		if (result) {
			log(`  gltfpack: ${formatBytes(result.buffer.byteLength)}`);
			return { ...result, originalSize: input.byteLength };
		}
	}

	log('  Running meshopt fallback...');
	const result = await compressWithMeshopt(document, hasSkins);
	log(`  meshopt: ${formatBytes(result.buffer.byteLength)}`);
	return { ...result, originalSize: input.byteLength };
}

/**
 * Compress a clean (uncompressed) GLB using the external `gltfpack` binary.
 *
 * Writes the input to a temp file, spawns `gltfpack` with preset-specific flags
 * (varying by skinned/static), and reads back the output. Returns `null` on any
 * failure so the caller can fall back to the WASM path.
 */
async function compressWithGltfpack(
	cleanBuffer: Uint8Array,
	hasSkins: boolean,
	preset: CompressPreset,
): Promise<CompressResult | null> {
	return withTempDir(async (dir) => {
		const inputPath = join(dir, 'clean.glb');
		const outputPath = join(dir, 'compressed.glb');

		try {
			await Bun.write(inputPath, cleanBuffer);
			const config = PRESETS[preset];
			const presetFlags = hasSkins ? config.skinned : config.static;
			// -cc is the base compression flag (overridden by -cz in some presets)
			const hasCompressFlag = presetFlags.some(
				(f) => f === '-cz' || f === '-c',
			);
			// biome-ignore format: align cli flags with the values
			const args = [
				'gltfpack',
				'-i', inputPath,
				'-o', outputPath,
				...(hasCompressFlag ? [] : ['-cc']),
				'-tc',
				...presetFlags,
			];
			const proc = Bun.spawn(args, {
				stdout: 'ignore',
				stderr: 'pipe',
			});

			const timeoutId = setTimeout(() => proc.kill(), GLTFPACK_TIMEOUT_MS);
			const exitCode = await proc.exited;
			clearTimeout(timeoutId);

			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new Error(`gltfpack exited with code ${exitCode}: ${stderr}`);
			}

			const buffer = new Uint8Array(await Bun.file(outputPath).arrayBuffer());
			console.log(`gltfpack: ${formatBytes(buffer.byteLength)}`);
			return { buffer, method: 'gltfpack' };
		} catch (err) {
			console.warn('gltfpack failed:', err);
			return null;
		}
	});
}

/**
 * Fallback compression using glTF-Transform's meshopt encoder (pure WASM).
 *
 * For static models, applies `quantize()` before `meshopt()` for better
 * compression. For skinned models, skips quantization to avoid vertex
 * deformation artifacts.
 */
async function compressWithMeshopt(
	document: Document,
	hasSkins: boolean,
): Promise<CompressResult> {
	if (hasSkins) {
		// Skip quantize for skinned models to avoid deformation
		await document.transform(transform.meshopt({ encoder: MeshoptEncoder }));
	} else {
		await document.transform(
			transform.quantize(),
			transform.meshopt({ encoder: MeshoptEncoder }),
		);
	}
	const buffer = await io.writeBinary(document);
	console.log(`meshopt fallback: ${formatBytes(buffer.byteLength)}`);
	return { buffer, method: 'meshopt' };
}

export {
	formatBytes,
	parseSimplifyRatio,
	sanitizeFilename,
	validateGlbMagic,
} from './utils';

/** Returns whether the `gltfpack` binary was found during initialization. */
export function getHasGltfpack(): boolean {
	return hasGltfpack;
}
