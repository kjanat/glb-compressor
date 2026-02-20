import sharp from 'sharp';

const WIDTH = 1280;
const HEIGHT = 640;

// Design: dark gradient background with a 3D cube wireframe motif,
// project name, tagline, and feature badges

const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Background gradient: deep dark blue to dark purple -->
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0d1117"/>
      <stop offset="50%" style="stop-color:#161b22"/>
      <stop offset="100%" style="stop-color:#1a1030"/>
    </linearGradient>

    <!-- Accent gradient for the cube -->
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#58a6ff"/>
      <stop offset="100%" style="stop-color:#bc8cff"/>
    </linearGradient>

    <!-- Glow filter -->
    <filter id="glow">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <!-- Soft glow for the cube -->
    <filter id="cubeGlow">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <!-- Grid pattern for subtle background texture -->
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#ffffff" stroke-width="0.3" opacity="0.05"/>
    </pattern>

    <!-- Compression arrows gradient -->
    <linearGradient id="arrowGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#58a6ff;stop-opacity:0.8"/>
      <stop offset="100%" style="stop-color:#bc8cff;stop-opacity:0.8"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#grid)"/>

  <!-- Subtle radial glow behind cube area -->
  <ellipse cx="220" cy="320" rx="250" ry="250" fill="#58a6ff" opacity="0.03"/>
  <ellipse cx="220" cy="320" rx="150" ry="150" fill="#bc8cff" opacity="0.04"/>

  <!-- 3D Cube wireframe — large cube (original model) -->
  <g transform="translate(140, 240)" filter="url(#cubeGlow)" opacity="0.35">
    <!-- Front face -->
    <polygon points="0,0 120,0 120,120 0,120" fill="none" stroke="#58a6ff" stroke-width="2"/>
    <!-- Back face -->
    <polygon points="50,-50 170,-50 170,70 50,70" fill="none" stroke="#58a6ff" stroke-width="1.5"/>
    <!-- Connecting edges -->
    <line x1="0" y1="0" x2="50" y2="-50" stroke="#58a6ff" stroke-width="1.5"/>
    <line x1="120" y1="0" x2="170" y2="-50" stroke="#58a6ff" stroke-width="1.5"/>
    <line x1="120" y1="120" x2="170" y2="70" stroke="#58a6ff" stroke-width="1.5"/>
    <line x1="0" y1="120" x2="50" y2="70" stroke="#58a6ff" stroke-width="1.5"/>
  </g>

  <!-- Compression arrows -->
  <g transform="translate(295, 295)" filter="url(#glow)">
    <!-- Arrow 1 -->
    <line x1="0" y1="0" x2="35" y2="0" stroke="url(#arrowGrad)" stroke-width="2.5" stroke-linecap="round"/>
    <polygon points="35,-5 45,0 35,5" fill="#bc8cff" opacity="0.8"/>
    <!-- Arrow 2 -->
    <line x1="0" y1="14" x2="35" y2="14" stroke="url(#arrowGrad)" stroke-width="2.5" stroke-linecap="round"/>
    <polygon points="35,9 45,14 35,19" fill="#bc8cff" opacity="0.8"/>
  </g>

  <!-- 3D Cube wireframe — small cube (compressed model) -->
  <g transform="translate(350, 270)" filter="url(#cubeGlow)" opacity="0.7">
    <!-- Front face -->
    <polygon points="0,0 70,0 70,70 0,70" fill="none" stroke="#bc8cff" stroke-width="2.5"/>
    <!-- Back face -->
    <polygon points="30,-30 100,-30 100,40 30,40" fill="none" stroke="#bc8cff" stroke-width="2"/>
    <!-- Connecting edges -->
    <line x1="0" y1="0" x2="30" y2="-30" stroke="#bc8cff" stroke-width="2"/>
    <line x1="70" y1="0" x2="100" y2="-30" stroke="#bc8cff" stroke-width="2"/>
    <line x1="70" y1="70" x2="100" y2="40" stroke="#bc8cff" stroke-width="2"/>
    <line x1="0" y1="70" x2="30" y2="40" stroke="#bc8cff" stroke-width="2"/>
  </g>

  <!-- Scattered small dots / vertices for "mesh" feel -->
  <g opacity="0.15">
    <circle cx="100" cy="150" r="1.5" fill="#58a6ff"/>
    <circle cx="150" cy="130" r="1" fill="#58a6ff"/>
    <circle cx="350" cy="170" r="1.5" fill="#bc8cff"/>
    <circle cx="380" cy="430" r="1" fill="#bc8cff"/>
    <circle cx="120" cy="470" r="1.5" fill="#58a6ff"/>
    <circle cx="300" cy="500" r="1" fill="#58a6ff"/>
    <circle cx="430" cy="200" r="1" fill="#bc8cff"/>
    <circle cx="90" cy="400" r="1" fill="#58a6ff"/>
  </g>

  <!-- Main content area -->
  <g transform="translate(520, 0)">
    <!-- Project name -->
    <text x="0" y="230" font-family="'SF Mono','Cascadia Code','Fira Code','JetBrains Mono','Consolas',monospace" font-size="56" font-weight="700" fill="#e6edf3" letter-spacing="-1">
      glb-compressor
    </text>

    <!-- Tagline -->
    <text x="0" y="280" font-family="'Inter','Segoe UI','Helvetica Neue','Arial',sans-serif" font-size="22" fill="#8b949e" letter-spacing="0.5">
      Multi-phase GLB/glTF 3D model compression
    </text>

    <!-- Feature badges row -->
    <g transform="translate(0, 320)">
      <!-- CLI badge -->
      <rect x="0" y="0" width="72" height="34" rx="7" fill="#161b22" stroke="#30363d" stroke-width="1.5"/>
      <text x="36" y="22" font-family="'SF Mono','Cascadia Code','Fira Code','Consolas',monospace" font-size="14" fill="#58a6ff" text-anchor="middle" font-weight="600">CLI</text>

      <!-- Server badge -->
      <rect x="88" y="0" width="100" height="34" rx="7" fill="#161b22" stroke="#30363d" stroke-width="1.5"/>
      <text x="138" y="22" font-family="'SF Mono','Cascadia Code','Fira Code','Consolas',monospace" font-size="14" fill="#58a6ff" text-anchor="middle" font-weight="600">Server</text>

      <!-- Library badge -->
      <rect x="204" y="0" width="104" height="34" rx="7" fill="#161b22" stroke="#30363d" stroke-width="1.5"/>
      <text x="256" y="22" font-family="'SF Mono','Cascadia Code','Fira Code','Consolas',monospace" font-size="14" fill="#58a6ff" text-anchor="middle" font-weight="600">Library</text>
    </g>

    <!-- Tech tags row -->
    <g transform="translate(0, 375)">
      <text x="0" y="16" font-family="'Inter','Segoe UI','Helvetica Neue','Arial',sans-serif" font-size="15" fill="#484f58" letter-spacing="0.3">
        Draco &#183; Meshopt &#183; gltfpack &#183; WebP &#183; Bun + Node.js
      </text>
    </g>
  </g>

  <!-- Bottom accent line -->
  <rect x="0" y="632" width="${WIDTH}" height="8" fill="url(#arrowGrad)" opacity="0.6"/>

  <!-- Top-right subtle version tag -->
  <text x="${WIDTH - 40}" y="40" font-family="'SF Mono','Consolas',monospace" font-size="13" fill="#484f58" text-anchor="end">v1.0.2</text>
</svg>`;

const buffer = Buffer.from(svg);
const output = await sharp(buffer)
	.resize(WIDTH, HEIGHT)
	.png({ compressionLevel: 9, quality: 95 })
	.toBuffer();

await Bun.write('social-preview.png', output);

const stats = new Blob([output]);
console.log(`Generated social-preview.png (${WIDTH}x${HEIGHT}, ${(stats.size / 1024).toFixed(1)} KB)`);
