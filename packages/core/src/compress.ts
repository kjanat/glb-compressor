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
 * await writeFile('out.glb', result.buffer);
 * ```
 *
 * @module compress
 */

import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import type { Document, GLTF, JSONDocument, Transform } from '@gltf-transform/core';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as transform from '@gltf-transform/functions';

import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

import { space } from 'ansispeck';

import {
	COMPRESSION_EXTENSIONS,
	GLB_MAGIC,
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

const execFile = promisify(execFileCallback);

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
		skinned: /* dprint-ignore */ [
			'-vp', '20',
			'-kn',
		],
		static: /* dprint-ignore */ [
			'-vp', '16',
		],
	},
	balanced: {
		skinned: /* dprint-ignore */ [
			'-vp', '20',
			'-kn',
			'-at', '14',
			'-ar', '10',
			'-as', '14',
			'-af', '24',
		],
		static: /* dprint-ignore */ [
			'-vp', '16',
			'-at', '14',
			'-ar', '10',
			'-as', '14',
			'-af', '24',
		],
	},
	aggressive: {
		skinned: /* dprint-ignore */ [
			'-vp', '20',
			'-kn',
			'-at', '12',
			'-ar', '8',
			'-as', '12',
			'-af', '15',
		],
		static: /* dprint-ignore */ [
			'-vp', '14',
			'-at', '12',
			'-ar', '8',
			'-as', '12',
			'-af', '15',
		],
	},
	max: {
		skinned: /* dprint-ignore */ [
			'-cz',
			'-vp', '14',
			'-at', '12',
			'-ar', '8',
			'-as', '12',
			'-af', '15',
			'-si', '0.95',
			'-slb',
		],
		static: /* dprint-ignore */ [
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

	/**
	 * Preserve the node hierarchy, node names and material names, for models
	 * whose parts are moved at runtime by name (spinning wheels, sliding doors).
	 * Skips flatten/join/instance and passes `-kn -km` to gltfpack. Costs some
	 * compression; without it a static model collapses into one anonymous node
	 * with the authored orientation baked into its vertices.
	 */
	keepNodes?: boolean;

	/**
	 * Pre-loaded external resources for `.gltf` input, keyed by uri (raw,
	 * decoded, or basename).
	 */
	resources?: Record<string, Uint8Array>;

	/**
	 * Optional async callback to resolve missing `.gltf` external resources.
	 * Called with each unresolved URI from the parsed glTF JSON.
	 */
	resourceResolver?: (uri: string) => Promise<Uint8Array | undefined>;
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
let gltfpackPath: string | undefined;

async function findExecutable(command: string): Promise<string | undefined> {
	const pathDirectories = (process.env.PATH ?? '').split(delimiter);
	const extensions = process.platform === 'win32'
		? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
		: [''];

	for (const directory of pathDirectories) {
		if (directory.length === 0) continue;
		for (const extension of extensions) {
			const candidate = join(directory, `${command}${extension}`);
			try {
				await access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
				return candidate;
			} catch {
				// Try the next PATH entry.
			}
		}
	}

	return undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isGltfRoot(value: unknown): value is GLTF.IGLTF {
	if (!isObjectRecord(value)) return false;
	const asset = value.asset;
	return isObjectRecord(asset);
}

function getGlbMagic(input: Uint8Array): number | undefined {
	if (input.length < 4) return undefined;
	return new DataView(input.buffer, input.byteOffset, 4).getUint32(0, true);
}

function isDataUri(uri: string): boolean {
	return uri.startsWith('data:');
}

function isRemoteUri(uri: string): boolean {
	return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(uri);
}

function decodeUriComponentSafe(uri: string): string {
	try {
		return decodeURIComponent(uri);
	} catch {
		return uri;
	}
}

function toArrayBufferBacked(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

function getUriBasename(uri: string): string {
	const normalized = uri.replace(/\\/g, '/');
	const lastSegment = normalized.split('/').pop();
	return lastSegment ?? normalized;
}

function collectExternalResourceUris(root: GLTF.IGLTF): string[] {
	const uris = new Set<string>();

	const maybeBuffers = root.buffers;
	if (Array.isArray(maybeBuffers)) {
		for (const item of maybeBuffers) {
			if (!isObjectRecord(item)) continue;
			const uri = item.uri;
			if (typeof uri === 'string' && uri.length > 0) uris.add(uri);
		}
	}

	const maybeImages = root.images;
	if (Array.isArray(maybeImages)) {
		for (const item of maybeImages) {
			if (!isObjectRecord(item)) continue;
			const uri = item.uri;
			if (typeof uri === 'string' && uri.length > 0) uris.add(uri);
		}
	}

	return Array.from(uris).filter((uri): boolean => !isDataUri(uri));
}

async function readInputDocument(input: Uint8Array, options: CompressOptions): Promise<Document> {
	const magic = getGlbMagic(input);
	if (magic === GLB_MAGIC) {
		return io.readBinary(input);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(input));
	} catch {
		throw new Error('Input is neither valid GLB nor valid glTF JSON');
	}

	if (!isGltfRoot(parsed)) {
		throw new Error('Invalid glTF JSON: missing or invalid asset block');
	}

	const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
	for (const uri of collectExternalResourceUris(parsed)) {
		if (isRemoteUri(uri)) {
			throw new Error(`Network resource URI not supported in glTF input: ${uri}`);
		}

		const decodedUri = decodeUriComponentSafe(uri);
		const basename = getUriBasename(decodedUri);
		const fromMap = options.resources?.[uri] ?? options.resources?.[decodedUri] ?? options.resources?.[basename];
		if (fromMap) {
			resources[uri] = toArrayBufferBacked(fromMap);
			continue;
		}

		const resolved = await options.resourceResolver?.(decodedUri);
		if (resolved) {
			resources[uri] = toArrayBufferBacked(resolved);
			continue;
		}

		throw new Error(`Missing external glTF resource: ${uri}`);
	}

	const jsonDoc: JSONDocument = { json: parsed, resources };
	return io.readJSON(jsonDoc);
}

// Pre-warm init on module load (eliminates cold start latency).
// The rejection propagates to callers of init()/compress() so CLI/server
// entry points can decide how to handle it — library consumers aren't killed.
const initPromise: Promise<void> = doInit().catch((err) => {
	console.error('Init failed:', err);
	throw err;
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
	await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);

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
		gltfpackPath = await findExecutable('gltfpack');
		if (gltfpackPath === undefined) {
			console.warn('gltfpack not found in PATH, will use meshopt fallback');
		} else {
			const { stdout } = await execFile(gltfpackPath, ['-v'], { encoding: 'utf8' });
			const version = stdout.trim().split(/\s/, 2)[1] || 'unknown';
			if (version === 'unknown') console.warn('Could not determine gltfpack version');
			else console.log('gltfpack:', version);
			hasGltfpack = true;
		}
	} catch (err) {
		console.warn('gltfpack detection failed:', err instanceof Error ? err.message : err);
		console.warn('Will use meshopt fallback');
	}
}

/**
 * Remove Draco and Meshopt compression extension markers from the document.
 *
 * By this point the I/O layer has already decoded the compressed data — these
 * extensions are metadata-only. Stripping them avoids conflicts when
 * re-compressing with a different backend.
 */
function stripCompressionExtensions(document: Document, log: (msg: string) => void): void {
	for (const ext of document.getRoot().listExtensionsUsed()) {
		if (COMPRESSION_EXTENSIONS.includes(ext.extensionName)) {
			log(`${space(2)}Removing extension: ${ext.extensionName}`);
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
export async function compress(input: Uint8Array, options: CompressOptions = {}): Promise<CompressResult> {
	function log(msg: string): void {
		if (!options.quiet) console.log(msg);
		options.onLog?.(msg);
	}

	await init();

	let document: Document;
	try {
		document = await readInputDocument(input, options);
	} catch (err) {
		throw new Error(`Failed to parse GLB/glTF: ${err instanceof Error ? err.message : String(err)}`);
	}

	// Debug: save immediately after read (before any transforms)
	if (process.env.DEBUG_RAW) {
		const rawBuffer = await io.writeBinary(document);
		await writeFile('/tmp/debug-raw.glb', rawBuffer);
		log(`${space(2)}Debug: saved /tmp/debug-raw.glb (${formatBytes(rawBuffer.byteLength)})`);
	}

	// Strip existing compression (already decoded by NodeIO), then clean up geometry
	stripCompressionExtensions(document, log);

	// Check for skinned meshes - skip transforms that break skeleton hierarchy
	const hasSkins: boolean = document.getRoot().listSkins().length > 0;

	const keepNodes: boolean = options.keepNodes === true;

	// BATCHED TRANSFORMS - reduces overhead by combining compatible transforms
	// Phase 1: Analysis + cleanup (sync transforms batched together)
	// dedup() merges equal-property materials whatever they are called; under
	// keepNodes those names are the runtime lookup key, so uniquely named
	// duplicates stay.
	const cleanupTransforms: Transform[] = [
		analyzeMeshComplexity(MESH_WARN_THRESHOLD, TOTAL_WARN_THRESHOLD),
		transform.dedup(keepNodes ? { keepUniqueNames: true } : {}),
		transform.prune(),
		removeUnusedUVs(),
	];

	// For non-skinned models, add geometry optimization transforms
	// NOTE: For skinned models, skip transforms that cause mesh artifacts:
	// - flatten/join: break skeleton hierarchy
	// - weld: merges vertices across mesh boundaries (leg/shoe clipping)
	// - mergeByDistance: breaks vertex weights
	// With keepNodes, flatten/join stay off for the same reason the skinned
	// path skips them: the node hierarchy is load-bearing at runtime.
	if (!hasSkins && !keepNodes) {
		cleanupTransforms.push(transform.flatten(), transform.join(), transform.weld());
	} else if (!hasSkins) {
		log(`${space(2)}keepNodes - preserving node hierarchy and names`);
		cleanupTransforms.push(transform.weld());
	} else {
		log(`${space(2)}Skinned model detected - using conservative transforms`);
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
	// Skip reorder() for skinned models - causes weight denormalization
	// Skip instance() with keepNodes: it replaces the named nodes that share a
	// mesh (a dedup'd pair of wheels) with one anonymous instancing node.
	const gpuTransforms: Transform[] = [
		...(keepNodes ? [] : [transform.instance({ min: INSTANCE_MIN })]),
		...(!hasSkins ? [transform.reorder({ encoder: MeshoptEncoder })] : []),
		transform.sparse(),
	];
	await document.transform(...gpuTransforms);

	// Phase 4: Animation + weights (batched)
	const animTransforms: Transform[] = [transform.resample(), removeStaticTracksWithBake()];
	if (hasSkins) animTransforms.push(normalizeWeights());
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
		log(`${space(2)}User simplify: ${(simplifyRatio * 100).toFixed(0)}%`);
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
		await writeFile('/tmp/debug-clean.glb', cleanBuffer);
		log(`${space(2)}Debug: saved /tmp/debug-clean.glb`);
	}

	// Try gltfpack first (better compression), fall back to glTF-Transform meshopt
	const preset = options.preset ?? 'default';
	if (hasGltfpack) {
		log(`${space(2)}Running gltfpack (preset: ${preset})...`);
		const result = await compressWithGltfpack(cleanBuffer, hasSkins, preset, keepNodes, log);
		if (result) {
			log(`${space(2)}gltfpack: ${formatBytes(result.buffer.byteLength)}`);
			return { ...result, originalSize: input.byteLength };
		}
	}

	log(`${space(2)}Running meshopt fallback...`);
	const result = await compressWithMeshopt(document, hasSkins, log);

	log(`${space(2)}meshopt: ${formatBytes(result.buffer.byteLength)}`);
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
	keepNodes: boolean,
	log: (msg: string) => void,
): Promise<CompressResult | null> {
	return withTempDir(async (dir) => {
		const inputPath = join(dir, 'clean.glb');
		const outputPath = join(dir, 'compressed.glb');

		try {
			await writeFile(inputPath, cleanBuffer);
			const config = PRESETS[preset];
			const presetFlags = hasSkins ? config.skinned : config.static;
			// -cc is the base compression flag (overridden by -cz in some presets)
			const hasCompressFlag = presetFlags.some((f) => f === '-cz' || f === '-c');
			// gltfpack merges everything it may: -kn keeps named nodes, -km keeps
			// the materials runtime code looks up by name.
			const keepFlags = keepNodes ? [...(presetFlags.includes('-kn') ? [] : ['-kn']), '-km'] : [];
			const args = /* dprint-ignore */ [
				'-i', inputPath,
				'-o', outputPath,
				...(hasCompressFlag ? [] : ['-cc']),
				'-tc',
				...presetFlags,
				...keepFlags,
			];
			if (gltfpackPath === undefined) throw new Error('gltfpack executable is unavailable');
			await execFile(gltfpackPath, args, { timeout: GLTFPACK_TIMEOUT_MS });

			const buffer = new Uint8Array(await readFile(outputPath));
			log(`gltfpack: ${formatBytes(buffer.byteLength)}`);
			return { buffer, method: 'gltfpack' };
		} catch (err) {
			log(`gltfpack failed: ${err instanceof Error ? err.message : err}`);
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
	log: (msg: string) => void,
): Promise<CompressResult> {
	if (hasSkins) {
		// Skip quantize for skinned models to avoid deformation
		await document.transform(transform.meshopt({ encoder: MeshoptEncoder }));
	} else {
		await document.transform(transform.quantize(), transform.meshopt({ encoder: MeshoptEncoder }));
	}
	const buffer = await io.writeBinary(document);
	log(`meshopt fallback: ${formatBytes(buffer.byteLength)}`);
	return { buffer, method: 'meshopt' };
}

/** Returns whether the `gltfpack` binary was found during initialization. */
export function getHasGltfpack(): boolean {
	return hasGltfpack;
}
