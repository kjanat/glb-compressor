import { defineConfig } from 'tsdown';
import { POLYFILL_PATH, polyfillBunSource } from './packages/bun-polyfill/src/bun-transform.ts';

/**
 * Builds the CLI only. The library and server keep `build.ts`; the CLI is
 * bundled standalone so dreamcli ships treeshaken inside `dist/cli/main.mjs`.
 * Native addons and WASM packages must stay external. The Bun APIs the
 * library uses go through the same polyfill as the `build.ts` Node target.
 */

function bunNodePolyfill() {
	return {
		name: 'bun-node-polyfill',
		transform(code: string, id: string) {
			if (id.split(/[/\\]/).includes('node_modules') || id === POLYFILL_PATH) return null;
			if (!/\.(ts|tsx|js|jsx)$/.test(id)) return null;
			const transformed = polyfillBunSource(code);
			return transformed === undefined ? null : { code: transformed, map: null };
		},
	};
}

export default defineConfig({
	entry: { main: 'packages/cli/src/main.ts' },
	outDir: 'dist/cli',
	format: 'esm',
	platform: 'node',
	target: 'node22.22',
	alias: { bun: POLYFILL_PATH },
	deps: { neverBundle: ['sharp', 'draco3dgltf', 'meshoptimizer'] },
	dts: false,
	minify: 'dce-only',
	clean: true,
	plugins: [bunNodePolyfill()],
});
