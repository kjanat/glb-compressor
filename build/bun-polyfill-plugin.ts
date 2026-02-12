/**
 * Bun bundler plugin that replaces Bun-specific APIs with Node.js polyfills.
 * Only used for the `target: "node"` build.
 *
 * Hook 1 — onResolve('bun'):  redirect `import { Glob, $ } from 'bun'` to polyfills.ts
 * Hook 2 — onLoad(*.ts):      inject `import { Bun }` for files using Bun.* globals,
 *                              replace `import.meta.main` with a Node-compatible check
 * Hook 3 — onResolve('pkg'):  safety net for tsconfig `pkg` → package.json alias
 */

import { join } from 'node:path';
import type { BunPlugin } from 'bun';

const POLYFILL_PATH = join(import.meta.dir, 'polyfills.ts');

type BunLoader = 'ts' | 'tsx' | 'js' | 'jsx';
const ALLOWED_LOADERS: ReadonlySet<string> = new Set<string>([
	'ts',
	'tsx',
	'js',
	'jsx',
]);
function isBunLoader(ext: string): ext is BunLoader {
	return ALLOWED_LOADERS.has(ext);
}

const BUN_GLOBAL_RE = /\bBun\.(file|write|spawn|argv|serve|which)\b/;
/** Non-global regex for .test() detection (avoids lastIndex interference). */
const IMPORT_META_MAIN_TEST_RE = /\bimport\.meta\.main\b/;
/** Global regex for .replace() to substitute all occurrences. */
const IMPORT_META_MAIN_RE = /\bimport\.meta\.main\b/g;

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

				const usesBunGlobal = BUN_GLOBAL_RE.test(raw);
				const usesImportMetaMain = IMPORT_META_MAIN_TEST_RE.test(raw);

				if (!usesBunGlobal && !usesImportMetaMain) return undefined;

				// Strip shebang — it must be line 1 but we're prepending imports
				let transformed = raw.replace(/^#!.*\n/, '');
				const imports: string[] = [];

				// Shadow the global `Bun` with our polyfill's Bun namespace.
				// The onResolve hook above resolves 'bun' → polyfills.ts,
				// so this import pulls in our Node.js implementations.
				if (usesBunGlobal) {
					imports.push(`import { Bun } from "bun";`);
				}

				// Replace import.meta.main with Node-compatible entry check.
				if (usesImportMetaMain) {
					imports.push(
						`import { fileURLToPath as __bunPolyFUTP } from "node:url";`,
					);
					transformed = transformed.replace(
						IMPORT_META_MAIN_RE,
						'(__bunPolyFUTP(import.meta.url) === process.argv[1])',
					);
				}

				if (imports.length > 0) {
					transformed = `${imports.join('\n')}\n${transformed}`;
				}

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
