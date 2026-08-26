import { createSelfSignedCertificate, parseCertificatePemOrThrow } from 'micro509';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TLS_DIR = join(homedir(), '.glb-compressor', 'tls');
const CERT_PATH = join(TLS_DIR, 'cert.pem');
const KEY_PATH = join(TLS_DIR, 'key.pem');

const CERT_VALIDITY_DAYS = 365;

export interface TlsCertPair {
	cert: string;
	key: string;
}

/** Load user-provided certs from `TLS_CERT`/`TLS_KEY` env var paths. */
async function loadCustomCerts(): Promise<TlsCertPair | undefined> {
	const certPath = process.env.TLS_CERT;
	const keyPath = process.env.TLS_KEY;

	if (certPath && !keyPath) {
		throw new Error('TLS_CERT is set but TLS_KEY is missing — provide both or neither');
	}
	if (!certPath && keyPath) {
		throw new Error('TLS_KEY is set but TLS_CERT is missing — provide both or neither');
	}

	if (!certPath || !keyPath) return undefined;

	const [cert, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')]);
	return { cert, key };
}

/** Generate a self-signed EC P-256 cert valid for localhost. */
async function generateSelfSignedCert(): Promise<TlsCertPair> {
	const { certificate, keyPair } = await createSelfSignedCertificate({
		subject: { commonName: 'localhost' },
		algorithm: { kind: 'ecdsa', curve: 'P-256' },
		validity: { days: CERT_VALIDITY_DAYS },
		extensions: {
			basicConstraints: { ca: false },
			keyUsage: ['digitalSignature'],
			extendedKeyUsage: ['serverAuth'],
			subjectAltNames: [
				{ type: 'dns', value: 'localhost' },
				{ type: 'ip', value: '127.0.0.1' },
				{ type: 'ip', value: '::1' },
			],
		},
	});

	const keyPem = await keyPair.exportPkcs8Pem();

	return { cert: certificate.pem, key: keyPem };
}

/** Write cert pair to disk for reuse across restarts. */
async function cacheCerts(pair: TlsCertPair): Promise<void> {
	await mkdir(TLS_DIR, { recursive: true });
	await Promise.all([writeFile(CERT_PATH, pair.cert), writeFile(KEY_PATH, pair.key)]);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve TLS certs: custom env paths → cached auto-generated → fresh generation.
 * Returns `undefined` unless `TLS=true` or `TLS_CERT`/`TLS_KEY` are set.
 */
export async function resolveTls(): Promise<TlsCertPair | undefined> {
	if (process.env.TLS !== 'true' && !process.env.TLS_CERT) return undefined;

	const custom = await loadCustomCerts();
	if (custom) return custom;

	if ((await fileExists(CERT_PATH)) && (await fileExists(KEY_PATH))) {
		const [cert, key] = await Promise.all([readFile(CERT_PATH, 'utf8'), readFile(KEY_PATH, 'utf8')]);
		try {
			const parsed = parseCertificatePemOrThrow(cert);
			if (parsed.notAfter.getTime() > Date.now()) return { cert, key };
			console.log('Cached TLS certificate expired, regenerating…');
		} catch {
			console.log('Failed to parse cached TLS certificate, regenerating…');
		}
	}

	const pair = await generateSelfSignedCert();
	await cacheCerts(pair);
	console.log(`Generated self-signed TLS certificate in ${TLS_DIR}`);
	return pair;
}
