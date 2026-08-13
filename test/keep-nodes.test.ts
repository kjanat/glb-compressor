import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { describe, expect, test } from 'bun:test';
import { MeshoptDecoder } from 'meshoptimizer';
import { compress, init } from '../lib/mod';

/**
 * `keepNodes` exists for models whose parts are animated at runtime by node
 * name: wheels that spin, doors that slide. The default pipeline flattens and
 * joins a static model into one anonymous node, which silently freezes every
 * such part and bakes the authored orientation into the vertices.
 */

const WHEEL = 'wiel_voor_band';
const FRAME = 'frame';
const WHEEL_TRANSLATION = [0, 0.32, 0.78] as const;

function trianglePart(document: Document, name: string, materialName: string, spread: number): void {
	// Elk materiaal een eigen kleur, zoals in een echt model: identieke materialen
	// voegt gltfpack samen ongeacht hun naam.
	const material =
		document
			.getRoot()
			.listMaterials()
			.find((candidate) => candidate.getName() === materialName) ??
		document.createMaterial(materialName).setBaseColorFactor([spread, 0.1, 0.1, 1]);
	// Per onderdeel eigen geometrie, zoals in een echt model: identieke driehoeken
	// laat dedup() samenvallen en dan verweest het tweede materiaal in de fixture.
	const position = document
		.createAccessor()
		.setType('VEC3')
		.setArray(new Float32Array([0, 0, 0, spread, 0, 0, 0, spread, 0]))
		.setBuffer(document.getRoot().listBuffers()[0] ?? document.createBuffer());
	const prim = document.createPrimitive().setAttribute('POSITION', position).setMaterial(material);
	const mesh = document.createMesh(name).addPrimitive(prim);
	const node = document.createNode(name).setMesh(mesh);
	if (name === WHEEL) node.setTranslation([...WHEEL_TRANSLATION]);
	const scene = document.getRoot().listScenes()[0] ?? document.createScene();
	scene.addChild(node);
}

async function bikeBytes(): Promise<Uint8Array> {
	const document = new Document();
	document.createBuffer();
	trianglePart(document, WHEEL, 'rubber', 0.32);
	trianglePart(document, FRAME, 'paint', 0.7);
	return await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document);
}

async function readResult(buffer: Uint8Array): Promise<Document> {
	await MeshoptDecoder.ready;
	const io = new NodeIO()
		.registerExtensions(ALL_EXTENSIONS)
		.registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
	return await io.readBinary(buffer);
}

describe('keepNodes', () => {
	test('named nodes and their transforms survive compression', async () => {
		await init();
		const result = await compress(await bikeBytes(), { quiet: true, keepNodes: true });
		const document = await readResult(result.buffer);
		const names = document
			.getRoot()
			.listNodes()
			.map((node) => node.getName());
		expect(names, `nodes after compression: ${names.join(', ') || '(none)'}`).toContain(WHEEL);
		expect(names, `nodes after compression: ${names.join(', ') || '(none)'}`).toContain(FRAME);

		const wheel = document
			.getRoot()
			.listNodes()
			.find((node) => node.getName() === WHEEL);
		const translation = wheel?.getTranslation() ?? [0, 0, 0];
		for (const [axis, expected] of WHEEL_TRANSLATION.entries()) {
			expect(translation[axis], `wheel translation baked away: [${translation.join(', ')}]`).toBeCloseTo(expected, 3);
		}
	});

	test('material names survive so runtime tinting can find them', async () => {
		await init();
		const result = await compress(await bikeBytes(), { quiet: true, keepNodes: true });
		const document = await readResult(result.buffer);
		const materials = document
			.getRoot()
			.listMaterials()
			.map((material) => material.getName());
		expect(materials, `materials after compression: ${materials.join(', ')}`).toContain('paint');
	});
});
