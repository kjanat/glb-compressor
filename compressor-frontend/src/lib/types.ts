export type FileStatus = 'pending' | 'compressing' | 'done' | 'error';
export type LogType = 'info' | 'phase' | 'success' | 'error';
export type PresetId = 'default' | 'balanced' | 'aggressive' | 'max';

export interface CompressResult {
	requestId: string;
	filename: string;
	originalSize: number;
	compressedSize: number;
	ratio: number;
	method: string;
	blob: Blob;
}

export interface QueuedFile {
	id: number;
	file: File;
	status: FileStatus;
	result: CompressResult | null;
	error: string | null;
}

export interface LogEntry {
	id: number;
	time: string;
	message: string;
	type: LogType;
}

export interface Preset {
	readonly id: PresetId;
	readonly name: string;
	readonly reduction: string;
	readonly desc: string;
}

export const PRESETS: readonly Preset[] = [
	{ id: 'default', name: 'Default', reduction: 'Detail-first', desc: 'Safe, keeps all detail' },
	{ id: 'balanced', name: 'Balanced', reduction: 'General-use', desc: 'Good for avatars & animations' },
	{ id: 'aggressive', name: 'Aggressive', reduction: 'Size-first', desc: 'Strong, still looks good' },
	{ id: 'max', name: 'Max', reduction: 'Min-size', desc: 'Smallest possible file' },
];
