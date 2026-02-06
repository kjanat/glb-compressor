import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GLB_MAGIC } from './constants';

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb: number = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	return `${(kb / 1024).toFixed(2)} MB`;
}

export function sanitizeFilename(name: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: security
	const CONTROL_CHARS = /[\x00-\x1f]/g;
	return (
		(name.split(/[\\/]/).pop() || 'model.glb')
			// Replace invalid filename characters with underscores
			.replace(/[<>:"|?*]/g, '_')
			// Remove leading/trailing dots
			.replace(/^\.*|\.*$/g, '')
			// Remove control characters
			.replace(CONTROL_CHARS, '')
			// Trim whitespace
			.trim()
			// Limit length to 200 characters
			.slice(0, 200)
	);
}

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

export function parseSimplifyRatio(raw: string | null): number | undefined {
	if (!raw) return undefined;
	const n: number = Number.parseFloat(raw);
	if (Number.isNaN(n) || n <= 0 || n >= 1) return undefined;
	return n;
}
