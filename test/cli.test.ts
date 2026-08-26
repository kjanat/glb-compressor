import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCli, CLI_PRESETS } from '../cli/command';
import { PRESETS } from '../lib/mod';

async function triangleBytes(): Promise<Uint8Array> {
	const document = new Document();
	const buffer = document.createBuffer();
	const position = document
		.createAccessor()
		.setType('VEC3')
		.setArray(new Float32Array([0, 0, 0, 0.5, 0, 0, 0, 0.5, 0]))
		.setBuffer(buffer);
	const prim = document.createPrimitive().setAttribute('POSITION', position);
	const mesh = document.createMesh('driehoek').addPrimitive(prim);
	const node = document.createNode('driehoek').setMesh(mesh);
	document.createScene().addChild(node);
	return await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document);
}

async function scratchDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), 'glb-cli-'));
}

describe('the CLI preset list', () => {
	test('spells out exactly the presets the library ships', () => {
		expect(new Set<string>(CLI_PRESETS)).toEqual(new Set(Object.keys(PRESETS)));
	});
});

describe('input validation', () => {
	test('no files at all is an error before any file IO', async () => {
		const result = await buildCli().execute([]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.join('')).toContain('Missing required argument <files>');
	});

	test('a simplify ratio outside (0, 1) is rejected in derive', async () => {
		const result = await buildCli().execute(['model.glb', '--simplify', '2']);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.join('')).toContain('Invalid simplify ratio');
	});

	test('a missing file reports per file and exits 1', async () => {
		const dir = await scratchDir();
		const result = await buildCli().execute([join(dir, 'bestaat-niet.glb')]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.join('')).toContain('File not found');
	});
});

describe('compressing through the command', () => {
	test('a GLB lands compressed in the output directory', async () => {
		const dir = await scratchDir();
		const outDir = join(dir, 'uit');
		await mkdir(outDir, { recursive: true });
		const inputPath = join(dir, 'model.glb');
		await writeFile(inputPath, await triangleBytes());

		const result = await buildCli().execute([inputPath, '-o', outDir, '-k']);
		expect(result.exitCode, result.stderr.join('')).toBe(0);
		const written = Bun.file(join(outDir, 'model-compressed.glb'));
		expect(await written.exists()).toBe(true);
		expect(result.stdout.join('')).toContain('model-compressed.glb');
	});

	test('an existing output is refused without --force and taken with it', async () => {
		const dir = await scratchDir();
		const inputPath = join(dir, 'model.glb');
		await writeFile(inputPath, await triangleBytes());
		await writeFile(join(dir, 'model-compressed.glb'), 'bezet');

		const refused = await buildCli().execute([inputPath]);
		expect(refused.exitCode).toBe(1);
		expect(refused.stderr.join('')).toContain('use -f to overwrite');

		const forced = await buildCli().execute([inputPath, '--force']);
		expect(forced.exitCode, forced.stderr.join('')).toBe(0);
	});

	test('root --version answers with the package version', async () => {
		const { version } = await import('pkg');
		const result = await buildCli().execute(['--version']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.join('')).toContain(version);
	});
});
