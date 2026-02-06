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
import { join } from 'node:path';
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
		// biome-ignore format: just because
		skinned: [
			'-vp', '20',
			'-kn'
		],
		// biome-ignore format: just because
		static: [
			'-vp', '16'
		],
	},
	balanced: {
		// biome-ignore format: just because
		skinned: [
			"-vp", "20",
			"-kn",
			"-at", "14",
			"-ar", "10",
			"-as", "14",
			"-af", "24",
		],
		// biome-ignore format: just because
		static: [
			'-vp', '16',
			'-at', '14',
			'-ar', '10',
			'-as', '14',
			'-af', '24'
		],
	},
	aggressive: {
		// biome-ignore format: just because
		skinned: [
			'-vp', '20',
			'-kn',
			'-at', '12',
			'-ar', '8',
			'-as', '12',
			'-af', '15',
		],
		// biome-ignore format: just because
		static: [
			'-vp', '14',
			'-at', '12',
			'-ar', '8',
			'-as', '12',
			'-af', '15'
		],
	},
	max: {
		// biome-ignore format: just because
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
		// biome-ignore format: just because
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

export interface CompressOptions {
	simplifyRatio?: number;
	onLog?: (msg: string) => void;
	/** Skip console.log output (for quiet mode) */
	quiet?: boolean;
	/** Compression preset (default: "default") */
	preset?: CompressPreset;
}

export interface CompressResult {
	buffer: Uint8Array;
	method: string;
	originalSize?: number;
}

let io: NodeIO;
let hasGltfpack: boolean = false;

// Pre-warm init on module load (eliminates cold start latency)
const initPromise: Promise<void> = doInit().catch((err) => {
	console.error('Init failed:', err);
	process.exit(1);
});

export async function init(): Promise<void> {
	return initPromise;
}

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
		const version: string = (await $`gltfpack -v`.text()).trim();
		hasGltfpack = true;
		console.log('gltfpack:', version);
	} catch {
		console.warn('gltfpack not found, will use meshopt fallback');
	}
}

function stripCompressionExtensions(document: Document): void {
	for (const ext of document.getRoot().listExtensionsUsed()) {
		if (COMPRESSION_EXTENSIONS.includes(ext.extensionName)) {
			console.log(`  Removing extension: ${ext.extensionName}`);
			ext.dispose();
		}
	}
}

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
			// biome-ignore format: just because
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
export function getHasGltfpack(): boolean {
	return hasGltfpack;
}
