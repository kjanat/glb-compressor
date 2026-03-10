#!/usr/bin/env bun
/**
 * Build script — produces three targets from the monorepo packages:
 *
 *   dist/node/          Node.js ESM  (Bun APIs polyfilled)
 *   dist/bun/           Bun ESM      (minified, sourcemapped)
 *   dist/bun-bytecode/  Bun CJS + .jsc bytecode cache
 *   dist/types/         TypeScript declarations
 */

import { resolve } from 'node:path';
import { bunPolyfillPlugin } from '@glb-compressor/bun-polyfill/plugin';
import type { BunPlugin } from 'bun';

const entrypoints: string[] = [
	'./packages/core/src/mod.ts',
	'./packages/cli/src/main.ts',
	'./packages/server/src/main.ts',
];

// Native addons & WASM packages must stay external.
const external: string[] = ['sharp', 'draco3dgltf', 'meshoptimizer'];

/**
 * Resolve `@glb-compressor/*` workspace package imports to their source `.ts`
 * files. The bundler's `target: 'node'` uses the `"node"` export condition
 * which points to `dist/` (doesn't exist at build time), so we redirect.
 */
function workspaceResolverPlugin(): BunPlugin {
	const WORKSPACE_MAP: Record<string, string> = {
		'@glb-compressor/core': resolve('./packages/core/src/mod.ts'),
		'@glb-compressor/cli': resolve('./packages/cli/src/main.ts'),
		'@glb-compressor/server': resolve('./packages/server/src/main.ts'),
	};

	return {
		name: 'workspace-resolver',
		setup(build) {
			build.onResolve({ filter: /^@glb-compressor\// }, (args) => {
				const resolved = WORKSPACE_MAP[args.path];
				if (resolved) return { path: resolved };
				return undefined;
			});
		},
	};
}

async function build() {
	// Clean previous build artifacts so stale files don't accumulate
	await Bun.$`rm -rf dist/`;

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
		banner: '#!/usr/bin/env node',
		external,
		plugins: [workspaceResolverPlugin(), bunPolyfillPlugin({ packageRoot: resolve('.') })],
		naming: {
			entry: '[dir]/[name].js',
			chunk: 'chunks/[name]-[hash].js',
		},
		metafile: true,
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
		metafile: true,
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
			entry: '[dir]/[name].cjs',
		},
	});

	if (!bytecodeResult.success) {
		console.error('Bun bytecode build failed:');
		for (const log of bytecodeResult.logs) console.error(log);
		process.exit(1);
	}
	console.log(`  ${bytecodeResult.outputs.length} files`);

	// ── 4. TypeScript declarations ───────────────────────────
	console.log('Generating TypeScript declarations...');
	// tsgo is provided by @typescript/native-preview in devDependencies
	const tscProc = Bun.spawn(['bun', 'run', 'tsgo', '-p', 'tsconfig.build.json'], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const tscExit = await tscProc.exited;
	if (tscExit !== 0) {
		const tscStderr = await new Response(tscProc.stderr).text();
		console.error('TypeScript declaration generation failed:');
		console.error(tscStderr);
		process.exit(1);
	}
	console.log('  dist/types/ generated');

	// ── Summary ─────────────────────────────────────────────
	const elapsed = ((performance.now() - start) / 1000).toFixed(2);
	console.log(`\nDone in ${elapsed}s`);
	console.log(`  dist/node/          ${nodeResult.outputs.length} files (Node.js ESM)`);
	console.log(`  dist/bun/           ${bunResult.outputs.length} files (Bun ESM)`);
	console.log(`  dist/bun-bytecode/  ${bytecodeResult.outputs.length} files (Bun CJS + bytecode)`);
	console.log(`  dist/types/         TypeScript declarations`);
}

build().catch((err) => {
	console.error('Build error:', err);
	process.exit(1);
});
