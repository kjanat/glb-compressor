import type { CompressResult } from './types';

export function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

export function timestamp(): string {
	return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCompressionResult(result: CompressResult): void {
	downloadBlob(result.blob, result.filename);
}
