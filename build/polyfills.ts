/**
 * Node.js polyfills for Bun-specific APIs.
 *
 * Injected by the build plugin into the Node.js target bundle.
 * Requires Node 18+ for global Request/Response/ReadableStream.
 */

import { execSync, spawn as nodeSpawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';

// ─── Bun.file() ────────────────────────────────────────────

interface BunFile {
	exists(): Promise<boolean>;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
}

function file(path: string): BunFile {
	return {
		async exists() {
			try {
				await access(path);
				return true;
			} catch {
				return false;
			}
		},
		async arrayBuffer() {
			const buf = await readFile(path);
			return buf.buffer.slice(
				buf.byteOffset,
				buf.byteOffset + buf.byteLength,
			) as ArrayBuffer;
		},
		async text() {
			return readFile(path, 'utf-8');
		},
	};
}

// ─── Bun.write() ───────────────────────────────────────────
// Bun.write auto-creates parent directories; polyfill must too.

async function write(
	path: string,
	data: string | Uint8Array | ArrayBuffer,
): Promise<number> {
	await mkdir(dirname(path), { recursive: true });
	let buf: Buffer;
	if (typeof data === 'string') {
		buf = Buffer.from(data);
	} else if (data instanceof ArrayBuffer) {
		buf = Buffer.from(data);
	} else {
		buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	}
	await writeFile(path, buf);
	return buf.length;
}

// ─── Bun.spawn() ───────────────────────────────────────────
// Returns an object matching the subset of Bun.spawn used in this codebase:
//   proc.exited (Promise<number>), proc.stderr (ReadableStream), proc.kill()

interface SpawnOptions {
	stdout?: 'pipe' | 'ignore';
	stderr?: 'pipe' | 'ignore';
}

function spawn(args: string[], opts?: SpawnOptions) {
	if (!args || args.length === 0) {
		throw new Error(
			'spawn: args must contain at least one element (the command)',
		);
	}
	const [cmd, ...rest] = args;
	if (!cmd) {
		throw new Error(
			'spawn: command (first element of args) must be a non-empty string',
		);
	}
	const child = nodeSpawn(cmd, rest, {
		stdio: [
			'ignore',
			opts?.stdout === 'ignore' ? 'ignore' : 'pipe',
			opts?.stderr === 'pipe' ? 'pipe' : 'ignore',
		],
	});

	// Convert Node Readable to Web ReadableStream so
	// `new Response(proc.stderr).text()` works in Node 18+.
	const stderr = child.stderr
		? (Readable.toWeb(child.stderr) as ReadableStream)
		: new ReadableStream({
				start(c) {
					c.close();
				},
			});

	const exited = new Promise<number>((resolve) => {
		child.on('close', (code) => resolve(code ?? 1));
		child.on('error', () => resolve(1));
	});

	return { exited, stderr, kill: () => child.kill() };
}

// ─── Bun.serve() ───────────────────────────────────────────
// Bridges Bun.serve's route-based API to Node's http.createServer.
// Handlers already use standard Request/Response (global in Node 18+).

type RouteHandler = (req: Request) => Response | Promise<Response>;
type RouteEntry = Response | RouteHandler | Record<string, RouteHandler>;

interface ServeConfig {
	port?: number;
	routes?: Record<string, RouteEntry>;
	fetch?: (req: Request) => Response | Promise<Response>;
	error?: (error: Error) => Response;
}

function serve(config: ServeConfig) {
	const port = config.port ?? 3000;

	const server = createServer(
		async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
			try {
				const url = new URL(
					nodeReq.url ?? '/',
					`http://${nodeReq.headers.host ?? `localhost:${port}`}`,
				);
				const method = nodeReq.method ?? 'GET';

				const headers = new Headers();
				for (const [key, val] of Object.entries(nodeReq.headers)) {
					if (val != null)
						headers.set(key, Array.isArray(val) ? val.join(', ') : val);
				}

				const hasBody = method !== 'GET' && method !== 'HEAD';
				const request = new Request(url.toString(), {
					method,
					headers,
					body: hasBody ? (Readable.toWeb(nodeReq) as ReadableStream) : null,
					duplex: hasBody ? 'half' : undefined,
				});

				let response: Response | undefined;

				// Match route
				if (config.routes) {
					const route = config.routes[url.pathname];
					if (route instanceof Response) {
						// Static responses must be cloned (body is consumed on read)
						response = route.clone() as Response;
					} else if (typeof route === 'function') {
						response = await (route as RouteHandler)(request);
					} else if (route && typeof route === 'object') {
						const handler = (route as Record<string, RouteHandler>)[method];
						if (typeof handler === 'function') {
							response = await handler(request);
						}
					}
				}

				// Fallback handler
				if (!response && config.fetch) {
					response = await config.fetch(request);
				}
				if (!response) {
					response = new Response('Not Found', { status: 404 });
				}

				// Write Web Response → Node ServerResponse
				nodeRes.writeHead(
					response.status,
					Object.fromEntries(response.headers.entries()),
				);
				if (response.body) {
					const reader = response.body.getReader();
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						nodeRes.write(value);
					}
				}
				nodeRes.end();
			} catch (err) {
				if (config.error) {
					try {
						const errResponse = config.error(
							err instanceof Error ? err : new Error(String(err)),
						);
						nodeRes.writeHead(
							errResponse.status,
							Object.fromEntries(errResponse.headers.entries()),
						);
						nodeRes.end(await errResponse.text());
						return;
					} catch {
						/* fall through to generic 500 */
					}
				}
				nodeRes.writeHead(500);
				nodeRes.end('Internal Server Error');
			}
		},
	);

	server.on('error', (err) => {
		if (config.error) {
			config.error(err instanceof Error ? err : new Error(String(err)));
		} else {
			console.error('Server listen error:', err);
			process.exit(1);
		}
	});

	server.listen(port);
	const url = new URL(`http://localhost:${port}/`);
	return { url };
}

