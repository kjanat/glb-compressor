import { resolve } from 'node:path';
import { defineConfig } from 'tsdown';

const external = ['sharp', 'draco3dgltf', 'meshoptimizer'];
const workspaceAlias: Record<string, string> = {
	'@glb-compressor/core': resolve('packages/core/src/mod.ts'),
	'@glb-compressor/shared-types': resolve('packages/shared-types/src/index.ts'),
};

export default defineConfig([
	{
		name: 'runtime',
		entry: {
			'core/src/mod': 'packages/core/src/mod.ts',
			'server/src/main': 'packages/server/src/main.ts',
			'server/src/worker': 'packages/server/src/worker.ts',
			'shared-types/src/index': 'packages/shared-types/src/index.ts',
		},
		outDir: 'dist/node',
		format: 'esm',
		platform: 'node',
		target: 'node24',
		alias: workspaceAlias,
		deps: { neverBundle: external },
		dts: false,
		sourcemap: true,
		minify: false,
		clean: true,
		fixedExtension: false,
	},
	{
		name: 'cli',
		entry: { main: 'packages/cli/src/main.ts' },
		outDir: 'dist/cli',
		format: 'esm',
		platform: 'node',
		target: 'node24',
		alias: workspaceAlias,
		deps: { neverBundle: external },
		dts: false,
		sourcemap: true,
		minify: 'dce-only',
		clean: true,
		fixedExtension: false,
	},
]);
