import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const BASE = 'http://localhost:8080';

type FileStatus = 'pending' | 'compressing' | 'done' | 'error';
type LogType = 'info' | 'phase' | 'success' | 'error';

interface CompressResult {
	filename: string;
	data: string;
	originalSize: number;
	compressedSize: number;
	ratio: number;
	method: string;
}

interface QueuedFile {
	id: number;
	file: File;
	status: FileStatus;
	result: CompressResult | null;
	error: string | null;
}

interface LogEntry {
	id: number;
	time: string;
	message: string;
	type: LogType;
}

interface StreamLogEvent {
	message: string;
}

interface StreamErrorEvent {
	message?: string;
}

interface ParseHandlers {
	onLog?: (event: StreamLogEvent) => void;
	onResult?: (event: CompressResult) => void;
	onError?: (event: StreamErrorEvent) => void;
}

const PRESETS = [
	{
		id: 'default',
		name: 'Default',
		reduction: '-80%',
		desc: 'Safe, keeps all detail',
	},
	{
		id: 'balanced',
		name: 'Balanced',
		reduction: '-82%',
		desc: 'Good for avatars & animations',
	},
	{
		id: 'aggressive',
		name: 'Aggressive',
		reduction: '-84%',
		desc: 'Strong, still looks good',
	},
	{
		id: 'max',
		name: 'Max',
		reduction: '-84%+',
		desc: 'Smallest possible file',
	},
] as const;

