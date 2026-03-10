import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import robots from 'vite-robots-txt';
import favicon from 'vite-svg-to-ico';

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		favicon({ input: 'src/assets/icon.svg', emit: { source: true, inject: true } }),
		robots({ preset: 'allowAll', meta: true }),
		react({
			babel: {
				plugins: [['babel-plugin-react-compiler']],
			},
		}),
	],
	base: process.env.DEV === 'true' ? '/' : process.env.VITE_BASE_URL || './',
	optimizeDeps: { include: ['**'] },
});
