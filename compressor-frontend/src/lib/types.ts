export type FileStatus = 'pending' | 'compressing' | 'done' | 'error';
export type LogType = 'info' | 'phase' | 'success' | 'error';
export type PresetId = 'default' | 'balanced' | 'aggressive' | 'max';

export interface CompressResult {
	filename: string;
	data: string;
	originalSize: number;
	compressedSize: number;
	ratio: number;
	method: string;
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
	{ id: 'default', name: 'Default', reduction: '-80%', desc: 'Safe, keeps all detail' },
	{ id: 'balanced', name: 'Balanced', reduction: '-82%', desc: 'Good for avatars & animations' },
	{ id: 'aggressive', name: 'Aggressive', reduction: '-84%', desc: 'Strong, still looks good' },
	{ id: 'max', name: 'Max', reduction: '-84%+', desc: 'Smallest possible file' },
];
