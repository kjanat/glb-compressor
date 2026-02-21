#!/usr/bin/env bun

import sharp from 'sharp';
import pkg from '../package.json' with { type: 'json' };

const REPO: string = (await Bun.$`git config --get remote.origin.url`.text())
	.trim()
	.replaceAll(
		/^(?:(?:https?:\/\/|ssh:\/\/)?(?:git@)?)?([^/:]+)[:/](.+?)(?:\.git)?$/g,
		'$1/$2',
	);

// Images should be at least 640×320px (1280×640px for best display).
const [DESIGN_WIDTH, DESIGN_HEIGHT] = [1280, 640];

// To improve rasterization quality, we render at 2x the design dimensions and let GitHub downscale it.
const [WIDTH, HEIGHT] = [DESIGN_WIDTH * 2, DESIGN_HEIGHT * 2];

const DEFAULT_OUTPUT = 'social-preview.png';

type CubeOptions = {
	x: number;
	y: number;
	front: number;
	depth: number;
	color: string;
	opacity: number;
	filter?: string;
	frontStroke: number;
	edgeStroke: number;
};

type Badge = {
	label: string;
	x: number;
	width: number;
};

type Dot = {
	x: number;
	y: number;
	r: number;
	color: string;
};

const version =
	typeof pkg?.version === 'string' && pkg.version.trim()
		? pkg.version.trim()
		: '0.0.0';

const BADGES: Badge[] = [
	{ label: 'CLI', x: 0, width: 72 },
	{ label: 'Server', x: 88, width: 100 },
	{ label: 'Library', x: 204, width: 104 },
];

const DOTS: Dot[] = [
	{ x: 100, y: 150, r: 1.5, color: '#58a6ff' },
	{ x: 150, y: 130, r: 1, color: '#58a6ff' },
	{ x: 350, y: 170, r: 1.5, color: '#bc8cff' },
	{ x: 380, y: 430, r: 1, color: '#bc8cff' },
	{ x: 120, y: 470, r: 1.5, color: '#58a6ff' },
	{ x: 300, y: 500, r: 1, color: '#58a6ff' },
	{ x: 430, y: 200, r: 1, color: '#bc8cff' },
	{ x: 90, y: 400, r: 1, color: '#58a6ff' },
];

const escapeXml = (value: string): string =>
	value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');

const cubeWireframe = ({
	x,
	y,
	front,
	depth,
	color,
	opacity,
	filter,
	frontStroke,
	edgeStroke,
}: CubeOptions): string => {
	const backX = depth;
	const backY = -depth;
	const fx2 = front;
	const fy2 = front;
	const bx2 = depth + front;
	const by2 = -depth + front;

	return `
  <g transform="translate(${x}, ${y})"${filter ? ` filter="${filter}"` : ''} opacity="${opacity}">
    <!-- Front face -->
    <polygon points="0,0 ${fx2},0 ${fx2},${fy2} 0,${fy2}" fill="none" stroke="${color}" stroke-width="${frontStroke}"/>
    <!-- Back face -->
    <polygon points="${backX},${backY} ${bx2},${backY} ${bx2},${by2} ${backX},${by2}" fill="none" stroke="${color}" stroke-width="${edgeStroke}"/>
    <!-- Connecting edges -->
    <line x1="0" y1="0" x2="${backX}" y2="${backY}" stroke="${color}" stroke-width="${edgeStroke}"/>
    <line x1="${fx2}" y1="0" x2="${bx2}" y2="${backY}" stroke="${color}" stroke-width="${edgeStroke}"/>
    <line x1="${fx2}" y1="${fy2}" x2="${bx2}" y2="${by2}" stroke="${color}" stroke-width="${edgeStroke}"/>
    <line x1="0" y1="${fy2}" x2="${backX}" y2="${by2}" stroke="${color}" stroke-width="${edgeStroke}"/>
  </g>`;
};

const renderBadge = ({ label, x, width }: Badge): string => {
	const textX = x + width / 2;
	return `
      <rect x="${x}" y="0" width="${width}" height="34" rx="7" fill="#161b22" stroke="#30363d" stroke-width="1.5"/>
      <text x="${textX}" y="22" font-family="'SF Mono','Cascadia Code','Fira Code','Consolas',monospace" font-size="14" fill="#58a6ff" text-anchor="middle" font-weight="600">${escapeXml(label)}</text>`;
};

const renderDot = ({ x, y, r, color }: Dot): string =>
	`<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>`;

