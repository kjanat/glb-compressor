import { describe, expect, test } from 'vitest';

import { parseCompressRequest } from '../src/http';

const GLB_MAGIC = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);

async function parseForm(form: FormData) {
	return parseCompressRequest(
		new Request('http://localhost/compress', {
			method: 'POST',
			body: form,
		}),
		'test-request',
		false,
	);
}

describe('parseCompressRequest multipart parsing', () => {
	test('parses a GLB file and form options', async () => {
		const form = new FormData();
		form.append('file', new File([GLB_MAGIC], 'model.glb'));
		form.append('preset', 'aggressive');
		form.append('simplify', '0.5');

		const parsed = await parseForm(form);
		if (parsed instanceof Response) {
			throw new Error(`Unexpected error response: ${parsed.status}`);
		}

		expect(parsed.input).toEqual(GLB_MAGIC);
		expect(parsed.filename).toBe('model.glb');
		expect(parsed.preset).toBe('aggressive');
		expect(parsed.simplifyRatio).toBe(0.5);
		expect(parsed.resources).toBeUndefined();
	});

	test('collects uploaded resources for glTF input', async () => {
		const form = new FormData();
		form.append('file', new File(['{}'], 'scene.gltf'));
		form.append('resource', new File([new Uint8Array([1, 2, 3])], 'buffer.bin'));

		const parsed = await parseForm(form);
		if (parsed instanceof Response) {
			throw new Error(`Unexpected error response: ${parsed.status}`);
		}

		expect(parsed.input).toEqual(new TextEncoder().encode('{}'));
		expect(parsed.resources).toEqual({ 'buffer.bin': new Uint8Array([1, 2, 3]) });
	});

	test('returns a client error for malformed multipart data', async () => {
		const parsed = await parseCompressRequest(
			new Request('http://localhost/compress', {
				method: 'POST',
				headers: { 'Content-Type': 'multipart/form-data; boundary=broken' },
				body: 'not multipart data',
			}),
			'test-request',
			false,
		);

		expect(parsed).toBeInstanceOf(Response);
		if (parsed instanceof Response) {
			expect(parsed.status).toBe(400);
		}
	});
});
