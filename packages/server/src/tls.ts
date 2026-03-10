import * as x509 from '@peculiar/x509';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TLS_DIR = join(homedir(), '.glb-compressor', 'tls');
const CERT_PATH = join(TLS_DIR, 'cert.pem');
const KEY_PATH = join(TLS_DIR, 'key.pem');

const EC_ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const CERT_VALIDITY_DAYS = 365;

export interface TlsCertPair {
	cert: string;
	key: string;
}

/** Load user-provided certs from `TLS_CERT`/`TLS_KEY` env var paths. */
async function loadCustomCerts(): Promise<TlsCertPair | undefined> {
	const certPath = process.env.TLS_CERT;
	const keyPath = process.env.TLS_KEY;
	if (!certPath || !keyPath) return undefined;

	const [cert, key] = await Promise.all([Bun.file(certPath).text(), Bun.file(keyPath).text()]);
	return { cert, key };
}

/** Export a CryptoKey to PEM-encoded PKCS#8 format. */
async function exportKeyToPem(key: CryptoKey): Promise<string> {
	const exported = await crypto.subtle.exportKey('pkcs8', key);
	const b64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
	const lines = b64.match(/.{1,64}/g) ?? [];
	return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/** Generate a self-signed EC P-256 cert valid for localhost. */
async function generateSelfSignedCert(): Promise<TlsCertPair> {
	const keys = await crypto.subtle.generateKey(EC_ALG, true, ['sign', 'verify']);

	const notBefore = new Date();
	const notAfter = new Date(notBefore.getTime() + CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

	const cert = await x509.X509CertificateGenerator.createSelfSigned({
		serialNumber: '01',
		name: 'CN=localhost',
		notBefore,
		notAfter,
		keys,
		signingAlgorithm: EC_ALG,
		extensions: [
			new x509.BasicConstraintsExtension(false, undefined, true),
			new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
			new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], false),
			new x509.SubjectAlternativeNameExtension([
				{ type: 'dns', value: 'localhost' },
				{ type: 'ip', value: '127.0.0.1' },
				{ type: 'ip', value: '::1' },
			]),
		],
	});

	const certPem = cert.toString('pem');
	const keyPem = await exportKeyToPem(keys.privateKey);

	return { cert: certPem, key: keyPem };
}

/** Write cert pair to disk for reuse across restarts. */
async function cacheCerts(pair: TlsCertPair): Promise<void> {
	await mkdir(TLS_DIR, { recursive: true });
	await Promise.all([Bun.write(CERT_PATH, pair.cert), Bun.write(KEY_PATH, pair.key)]);
}

/**
 * Resolve TLS certs: custom env paths → cached auto-generated → fresh generation.
 * Returns `undefined` unless `TLS=true` or `TLS_CERT`/`TLS_KEY` are set.
 */
export async function resolveTls(): Promise<TlsCertPair | undefined> {
	if (process.env.TLS !== 'true' && !process.env.TLS_CERT) return undefined;

	const custom = await loadCustomCerts();
	if (custom) return custom;

	const certFile = Bun.file(CERT_PATH);
	const keyFile = Bun.file(KEY_PATH);

	if ((await certFile.exists()) && (await keyFile.exists())) {
		const [cert, key] = await Promise.all([certFile.text(), keyFile.text()]);
		return { cert, key };
	}

	const pair = await generateSelfSignedCert();
	await cacheCerts(pair);
	console.log(`Generated self-signed TLS certificate in ${TLS_DIR}`);
	return pair;
}
