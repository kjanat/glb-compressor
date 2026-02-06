/**
 * General-purpose utility functions shared across the library, CLI, and server.
 *
 * @module utils
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GLB_MAGIC } from './constants';

/**
 * Format a byte count into a human-readable string (B, KB, or MB).
 *
 * @param bytes - Raw byte count.
 * @returns Formatted string, e.g. `"1.5 KB"` or `"3.21 MB"`.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb: number = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	return `${(kb / 1024).toFixed(2)} MB`;
}

/**
 * Sanitize an untrusted filename for safe filesystem use.
 *
 * Strips path traversal components, replaces invalid/control characters with
 * underscores, trims leading/trailing dots and whitespace, and caps length at
 * 200 characters. Returns `"model.glb"` if the result is empty.
 *
 * @param name - Raw filename, possibly containing path separators or invalid characters.
 * @returns A filesystem-safe filename.
 */
export function sanitizeFilename(name: string): string {
	const base = name.split(/[\\/]/).pop() || '';
	const clean = base
		// biome-ignore lint/suspicious/noControlCharactersInRegex: security
		.replace(/[<>:"|?*\x00-\x1f]/g, '_')
		.replace(/^[.\s]+|[.\s]+$/g, '')
		.slice(0, 200);
	return clean || 'model.glb';
}

/**
 * Validate that a buffer begins with the GLB magic bytes (`0x46546C67` / ASCII `"glTF"`).
 *
 * @param input - Raw file bytes to check.
 * @throws {Error} If the buffer is too small or the magic number doesn't match.
 */
export function validateGlbMagic(input: Uint8Array): void {
	if (input.length < 4) {
		throw new Error('File too small to be a valid GLB');
	}
	const magic: number = new DataView(
		input.buffer,
		input.byteOffset,
		4,
	).getUint32(0, true);
	if (magic !== GLB_MAGIC) {
		throw new Error(
			`Invalid GLB file: expected magic 0x${GLB_MAGIC.toString(16)}, got 0x${magic.toString(16)}`,
		);
	}
}

/**
 * Execute a callback with a temporary directory that is automatically cleaned up.
 *
 * Creates a directory under the OS temp path, passes its path to `fn`, and
 * recursively removes it in a `finally` block — even if `fn` throws.
 *
 * @typeParam T - Return type of the callback.
 * @param fn - Async function receiving the temp directory path.
 * @returns The value returned by `fn`.
 */
export async function withTempDir<T>(
	fn: (dir: string) => Promise<T>,
): Promise<T> {
	const dir: string = await mkdtemp(join(tmpdir(), 'gltf-compress-'));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Parse a user-supplied simplification ratio string into a validated number.
 *
 * Returns `undefined` for falsy, non-numeric, or out-of-range values.
 * Valid range is exclusive `(0, 1)` — e.g. `0.5` means "keep 50% of vertices".
 *
 * @param raw - String value from query param or CLI flag, or `null`.
 * @returns Parsed ratio in `(0, 1)`, or `undefined` if invalid.
 */
export function parseSimplifyRatio(raw: string | null): number | undefined {
	if (!raw) return undefined;
	const n: number = Number.parseFloat(raw);
	if (Number.isNaN(n) || n <= 0 || n >= 1) return undefined;
	return n;
}
