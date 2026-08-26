#!/usr/bin/env node

/** Build the Node.js runtime bundles and TypeScript declarations. */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

async function run(command: string, args: string[]): Promise<void> {
	await new Promise<void>((resolveRun, reject) => {
		const child = spawn(command, args, { stdio: 'inherit' });
		child.once('error', reject);
		child.once('close', (code, signal) => {
			if (code === 0) {
				resolveRun();
				return;
			}
			reject(new Error(`${command} failed${signal === null ? ` with exit code ${code}` : ` from signal ${signal}`}`));
		});
	});
}

async function build(): Promise<void> {
	await rm('dist', { recursive: true, force: true });
	const start = performance.now();

	console.log('Building Node.js bundles...');
	await run(process.execPath, [resolve('node_modules/tsdown/dist/run.mjs')]);

	console.log('Generating TypeScript declarations...');
	await run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json']);

	const elapsed = ((performance.now() - start) / 1000).toFixed(2);
	console.log(`Done in ${elapsed}s`);
	console.log('  dist/node/  Node.js library and server bundles');
	console.log('  dist/cli/   Node.js CLI bundle');
	console.log('  dist/types/ TypeScript declarations');
}

void build().catch((error: unknown) => {
	console.error('Build error:', error);
	process.exitCode = 1;
});
