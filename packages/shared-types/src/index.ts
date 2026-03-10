/**
 * Shared, runtime-agnostic wire types used by server + frontend.
 */

/** `event: log` payload from `/compress-stream`. */
export interface CompressionLogEvent {
	message: string;
}

/** `event: error` payload from `/compress-stream`. */
export interface CompressionErrorEvent {
	message?: string;
	requestId?: string;
	code?: string;
}

/** `event: result` payload from `/compress-stream`. */
export interface CompressionResultEvent {
	requestId: string;
	filename: string;
	data: string;
	originalSize: number;
	compressedSize: number;
	ratio: number;
	method: string;
}

/** Stream event map for strongly-typed emit/parse helpers. */
export interface CompressionStreamEventMap {
	log: CompressionLogEvent;
	error: CompressionErrorEvent;
	result: CompressionResultEvent;
}
