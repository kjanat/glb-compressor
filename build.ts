#!/usr/bin/env bun
/**
 * Build script — produces three targets:
 *
 *   dist/node/          Node.js ESM  (Bun APIs polyfilled)
 *   dist/bun/           Bun ESM      (minified, sourcemapped)
 *   dist/bun-bytecode/  Bun CJS + .jsc bytecode cache
 */

import { bunPolyfillPlugin } from './build/bun-polyfill-plugin';

const entrypoints = ['./lib/mod.ts', './cli/main.ts', './server/main.ts'];

// Native addons & WASM packages must stay external
const external = ['sharp', 'draco3dgltf', 'meshoptimizer'];

async function build() {
	const start = performance.now();

	// ── 1. Node.js ESM ──────────────────────────────────────
	console.log('Building Node.js ESM...');
	const nodeResult = await Bun.build({
		entrypoints,
		outdir: './dist/node',
		target: 'node',
		format: 'esm',
		splitting: true,
		sourcemap: 'linked',
		minify: false,
		external,
		plugins: [bunPolyfillPlugin()],
		naming: {
			entry: '[dir]/[name].js',
			chunk: 'chunks/[name]-[hash].js',
		},
	});

	if (!nodeResult.success) {
		console.error('Node.js build failed:');
		for (const log of nodeResult.logs) console.error(log);
		process.exit(1);
	}
	console.log(`  ${nodeResult.outputs.length} files`);

	// ── 2. Bun ESM ─────────────────────────────────────────
	console.log('Building Bun ESM...');
	const bunResult = await Bun.build({
		entrypoints,
		outdir: './dist/bun',
		target: 'bun',
		format: 'esm',
		splitting: true,
		sourcemap: 'linked',
		minify: true,
		external,
		naming: {
			entry: '[dir]/[name].js',
			chunk: 'chunks/[name]-[hash].js',
		},
	});

	if (!bunResult.success) {
		console.error('Bun ESM build failed:');
		for (const log of bunResult.logs) console.error(log);
		process.exit(1);
	}
	console.log(`  ${bunResult.outputs.length} files`);

	// ── 3. Bun Bytecode (CJS) ──────────────────────────────
	// Bytecode without --compile requires CJS format.
	// CJS does not support splitting, so each entrypoint is self-contained.
	console.log('Building Bun bytecode (CJS)...');
	const bytecodeResult = await Bun.build({
		entrypoints,
		outdir: './dist/bun-bytecode',
		target: 'bun',
		bytecode: true,
		splitting: false,
		sourcemap: 'none',
		minify: true,
		external,
		naming: {
			entry: '[dir]/[name].js',
		},
	});

	if (!bytecodeResult.success) {
		console.error('Bun bytecode build failed:');
		for (const log of bytecodeResult.logs) console.error(log);
		process.exit(1);
	}
	console.log(`  ${bytecodeResult.outputs.length} files`);

	// ── Summary ─────────────────────────────────────────────
	const elapsed = ((performance.now() - start) / 1000).toFixed(2);
	console.log(`\nDone in ${elapsed}s`);
	console.log(
		`  dist/node/          ${nodeResult.outputs.length} files (Node.js ESM)`,
	);
	console.log(
		`  dist/bun/           ${bunResult.outputs.length} files (Bun ESM)`,
	);
	console.log(
		`  dist/bun-bytecode/  ${bytecodeResult.outputs.length} files (Bun CJS + bytecode)`,
	);
}

build().catch((err) => {
	console.error('Build error:', err);
	process.exit(1);
});
