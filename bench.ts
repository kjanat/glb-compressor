#!/usr/bin/env bun
/**
 * Compression benchmark: runs multiple optimization variants against a GLB file.
 * Outputs each variant to public/models/ for visual comparison.
 * Runs 3 variants in parallel for speed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Document, NodeIO, type Transform } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as transform from '@gltf-transform/functions';
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
	MESH_WARN_THRESHOLD,
	TEXTURE_MAX_SIZE,
	TOTAL_WARN_THRESHOLD,
} from '$lib/constants';
import {
	analyzeMeshComplexity,
	normalizeWeights,
	removeStaticTracksWithBake,
	removeUnusedUVs,
} from '$lib/transforms';
import { formatBytes } from '$lib/utils';

const INPUT = join(import.meta.dir, '$models/owen.glb');
const OUT_DIR = join(import.meta.dir, '$models');
const PARALLEL = 3;

// ─── Init ───────────────────────────────────────────────────────────────────

let io: NodeIO;

async function init() {
	await Promise.all([
		MeshoptDecoder.ready,
		MeshoptEncoder.ready,
		MeshoptSimplifier.ready,
	]);
	const [enc, dec] = await Promise.all([
		draco3d.createEncoderModule(),
		draco3d.createDecoderModule(),
	]);
	io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
		'draco3d.encoder': enc,
		'draco3d.decoder': dec,
		'meshopt.encoder': MeshoptEncoder,
		'meshopt.decoder': MeshoptDecoder,
	});
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripCompression(doc: Document) {
	for (const ext of doc.getRoot().listExtensionsUsed()) {
		if (COMPRESSION_EXTENSIONS.includes(ext.extensionName)) ext.dispose();
	}
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), 'bench-'));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function runGltfpack(
	cleanBuf: Uint8Array,
	extraArgs: string[],
): Promise<Uint8Array> {
	return withTmp(async (dir) => {
		const inp = join(dir, 'in.glb'),
			out = join(dir, 'out.glb');
		await Bun.write(inp, cleanBuf);
		const args = ['gltfpack', '-i', inp, '-o', out, ...extraArgs];
		const proc = Bun.spawn(args, { stdout: 'ignore', stderr: 'pipe' });
		const tid = setTimeout(() => proc.kill(), GLTFPACK_TIMEOUT_MS);
		const code = await proc.exited;
		clearTimeout(tid);
		if (code !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`gltfpack failed (${code}): ${stderr}`);
		}
		return new Uint8Array(await Bun.file(out).arrayBuffer());
	});
}

// ─── Shared pre-processing ─────────────────────────────────────────────────

interface PreProcessOptions {
	resampleTolerance?: number;
	weldExact?: boolean;
	reorderSkinned?: boolean;
	quantizeSkinned?: boolean;
	quantizeOpts?: {
		quantizePosition?: number;
		quantizeNormal?: number;
		quantizeTexcoord?: number;
	};
	skipWebp?: boolean;
	textureMaxSize?: number;
}

async function preProcess(
	input: Uint8Array,
	opts: PreProcessOptions = {},
): Promise<Uint8Array> {
	const doc = await io.readBinary(input);
	stripCompression(doc);

	const hasSkins = doc.getRoot().listSkins().length > 0;

	// Phase 1: cleanup
	const cleanup: Transform[] = [
		analyzeMeshComplexity(MESH_WARN_THRESHOLD, TOTAL_WARN_THRESHOLD),
		transform.dedup(),
		transform.prune(),
		removeUnusedUVs(),
	];
	if (!hasSkins) {
		cleanup.push(transform.flatten(), transform.join(), transform.weld());
	} else if (opts.weldExact) {
		cleanup.push(transform.weld());
	}
	await doc.transform(...cleanup);

	// Phase 2: GPU opts
	const gpu: Transform[] = [
		transform.instance({ min: INSTANCE_MIN }),
		transform.sparse(),
	];
	if (!hasSkins || opts.reorderSkinned) {
		gpu.splice(1, 0, transform.reorder({ encoder: MeshoptEncoder }));
	}
	await doc.transform(...gpu);

	// Phase 3: Animation
	const anim: Transform[] = [
		transform.resample({ tolerance: opts.resampleTolerance }),
		removeStaticTracksWithBake(),
	];
	if (hasSkins) anim.push(normalizeWeights());
	await doc.transform(...anim);

	// Phase 4: Texture
	if (!opts.skipWebp) {
		const maxSz = opts.textureMaxSize ?? TEXTURE_MAX_SIZE;
		await doc.transform(
			transform.textureCompress({
				targetFormat: 'webp',
				encoder: sharp,
				resize: [maxSz, maxSz],
			}),
		);
	}

	// Phase 5: Quantize (optionally for skins)
	if (opts.quantizeSkinned && hasSkins) {
		await doc.transform(transform.quantize(opts.quantizeOpts ?? {}));
	}

	await doc.transform(transform.prune());

	return await io.writeBinary(doc);
}

// ─── Variant Definitions ────────────────────────────────────────────────────

interface Variant {
	name: string;
	description: string;
	preOpts?: PreProcessOptions;
	gltfpackArgs: string[];
}

// Base gltfpack args used across most variants
const BASE = ['-cc', '-tc', '-vp', '20', '-kn'];
const ANIM_Q = ['-at', '14', '-ar', '10', '-as', '14'];
const ANIM_Q_AGGRO = ['-at', '12', '-ar', '8', '-as', '12'];

const variants: Variant[] = [
	// ──── Round 1 (kept from previous run) ────────────────────────────────
	{
		name: '00-baseline',
		description: 'Current pipeline (as-is)',
		gltfpackArgs: [...BASE],
	},
	{
		name: '01-anim-quant',
		description: 'Anim quant: -at 14 -ar 10 -as 14',
		gltfpackArgs: [...BASE, ...ANIM_Q],
	},
	{
		name: '02-anim-quant-aggro',
		description: 'Aggro anim quant: -at 12 -ar 8 -as 12',
		gltfpackArgs: [...BASE, ...ANIM_Q_AGGRO],
	},
	{
		name: '03-anim-24hz',
		description: 'Resample 24Hz: -af 24',
		gltfpackArgs: [...BASE, '-af', '24'],
	},
	{
		name: '04-anim-quant-24hz',
		description: 'Anim quant + 24Hz',
		gltfpackArgs: [...BASE, ...ANIM_Q, '-af', '24'],
	},

	// ──── Round 2: Animation deep dive ────────────────────────────────────
	{
		name: '18-af15',
		description: 'Resample 15Hz: -af 15',
		gltfpackArgs: [...BASE, '-af', '15'],
	},
	{
		name: '19-af0',
		description: 'Disable gltfpack resample: -af 0 (our resample only)',
		gltfpackArgs: [...BASE, '-af', '0'],
	},
	{
		name: '20-anim-quant-af15',
		description: 'Anim quant + 15Hz',
		gltfpackArgs: [...BASE, ...ANIM_Q, '-af', '15'],
	},
	{
		name: '21-anim-quant-af0',
		description: 'Anim quant + no gltfpack resample',
		gltfpackArgs: [...BASE, ...ANIM_Q, '-af', '0'],
	},
	{
		name: '22-anim-aggro-af15',
		description: 'Aggro anim quant + 15Hz',
		gltfpackArgs: [...BASE, ...ANIM_Q_AGGRO, '-af', '15'],
	},
	{
		name: '23-anim-aggro-af0',
		description: 'Aggro anim quant + no gltfpack resample',
		gltfpackArgs: [...BASE, ...ANIM_Q_AGGRO, '-af', '0'],
	},

	// ──── Round 2: Vertex precision ───────────────────────────────────────
	{
		name: '24-vp14',
		description: 'Position vp14 (gltfpack default)',
		gltfpackArgs: ['-cc', '-tc', '-vp', '14', '-kn'],
	},
	{
		name: '25-no-kn',
		description: 'Drop -kn, let normals compress at default 8-bit',
		gltfpackArgs: ['-cc', '-tc', '-vp', '20'],
	},
	{
		name: '26-no-kn-vn4',
		description: 'No -kn + aggressive normals -vn 4',
		gltfpackArgs: ['-cc', '-tc', '-vp', '20', '-vn', '4'],
	},
	{
		name: '27-vp14-vt10',
		description: 'Lower position -vp 14 + texcoord -vt 10',
		gltfpackArgs: ['-cc', '-tc', '-vp', '14', '-vt', '10', '-kn'],
	},
	{
		name: '28-vp14-no-kn',
		description: 'vp14 + drop -kn',
		gltfpackArgs: ['-cc', '-tc', '-vp', '14'],
	},

	// ──── Round 2: Compression modes ──────────────────────────────────────
	{
		name: '29-c-basic',
		description: 'Basic meshopt: -c (single, less aggressive)',
		gltfpackArgs: ['-c', '-tc', '-vp', '20', '-kn'],
	},
	{
		name: '30-ce-khr',
		description: 'KHR extension variant: -ce khr',
		gltfpackArgs: ['-cc', '-tc', '-vp', '20', '-kn', '-ce', 'khr'],
	},
	{
		name: '31-cz-anim-quant',
		description: '-cz supercompress + anim quant',
		gltfpackArgs: ['-cz', '-tc', '-vp', '20', '-kn', ...ANIM_Q],
	},

	// ──── Round 2: Simplification ─────────────────────────────────────────
	{
		name: '32-si95',
		description: '5% simplification: -si 0.95 -slb',
		gltfpackArgs: [...BASE, '-si', '0.95', '-slb'],
	},
	{
		name: '33-si90',
		description: '10% simplification: -si 0.9 -slb',
		gltfpackArgs: [...BASE, '-si', '0.9', '-slb'],
	},
	{
		name: '34-si80',
		description: '20% simplification: -si 0.8 -slb -se 0.005',
		gltfpackArgs: [...BASE, '-si', '0.8', '-slb', '-se', '0.005'],
	},
	{
		name: '35-si95-anim-quant',
		description: '5% simplify + anim quant',
		gltfpackArgs: [...BASE, '-si', '0.95', '-slb', ...ANIM_Q],
	},

	// ──── Round 2: Scene opts ─────────────────────────────────────────────
	{
		name: '36-mm',
		description: 'Merge mesh instances: -mm',
		gltfpackArgs: [...BASE, '-mm'],
	},

	// ──── Round 2: Texture (gltfpack-native) ──────────────────────────────
	{
		name: '37-tw',
		description: 'gltfpack WebP: -tw (skip our sharp WebP)',
		preOpts: { skipWebp: true },
		gltfpackArgs: ['-cc', '-tw', '-vp', '20', '-kn'],
	},
	{
		name: '38-tc-color-tu-normal',
		description: 'Per-class: -tc color -tu normal (skip our WebP)',
		preOpts: { skipWebp: true },
		gltfpackArgs: ['-cc', '-tc', 'color', '-tu', 'normal', '-vp', '20', '-kn'],
	},

	// ──── Round 2: Best combos ────────────────────────────────────────────
	{
		name: '39-anim-quant-no-kn',
		description: 'Anim quant + drop -kn (compress normals)',
		gltfpackArgs: ['-cc', '-tc', '-vp', '20', ...ANIM_Q],
	},
	{
		name: '40-anim-quant-si95',
		description: 'Anim quant + 5% simplify',
		gltfpackArgs: [...BASE, ...ANIM_Q, '-si', '0.95', '-slb'],
	},
	{
		name: '41-anim-quant-vp14-cz',
		description: 'Anim quant + vp14 + -cz',
		gltfpackArgs: ['-cz', '-tc', '-vp', '14', '-kn', ...ANIM_Q],
	},
	{
		name: '42-anim-quant-vp14-no-kn',
		description: 'Anim quant + vp14 + no -kn',
		gltfpackArgs: ['-cc', '-tc', '-vp', '14', ...ANIM_Q],
	},
	{
		name: '43-full-send',
		description: 'Anim quant + af15 + vp14 + si95 + cz',
		gltfpackArgs: [
			'-cz',
			'-tc',
			'-vp',
			'14',
			'-kn',
			...ANIM_Q,
			'-af',
			'15',
			'-si',
			'0.95',
			'-slb',
		],
	},
	{
		name: '44-full-send-no-kn',
		description: 'Anim quant + af15 + vp14 + si95 + cz + no -kn',
		gltfpackArgs: [
			'-cz',
			'-tc',
			'-vp',
			'14',
			...ANIM_Q,
			'-af',
			'15',
			'-si',
			'0.95',
			'-slb',
		],
	},
	{
		name: '45-anim-quant-24hz-cz',
		description: 'Anim quant + 24Hz + -cz (safe combo, no pipeline changes)',
		gltfpackArgs: ['-cz', '-tc', '-vp', '20', '-kn', ...ANIM_Q, '-af', '24'],
	},
	{
		name: '46-anim-quant-24hz-no-kn',
		description: 'Anim quant + 24Hz + drop -kn',
		gltfpackArgs: ['-cc', '-tc', '-vp', '20', ...ANIM_Q, '-af', '24'],
	},
	{
		name: '47-anim-aggro-24hz-vp14-cz',
		description: 'Aggro anim + 24Hz + vp14 + -cz (push it)',
		gltfpackArgs: [
			'-cz',
			'-tc',
			'-vp',
			'14',
			'-kn',
			...ANIM_Q_AGGRO,
			'-af',
			'24',
		],
	},
	{
		name: '48-anim-quant-af0-cz',
		description: 'Anim quant + our resample only + -cz',
		gltfpackArgs: ['-cz', '-tc', '-vp', '20', '-kn', ...ANIM_Q, '-af', '0'],
	},
];

// ─── Runner ─────────────────────────────────────────────────────────────────

const c = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	cyan: '\x1b[36m',
	magenta: '\x1b[35m',
};

interface Result {
	name: string;
	desc: string;
	size: number;
	ratio: string;
	time: string;
	error?: string;
}

async function runVariant(
	v: Variant,
	rawInput: Uint8Array,
	originalSize: number,
): Promise<Result> {
	const t0 = performance.now();
	try {
		const cleanBuf = await preProcess(rawInput, v.preOpts);
		const compressed = await runGltfpack(cleanBuf, v.gltfpackArgs);

		const outPath = join(OUT_DIR, `owen-${v.name}.glb`);
		await Bun.write(outPath, compressed);

		const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
		const ratio = ((1 - compressed.byteLength / originalSize) * 100).toFixed(1);

		return {
			name: v.name,
			desc: v.description,
			size: compressed.byteLength,
			ratio,
			time: elapsed,
		};
	} catch (err) {
		const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
		return {
			name: v.name,
			desc: v.description,
			size: -1,
			ratio: 'N/A',
			time: elapsed,
			error: String(err),
		};
	}
}

async function main() {
	console.log(`\n${c.bold}${c.cyan}GLB Compression Benchmark v2${c.reset}\n`);
	console.log(`Parallelism: ${PARALLEL}\n`);

	await init();

	const rawInput = new Uint8Array(await Bun.file(INPUT).arrayBuffer());
	const originalSize = rawInput.byteLength;
	console.log(`Input: ${formatBytes(originalSize)}`);
	console.log(`Variants: ${variants.length}\n`);

	const results: Result[] = [];
	const totalStart = performance.now();

	// Run in batches of PARALLEL
	for (let i = 0; i < variants.length; i += PARALLEL) {
		const batch = variants.slice(i, i + PARALLEL);
		const batchNum = Math.floor(i / PARALLEL) + 1;
		const totalBatches = Math.ceil(variants.length / PARALLEL);

		console.log(`${c.dim}── batch ${batchNum}/${totalBatches} ──${c.reset}`);
		for (const v of batch) {
			console.log(`  ${c.cyan}[${v.name}]${c.reset} ${v.description}`);
		}

		const batchResults = await Promise.all(
			batch.map((v) => runVariant(v, rawInput, originalSize)),
		);

		for (const r of batchResults) {
			if (r.size > 0) {
				console.log(
					`  ${c.green}[${r.name}]${c.reset} ${formatBytes(r.size)} ` +
						`${c.dim}(-${r.ratio}%, ${r.time}s)${c.reset}`,
				);
			} else {
				console.log(
					`  ${c.red}[${r.name}] FAILED${c.reset} ${c.dim}(${r.time}s)${c.reset}: ${r.error}`,
				);
			}
			results.push(r);
		}
		console.log();
	}

	const totalTime = ((performance.now() - totalStart) / 1000).toFixed(1);

	// Summary table
	console.log(`${c.bold}═══ Results Summary ═══${c.reset}\n`);
	console.log(
		`${'Variant'.padEnd(32)} ${'Size'.padStart(10)} ${'Reduction'.padStart(10)} ${'Time'.padStart(8)}  Description`,
	);
	console.log('─'.repeat(110));

	const sorted = [...results]
		.filter((r) => r.size > 0)
		.sort((a, b) => a.size - b.size);
	for (const [i, r] of sorted.entries()) {
		const sizeStr = formatBytes(r.size).padStart(10);
		const ratioStr = `-${r.ratio}%`.padStart(10);
		const timeStr = `${r.time}s`.padStart(8);
		const rank =
			i === 0
				? ` ${c.green}<-- best${c.reset}`
				: i < 3
					? ` ${c.yellow}<-- top3${c.reset}`
					: '';
		console.log(
			`${r.name.padEnd(32)} ${sizeStr} ${ratioStr} ${timeStr}  ${c.dim}${r.desc}${c.reset}${rank}`,
		);
	}

	const failed = results.filter((r) => r.size < 0);
	if (failed.length > 0) {
		console.log(`\n${c.red}Failed (${failed.length}):${c.reset}`);
		for (const r of failed) console.log(`  ${r.name}: ${r.error}`);
	}

	console.log(`\nTotal: ${totalTime}s | Files: ${OUT_DIR}/owen-*.glb\n`);
}

main().catch((err) => {
	console.error(`${c.red}Fatal:${c.reset}`, err);
	process.exit(1);
});