// ─── Bun.which() ───────────────────────────────────────────
// Resolves a binary name to its absolute path, like Bun.which.

function which(cmd: string): string | null {
	try {
		const isWin = process.platform === 'win32';
		// Use where.exe explicitly on Windows to avoid PowerShell alias conflicts
		const result = execSync(isWin ? `where.exe ${cmd}` : `command -v ${cmd}`, {
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'ignore'],
		});
		return result.trim().split('\n')[0] || null;
	} catch {
		return null;
	}
}

// ─── Bun namespace (shadows the global) ────────────────────

export const Bun = {
	file,
	write,
	spawn,
	serve,
	which,
	argv: process.argv,
} as const;

// ─── Glob class ────────────────────────────────────────────
// Minimal implementation covering patterns used in the CLI (e.g. *.glb, models/*.glb).

export class Glob {
	private re: RegExp;
	private rawPattern: string;

	constructor(pattern: string) {
		this.rawPattern = pattern;
		const escaped = pattern
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\*\*/g, '\0GLOBSTAR\0')
			.replace(/\*/g, '[^/]*')
			.replace(/\?/g, '[^/]')
			.replace(/\0GLOBSTAR\0/g, '.*');
		this.re = new RegExp(`^${escaped}$`);
	}

	async *scan(opts?: {
		cwd?: string;
		absolute?: boolean;
	}): AsyncGenerator<string> {
		const cwd = opts?.cwd ?? process.cwd();
		const hasGlobstar = this.rawPattern.includes('**');
		const lastSlash = this.rawPattern.lastIndexOf('/');
		const dirPart = lastSlash >= 0 ? this.rawPattern.slice(0, lastSlash) : '';

		// For '**' patterns, find the stable directory prefix before the first '**'
		let searchDir: string;
		if (hasGlobstar) {
			const prefixBeforeGlobstar =
				dirPart.split('**')[0]?.replace(/\/$/, '') || '';
			searchDir = prefixBeforeGlobstar ? join(cwd, prefixBeforeGlobstar) : cwd;
		} else {
			searchDir = dirPart ? join(cwd, dirPart) : cwd;
		}

		let entries: import('node:fs').Dirent[];
		try {
			entries = await readdir(searchDir, {
				withFileTypes: true,
				recursive: hasGlobstar,
			});
		} catch {
			return; // directory doesn't exist
		}

		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (hasGlobstar) {
				// entry.parentPath (Node 20+) or entry.path (Node 18.17+)
				const entryDir =
					(entry as { parentPath?: string }).parentPath ??
					(entry as { path?: string }).path ??
					searchDir;
				const rel = relative(cwd, join(entryDir, entry.name));
				// Normalize path separators on Windows
				const normalized = rel.replace(/\\/g, '/');
				if (this.re.test(normalized)) {
					yield opts?.absolute ? join(cwd, rel) : normalized;
				}
			} else {
				const rel = dirPart ? `${dirPart}/${entry.name}` : entry.name;
				if (this.re.test(rel)) {
					yield opts?.absolute ? join(cwd, rel) : rel;
				}
			}
		}
	}
}

// ─── $ shell template tag ──────────────────────────────────
// Only used for `await $`gltfpack -v`.text()` in the codebase.

export function $(strings: TemplateStringsArray, ...values: unknown[]) {
	const cmd = String.raw(strings, ...values);
	return {
		async text(): Promise<string> {
			return execSync(cmd, { encoding: 'utf-8' });
		},
	};
}
