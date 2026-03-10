import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import robots from 'vite-robots-txt';
import svgToIco from 'vite-svg-to-ico';

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		svgToIco({ input: 'src/assets/icon.svg', emit: { source: true, inject: true } }),
		robots({ preset: 'allowAll', meta: true }),
		react({
			babel: {
				plugins: [['babel-plugin-react-compiler']],
			},
		}),
	],
});