function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function timestamp(): string {
	return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

async function parseSSE(response: Response, handlers: ParseHandlers) {
	if (!response.body) throw new Error('Missing response stream');

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split('\n\n');
			buffer = parts.pop() ?? '';

			for (const raw of parts) {
				if (!raw.trim()) continue;

				let type = '';
				let data = '';

				for (const line of raw.split('\n')) {
					if (line.startsWith('event: ')) type = line.slice(7);
					if (line.startsWith('data: ')) data += line.slice(6);
				}

				if (!type || !data) continue;

				try {
					const parsed: unknown = JSON.parse(data);

					if (type === 'log') {
						handlers.onLog?.(parsed as StreamLogEvent);
					}

					if (type === 'result') {
						handlers.onResult?.(parsed as CompressResult);
					}

					if (type === 'error') {
						handlers.onError?.(parsed as StreamErrorEvent);
					}
				} catch (error) {
					console.warn('Malformed SSE JSON:', error);
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function App() {
	const [setupOpen, setSetupOpen] = useState(false);
	const [serverOnline, setServerOnline] = useState(false);
	const [files, setFiles] = useState<QueuedFile[]>([]);
	const [selectedPreset, setSelectedPreset] = useState<(typeof PRESETS)[number]['id']>('balanced');
	const [simplifyEnabled, setSimplifyEnabled] = useState(false);
	const [simplifyRatio, setSimplifyRatio] = useState(0.5);
	const [isCompressing, setIsCompressing] = useState(false);
	const [logOpen, setLogOpen] = useState(false);
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [dragOver, setDragOver] = useState(false);
	const [acceptedPulse, setAcceptedPulse] = useState(false);

	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const logsRef = useRef<HTMLDivElement | null>(null);
	const fileIdRef = useRef(0);
	const logIdRef = useRef(0);
	const pulseTimeoutRef = useRef<number | null>(null);
	const filesStateRef = useRef<QueuedFile[]>([]);

	useEffect(() => {
		filesStateRef.current = files;
	}, [files]);

	useEffect(() => {
		if (logOpen) {
			logsRef.current?.scrollTo({ top: logsRef.current.scrollHeight });
		}
	}, [logs, logOpen]);

	useEffect(
		() => () => {
			if (pulseTimeoutRef.current !== null) {
				window.clearTimeout(pulseTimeoutRef.current);
			}
		},
		[],
	);

	const addLog = useCallback((message: string, type: LogType = 'info') => {
		setLogOpen(true);
		setLogs((prev) => [
			...prev,
			{
				id: ++logIdRef.current,
				time: timestamp(),
				message,
				type,
			},
		]);
	}, []);

	const updateFile = useCallback((id: number, patch: Partial<QueuedFile>) => {
		setFiles((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
	}, []);

	const checkServer = useCallback(
		async (reportError: boolean) => {
			try {
				const response = await fetch(`${BASE}/healthz`, {
					signal: AbortSignal.timeout(3000),
				});
				setServerOnline(response.ok);
			} catch (error) {
				setServerOnline(false);
				if (reportError) {
					addLog('Server health check failed. Is glb-server running?', 'error');
					console.warn('Initial server health check failed:', error);
				}
			}
		},
		[addLog],
	);

	useEffect(() => {
		checkServer(true).catch((error) => {
			addLog('Server health check failed during startup.', 'error');
			console.warn('Startup health check rejected:', error);
		});

		const interval = window.setInterval(() => {
			checkServer(false).catch((error) => {
				console.warn('Periodic server health check rejected:', error);
			});
		}, 5000);

		return () => {
			window.clearInterval(interval);
		};
	}, [addLog, checkServer]);

	const addFiles = useCallback((input: FileList | File[]) => {
		const next = Array.from(input)
			.filter((file) => /\.(glb|gltf)$/i.test(file.name))
			.map((file) => ({
				id: ++fileIdRef.current,
				file,
				status: 'pending' as const,
				result: null,
				error: null,
			}));

		if (next.length === 0) return;

		setFiles((prev) => [...prev, ...next]);
		setAcceptedPulse(true);

		if (pulseTimeoutRef.current !== null) {
			window.clearTimeout(pulseTimeoutRef.current);
		}

		pulseTimeoutRef.current = window.setTimeout(() => {
			setAcceptedPulse(false);
			pulseTimeoutRef.current = null;
		}, 300);
	}, []);

	const removeFile = useCallback((id: number) => {
		setFiles((prev) => prev.filter((file) => file.id !== id));
	}, []);

	const clearFiles = useCallback(() => {
		setFiles((prev) => prev.filter((file) => file.status === 'compressing'));
	}, []);

	const downloadBase64 = useCallback((base64: string, filename: string) => {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);

		for (let index = 0; index < binary.length; index++) {
			bytes[index] = binary.charCodeAt(index);
		}

		const blob = new Blob([bytes], { type: 'model/gltf-binary' });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = filename;
		anchor.click();

		window.setTimeout(() => {
			URL.revokeObjectURL(url);
		}, 1000);
	}, []);

	const compressFile = useCallback(
		async (queued: QueuedFile) => {
			updateFile(queued.id, { status: 'compressing' });
			addLog(`-> ${queued.file.name} (${formatBytes(queued.file.size)})`, 'phase');

			const form = new FormData();
			form.append('file', queued.file);

			let url = `${BASE}/compress-stream?preset=${selectedPreset}`;
			if (simplifyEnabled) url += `&simplify=${simplifyRatio}`;

			try {
				const response = await fetch(url, { method: 'POST', body: form });
				const contentType = response.headers.get('content-type') ?? '';

				if (!contentType.includes('text/event-stream')) {
					let message = `Server error ${response.status}`;
					try {
						const parsed: unknown = await response.json();
						if (typeof parsed === 'object' && parsed !== null) {
							const maybeError = (parsed as { error?: { message?: string } }).error;
							if (maybeError?.message) message = maybeError.message;
						}
					} catch {
						// keep default message
					}
					throw new Error(message);
				}

				await parseSSE(response, {
					onLog: (event) => {
						addLog(event.message);
					},
					onResult: (event) => {
						updateFile(queued.id, {
							status: 'done',
							result: event,
							error: null,
						});
						addLog(
							`OK ${queued.file.name}: ${formatBytes(event.originalSize)} -> ${formatBytes(event.compressedSize)} (-${event.ratio}%, ${event.method})`,
							'success',
						);
					},
					onError: (event) => {
						const message = event.message ?? 'Compression failed';
						updateFile(queued.id, {
							status: 'error',
							error: message,
						});
						addLog(`X ${queued.file.name}: ${message}`, 'error');
					},
				});

				const latest = filesStateRef.current.find((item) => item.id === queued.id);
				if (latest?.status === 'compressing') {
					throw new Error('Stream ended without result');
				}
			} catch (error) {
				const latest = filesStateRef.current.find((item) => item.id === queued.id);
				if (latest?.status !== 'compressing') return;

				const message =
					error instanceof Error && error.message.includes('Failed to fetch')
						? 'Cannot reach server. Is glb-server running?'
						: error instanceof Error
							? error.message
							: 'Compression failed';

				updateFile(queued.id, {
					status: 'error',
					error: message,
				});
				addLog(`X ${queued.file.name}: ${message}`, 'error');
			}
		},
		[addLog, selectedPreset, simplifyEnabled, simplifyRatio, updateFile],
	);

	const compressAll = useCallback(async () => {
		const pending = filesStateRef.current.filter((item) => item.status === 'pending');
		if (pending.length === 0 || isCompressing) return;

		setIsCompressing(true);
		setLogs([]);
		setLogOpen(true);

		addLog(
			`Starting batch: ${pending.length} file${pending.length === 1 ? '' : 's'}, preset=${selectedPreset}`,
			'phase',
		);

		for (let index = 0; index < pending.length; index++) {
			await compressFile(pending[index]);
		}

		setIsCompressing(false);

		const doneCount = filesStateRef.current.filter((item) => item.status === 'done').length;
		const errorCount = filesStateRef.current.filter((item) => item.status === 'error').length;

		if (errorCount > 0) {
			addLog(`Finished: ${doneCount} compressed, ${errorCount} failed`, 'error');
		} else {
			addLog(`All ${doneCount} file${doneCount === 1 ? '' : 's'} compressed successfully`, 'success');
		}
	}, [addLog, compressFile, isCompressing, selectedPreset]);

	const onCopyCommand = useCallback((text: string, target: HTMLButtonElement) => {
		navigator.clipboard.writeText(text).then(() => {
			target.textContent = 'Copied!';
			target.classList.add('copied');

			window.setTimeout(() => {
				target.textContent = 'Copy';
				target.classList.remove('copied');
			}, 2000);
		});
	}, []);

	const pendingCount = files.filter((item) => item.status === 'pending').length;
	const doneCount = files.filter((item) => item.status === 'done').length;

	const buttonState = useMemo(() => {
		if (!serverOnline) {
			return { text: 'Server offline - see setup above', disabled: true };
		}

		if (isCompressing) {
			const pending = files.filter((item) => item.status === 'pending').length;
			const total = pending + files.filter((item) => item.status === 'compressing').length;
			return {
				text: total > 0 ? `Compressing ${total - pending}/${total}...` : 'Compressing...',
				disabled: true,
			};
		}

		if (pendingCount === 0) {
			return {
				text: files.length > 0 ? 'All files processed' : 'Select files to compress',
				disabled: true,
			};
		}

		return {
			text: pendingCount === 1 ? 'Compress ->' : `Compress ${pendingCount} files ->`,
			disabled: false,
		};
	}, [files, isCompressing, pendingCount, serverOnline]);

	return (
		<div className="wrapper">
			<header>
				<div className="header-row">
					<p className="tag">{'// glb-compressor'}</p>
					<div className={`server-status ${serverOnline ? 'online' : 'offline'}`}>
						<span className="server-dot"></span>
						<span>{serverOnline ? 'Connected' : 'Offline'}</span>
					</div>
				</div>
				<h1>
					Compress
					<br />
					<span>your GLB.</span>
				</h1>
				<p className="subtitle">Drop files. Pick a preset. Done.</p>
			</header>

			<div className="setup">
				<button
					type="button"
					className={`setup-header ${setupOpen ? 'open' : ''}`}
					onClick={() => setSetupOpen((open) => !open)}
				>
					<div className="setup-header-left">
						<span className="setup-badge">First time?</span>
						<span className="setup-title">Click here for setup instructions</span>
					</div>
					<span className={`setup-chevron ${setupOpen ? 'open' : ''}`}>&#9660;</span>
				</button>

				<div className={`setup-body ${setupOpen ? 'open' : ''}`}>
					<p
						style={{
							fontFamily: 'var(--mono)',
							fontSize: 11,
							color: '#666',
							marginBottom: 24,
							lineHeight: 1.8,
						}}
					>
						You only need to do steps 1-3 <strong style={{ color: '#999' }}>once ever</strong>
						.<br />
						Step 4 you do <strong style={{ color: '#999' }}>each time</strong> you want to use this page.
					</p>

					<div className="step">
						<div className="step-num">1</div>
						<div className="step-content">
							<div className="step-title">Open PowerShell</div>
							<div className="step-desc">
								Press the <strong>Windows key</strong> on your keyboard (bottom-left, looks like &#8862;).
								<br />
								Type <strong>PowerShell</strong> and press <strong>Enter</strong>.<br />A blue or black window will open
								- that is normal.
							</div>
						</div>
					</div>

					<div className="step">
						<div className="step-num">2</div>
						<div className="step-content">
							<div className="step-title">Install Bun - only once</div>
							<div className="step-desc">
								Click <strong>Copy</strong> below, then paste in PowerShell and press
								<strong> Enter</strong>.
							</div>
							<div className="cmd-block">
								<span className="cmd-text">powershell -c "irm bun.sh/install.ps1 | iex"</span>
								<button
									type="button"
									className="copy-btn"
									onClick={(event) => {
										onCopyCommand('powershell -c "irm bun.sh/install.ps1 | iex"', event.currentTarget);
									}}
								>
									Copy
								</button>
							</div>
							<div className="step-note">&#9888; When finished: close PowerShell completely, then reopen it.</div>
						</div>
					</div>

					<div className="step">
						<div className="step-num">3</div>
						<div className="step-content">
							<div className="step-title">Install the compressor - only once</div>
							<div className="step-desc">
								In the reopened PowerShell, click <strong>Copy</strong>, paste, then press
								<strong> Enter</strong>.
							</div>
							<div className="cmd-block">
								<span className="cmd-text">bun i -g glb-compressor</span>
								<button
									type="button"
									className="copy-btn"
									onClick={(event) => {
										onCopyCommand('bun i -g glb-compressor', event.currentTarget);
									}}
								>
									Copy
								</button>
							</div>
							<div className="step-note">Wait for it to finish. Then continue.</div>
						</div>
					</div>

					<hr className="divider" />

					<div className="step">
						<div className="step-num">4</div>
						<div className="step-content">
							<div className="step-title">Start the server - every time you use this page</div>
							<div className="step-desc">Open PowerShell, then run this:</div>
							<div className="cmd-block">
								<span className="cmd-text">glb-server</span>
								<button
									type="button"
									className="copy-btn"
									onClick={(event) => {
										onCopyCommand('glb-server', event.currentTarget);
									}}
								>
									Copy
								</button>
							</div>
							<div className="warning-box">
								<strong>&#9888; Keep PowerShell open!</strong>
								Do not close that window while using this page.
							</div>
						</div>
					</div>
				</div>
			</div>

			<label
				htmlFor="fileInput"
				className={`dropzone ${dragOver ? 'dragover' : ''} ${acceptedPulse ? 'accepted' : ''}`}
				onDragOver={(event) => {
					event.preventDefault();
					setDragOver(true);
				}}
				onDragLeave={() => setDragOver(false)}
				onDrop={(event) => {
					event.preventDefault();
					setDragOver(false);
					if (event.dataTransfer.files.length > 0) {
						addFiles(event.dataTransfer.files);
					}
				}}
			>
				<input
					id="fileInput"
					ref={fileInputRef}
					type="file"
					accept=".glb,.gltf"
					multiple
					onChange={(event) => {
						if (event.currentTarget.files && event.currentTarget.files.length > 0) {
							addFiles(event.currentTarget.files);
						}
						event.currentTarget.value = '';
					}}
				/>
				<span className="drop-icon">&#128230;</span>
				<p className="drop-title">Drop your GLB files here</p>
				<p className="drop-sub">or click to browse - .glb / .gltf - multiple files OK</p>
			</label>

			<div className={`file-list ${files.length > 0 ? 'active' : ''}`}>
				<div className="file-list-header">
					<span className="file-count">
						{files.length} file{files.length === 1 ? '' : 's'}
						{doneCount > 0 ? ` · ${doneCount} compressed` : ''}
					</span>
					<button type="button" className="file-clear" onClick={clearFiles}>
						Clear all
					</button>
				</div>

				<div>
					{files.map((item) => (
						<div key={item.id} className={`file-item ${item.status}`}>
							<span className="file-icon">
								{item.status === 'pending' && '○'}
								{item.status === 'compressing' && <span className="spinner">⟳</span>}
								{item.status === 'done' && '✓'}
								{item.status === 'error' && '✗'}
							</span>
							<span className="file-name" title={item.file.name}>
								{item.file.name}
							</span>
							<span className="file-size">
								{item.status === 'done' && item.result
									? `${formatBytes(item.result.originalSize)} -> ${formatBytes(item.result.compressedSize)}`
									: formatBytes(item.file.size)}
								{item.status === 'done' && item.result && <span className="file-ratio">-{item.result.ratio}%</span>}
							</span>
							<span className="file-actions">
								{item.status === 'done' && item.result && (
									<button
										type="button"
										className="file-dl"
										title="Download"
										onClick={() => {
											if (!item.result) return;
											downloadBase64(item.result.data, item.result.filename);
										}}
									>
										↓
									</button>
								)}
								{item.status !== 'compressing' && (
									<button type="button" className="file-rm" title="Remove" onClick={() => removeFile(item.id)}>
										×
									</button>
								)}
							</span>
						</div>
					))}
				</div>
			</div>

			<p className="section-label">Compression preset</p>
			<div className="presets">
				{PRESETS.map((preset) => (
					<button
						key={preset.id}
						type="button"
						className={`preset-btn ${selectedPreset === preset.id ? 'active' : ''}`}
						onClick={() => {
							if (isCompressing) return;
							setSelectedPreset(preset.id);
						}}
					>
						<span className="preset-name">{preset.name}</span>
						<span className="preset-reduction">{preset.reduction}</span>
						<span className="preset-desc">{preset.desc}</span>
					</button>
				))}
			</div>

			<div className="options-row">
				<label className="option-label">
					<input
						type="checkbox"
						checked={simplifyEnabled}
						onChange={(event) => setSimplifyEnabled(event.currentTarget.checked)}
					/>
					<span>Mesh simplification</span>
				</label>
				<div className={`simplify-slider ${simplifyEnabled ? 'active' : ''}`}>
					<input
						type="range"
						min={10}
						max={90}
						step={10}
						value={simplifyRatio * 100}
						onChange={(event) => {
							setSimplifyRatio(Number(event.currentTarget.value) / 100);
						}}
					/>
					<span className="simplify-value">{simplifyRatio.toFixed(1)}</span>
				</div>
			</div>

			<button
				type="button"
				className="btn"
				onClick={() => {
					compressAll().catch((error) => {
						console.warn('Compression batch failed:', error);
					});
				}}
				disabled={buttonState.disabled}
			>
				{buttonState.text}
			</button>

			<div className={`log-console ${logOpen ? 'active' : ''}`}>
				<div className="log-header">
					<span className="log-title">Compression log</span>
					<button type="button" className="log-close" title="Close" onClick={() => setLogOpen(false)}>
						&times;
					</button>
				</div>
				<div ref={logsRef} className="log-entries">
					{logs.map((line) => (
						<div key={line.id} className={`log-line${line.type !== 'info' ? ` ${line.type}` : ''}`}>
							<span className="log-time">{line.time}</span>
							{line.message}
						</div>
					))}
				</div>
			</div>

			<footer>
				runs locally via glb-server on port 8080
				<br />
				your files never leave your machine · streaming compression with live progress
			</footer>
		</div>
	);
}

export default App;
