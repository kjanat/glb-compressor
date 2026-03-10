import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-static';
import type { Config } from '@sveltejs/kit';

const sharedTypesPath = fileURLToPath(new URL('../packages/shared-types/src/index.ts', import.meta.url));

const config: Config = {
	kit: {
		alias: {
			'@glb-compressor/shared-types': sharedTypesPath,
		},
		adapter: adapter({
			pages: '../dist/frontend',
			assets: '../dist/frontend',
			fallback: 'index.html',
		}),
	},
};

export default config;
