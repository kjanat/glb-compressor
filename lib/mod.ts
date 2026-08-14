/**
 * Public API barrel export for `glb-compressor`.
 *
 * This module re-exports everything needed to compress GLB files
 * programmatically, use individual transforms, or access shared constants.
 *
 * @example
 * ```ts
 * import { compress, init, PRESETS } from 'glb-compressor';
 *
 * await init();
 * const result = await compress(glbBytes, { preset: 'aggressive' });
 * ```
 *
 * @module mod
 */

// Core compression API
export type { CompressOptions, CompressPreset, CompressResult } from '$lib/compress';
export { compress, getHasGltfpack, init, PRESETS } from '$lib/compress';

// Constants
export * from '$lib/constants';

// Custom transforms (for advanced / a-la-carte usage)
export * from '$lib/transforms';

// Utility functions
export { formatBytes, parseSimplifyRatio, sanitizeFilename, validateGlbMagic, withTempDir } from '$lib/utils';
