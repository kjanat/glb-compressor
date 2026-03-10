import adapter from '@sveltejs/adapter-static';
import type { Config } from '@sveltejs/kit';

const config: Config = {
	kit: {
		adapter: adapter({
			pages: '../dist/frontend',
			assets: '../dist/frontend',
			fallback: 'index.html',
		}),
	},
};

export default config;
