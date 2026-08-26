/**
 * Bun bundler plugin that replaces Bun-specific APIs with Node.js polyfills.
 * Only used for the `target: "node"` build.
 *
 * Hook 1 — onResolve('bun'):  redirect `import { Glob, $ } from 'bun'` to polyfills.ts
 * Hook 2 — onLoad(*.ts):      inject `import { Bun }` for files using Bun.* globals,
 *                              replace `import.meta.main` with a Node-compatible check
 * Hook 3 — onResolve('pkg'):  safety net for tsconfig `pkg` → package.json alias
 */

import type { BunPlugin } from 'bun';
import { join } from 'node:path';
import { POLYFILL_PATH, polyfillBunSource } from './bun-transform';

type BunLoader = 'ts' | 'tsx' | 'js' | 'jsx';
const ALLOWED_LOADERS: ReadonlySet<string> = new Set<string>(['ts', 'tsx', 'js', 'jsx']);
function isBunLoader(ext: string): ext is BunLoader {
	return ALLOWED_LOADERS.has(ext);
}

export function bunPolyfillPlugin(): BunPlugin {
	return {
		name: 'bun-node-polyfill',
		setup(build) {
			// ── Hook 1: Redirect `from 'bun'` to polyfills ──────────
			build.onResolve({ filter: /^bun$/ }, () => ({
				path: POLYFILL_PATH,
			}));

			// ── Hook 2: Transform Bun.* globals & import.meta.main ──
			build.onLoad({ filter: /\.(ts|tsx|js|jsx)$/ }, async (args) => {
				// Skip node_modules — only transform project source
				if (args.path.split(/[/\\]/).includes('node_modules')) return undefined;
				// Skip the polyfill file itself to avoid circular injection
				if (args.path === POLYFILL_PATH) return undefined;

				const raw = await Bun.file(args.path).text();

				const transformed = polyfillBunSource(raw);
				if (transformed === undefined) return undefined;

				const ext = args.path.split('.').pop() ?? 'ts';
				const loader: BunLoader = isBunLoader(ext) ? ext : 'ts';

				return { contents: transformed, loader };
			});

			// ── Hook 3: Resolve `pkg` tsconfig alias ────────────────
			build.onResolve({ filter: /^pkg$/ }, () => ({
				path: join(import.meta.dir, '..', 'package.json'),
			}));
		},
	};
}
