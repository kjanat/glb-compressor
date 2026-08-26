/**
 * Shared source transform for building Bun-targeted code to run on Node.
 *
 * Used by both bundlers: `plugin.ts` (Bun.build, the library and server
 * targets) and `tsdown.config.ts` (rolldown, the CLI).
 * Injects the polyfilled `Bun` namespace where Bun globals appear and
 * replaces `import.meta.main` with a Node-compatible check.
 */

import { join } from 'node:path';

export const POLYFILL_PATH = join(import.meta.dirname, 'polyfills.ts');

const BUN_GLOBAL_RE = /\bBun\.(file|write|spawn|argv|serve|which)\b/;
/** Non-global regex for .test() detection (avoids lastIndex interference). */
const IMPORT_META_MAIN_TEST_RE = /\bimport\.meta\.main\b/;
/** Global regex for .replace() to substitute all occurrences. */
const IMPORT_META_MAIN_RE = /\bimport\.meta\.main\b/g;

/**
 * Rewrite one module's source for Node, or return `undefined` when the file
 * needs no rewrite.
 */
export function polyfillBunSource(raw: string): string | undefined {
	const usesBunGlobal = BUN_GLOBAL_RE.test(raw);
	const usesImportMetaMain = IMPORT_META_MAIN_TEST_RE.test(raw);
	if (!usesBunGlobal && !usesImportMetaMain) return undefined;

	// Strip shebang — it must be line 1 but imports get prepended
	let transformed = raw.replace(/^#!.*\n/, '');
	const imports: string[] = [];

	// Shadow the global `Bun` with the polyfill's Bun namespace. The bundler
	// resolves 'bun' → polyfills.ts, so this import pulls in the Node
	// implementations.
	if (usesBunGlobal) {
		imports.push(`import { Bun } from "bun";`);
	}

	// Replace import.meta.main with a Node-compatible entry check.
	if (usesImportMetaMain) {
		imports.push(`import { fileURLToPath as __bunPolyFUTP } from "node:url";`);
		transformed = transformed.replace(IMPORT_META_MAIN_RE, '(__bunPolyFUTP(import.meta.url) === process.argv[1])');
	}

	return `${imports.join('\n')}\n${transformed}`;
}
