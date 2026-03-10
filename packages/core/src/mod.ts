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
export type {
	CompressOptions,
	CompressPreset,
	CompressResult,
} from './compress';
export { compress, getHasGltfpack, init, PRESETS } from './compress';

// Constants
export * from './constants';

// Custom transforms (for advanced / a-la-carte usage)
export * from './transforms';

// Utility functions
export {
	formatBytes,
	parseSimplifyRatio,
	sanitizeFilename,
	validateGlbMagic,
	withTempDir,
} from './utils';