const buildSvg = (): string => `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${DESIGN_WIDTH}" height="${DESIGN_HEIGHT}" viewBox="0 0 ${DESIGN_WIDTH} ${DESIGN_HEIGHT}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="glb-compressor social preview">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0d1117"/>
      <stop offset="50%" style="stop-color:#161b22"/>
      <stop offset="100%" style="stop-color:#1a1030"/>
    </linearGradient>

    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#58a6ff"/>
      <stop offset="100%" style="stop-color:#bc8cff"/>
    </linearGradient>

    <filter id="glow">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <filter id="cubeGlow">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#ffffff" stroke-width="0.3" opacity="0.05"/>
    </pattern>

    <linearGradient id="arrowGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#58a6ff;stop-opacity:0.8"/>
      <stop offset="100%" style="stop-color:#bc8cff;stop-opacity:0.8"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${DESIGN_WIDTH}" height="${DESIGN_HEIGHT}" fill="url(#bg)"/>
  <rect width="${DESIGN_WIDTH}" height="${DESIGN_HEIGHT}" fill="url(#grid)"/>

  <!-- Ambient glow -->
  <ellipse cx="220" cy="320" rx="250" ry="250" fill="#58a6ff" opacity="0.03"/>
  <ellipse cx="220" cy="320" rx="150" ry="150" fill="#bc8cff" opacity="0.04"/>

  <!-- Wireframe cubes -->
  ${cubeWireframe({
		x: 140,
		y: 240,
		front: 120,
		depth: 50,
		color: '#58a6ff',
		opacity: 0.35,
		filter: 'url(#cubeGlow)',
		frontStroke: 2,
		edgeStroke: 1.5,
	})}

  <g transform="translate(295, 295)" filter="url(#glow)">
    <line x1="0" y1="0" x2="35" y2="0" stroke="url(#arrowGrad)" stroke-width="2.5" stroke-linecap="round"/>
    <polygon points="35,-5 45,0 35,5" fill="#bc8cff" opacity="0.8"/>
    <line x1="0" y1="14" x2="35" y2="14" stroke="url(#arrowGrad)" stroke-width="2.5" stroke-linecap="round"/>
    <polygon points="35,9 45,14 35,19" fill="#bc8cff" opacity="0.8"/>
  </g>

  ${cubeWireframe({
		x: 350,
		y: 270,
		front: 70,
		depth: 30,
		color: '#bc8cff',
		opacity: 0.7,
		filter: 'url(#cubeGlow)',
		frontStroke: 2.5,
		edgeStroke: 2,
	})}

  <!-- Mesh dots -->
  <g opacity="0.15">
    ${DOTS.map(renderDot).join('\n    ')}
  </g>

  <!-- Main content -->
  <g transform="translate(520, 0)">
    <text x="0" y="230" font-family="'SF Mono','Cascadia Code','Fira Code','JetBrains Mono','Consolas',monospace" font-size="56" font-weight="700" fill="#e6edf3" letter-spacing="-1">
      glb-compressor
    </text>

    <text x="0" y="280" font-family="'Inter','Segoe UI','Helvetica Neue','Arial',sans-serif" font-size="22" fill="#8b949e" letter-spacing="0.5">
      Multi-phase GLB/glTF 3D model compression
    </text>

    <g transform="translate(0, 320)">
      ${BADGES.map(renderBadge).join('\n      ')}
    </g>

    <g transform="translate(0, 375)">
      <text x="0" y="16" font-family="'Inter','Segoe UI','Helvetica Neue','Arial',sans-serif" font-size="15" fill="#484f58" letter-spacing="0.3">
        Draco &#183; Meshopt &#183; gltfpack &#183; WebP &#183; Bun + Node.js
      </text>
    </g>
  </g>

  <rect x="0" y="${DESIGN_HEIGHT - 8}" width="${DESIGN_WIDTH}" height="8" fill="url(#arrowGrad)" opacity="0.2"/>

  <text x="${DESIGN_WIDTH - 40}" y="40" font-family="'SF Mono','Consolas',monospace" font-size="13" fill="#484f58" text-anchor="end">v${escapeXml(version)}</text>
</svg>`;

const isMultiplexer = (): boolean =>
	Boolean(
		process.env.TERM?.startsWith('screen') ||
			process.env.TERM?.startsWith('tmux') ||
			process.env.TMUX,
	);

const wrapForMultiplexer = (sequence: string): string =>
	isMultiplexer()
		? `\u001BPtmux;${sequence.replaceAll('\u001B', '\u001B\u001B')}\u001B\\`
		: sequence;

/** Create a clickable terminal hyperlink (OSC 8), with tmux/screen support + plain fallback. */
export const link = (text: string, url: string): string => {
	if (!process.stdout.isTTY) return `${text} (${url})`;

	const open = wrapForMultiplexer(`\u001B]8;;${url}\u0007`);
	const close = wrapForMultiplexer(`\u001B]8;;\u0007`);
	return `${open}${text}${close}`;
};

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

async function main(): Promise<void> {
	const outputPath = Bun.argv[2] ?? DEFAULT_OUTPUT;
	const svg = buildSvg();

	// `density` improves text/filter rasterization quality for SVG -> PNG.
	const { data } = await sharp(Buffer.from(svg), {
		density: 72 * (WIDTH / DESIGN_WIDTH),
	})
		.png({ compressionLevel: 9, effort: 10 })
		.toBuffer({ resolveWithObject: true });

	await Bun.write(outputPath, data);

	const settingsUrl = `https://${REPO}/settings`;
	const socialPreviewUrl = `${settingsUrl}/#:~:text=Social%20preview`;

	console.log(
		`Generated ${outputPath} (${WIDTH}x${HEIGHT}, ${kb(data.byteLength)})`,
	);
	console.info(`Repo settings: ${link(`${REPO}/settings`, settingsUrl)}`);
	console.info(
		`Social preview section: ${link('Open Social preview', socialPreviewUrl)}`,
	);
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
