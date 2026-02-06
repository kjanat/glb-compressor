#!/usr/bin/env bun
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Glob } from 'bun';
import { version } from 'pkg';
import {
	type CompressPreset,
	compress,
	formatBytes,
	init,
	PRESETS,
	parseSimplifyRatio,
	validateGlbMagic,
} from '$lib/mod';

const VALID_PRESETS = Object.keys(PRESETS) as CompressPreset[];

// ANSI colors
const c = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	magenta: '\x1b[35m',
	cyan: '\x1b[36m',
};

function printHelp() {
	console.log(`
${c.bold}${c.cyan}glb-compress${c.reset} - Compress GLB/glTF files

${c.bold}USAGE${c.reset}
  glb-compress <files...> [options]
  glb-compress ./models/*.glb -o ./compressed/

${c.bold}ARGUMENTS${c.reset}
  files         GLB files to compress (supports glob patterns)

${c.bold}OPTIONS${c.reset}
  -o, --output <dir>    Output directory (default: same as input with -compressed suffix)
  -p, --preset <name>   Compression preset (default: "default")
  -s, --simplify <0-1>  Additional mesh simplification ratio (e.g., 0.5 = 50%)
  -q, --quiet           Suppress progress output
  -f, --force           Overwrite existing files
  -h, --help            Show this help
  -v, --version         Show version

${c.bold}PRESETS${c.reset}
  default       Conservative, preserves all detail
  balanced      Moderate anim quantization, 24Hz resample
  aggressive    Strong anim quantization, 15Hz resample (best for avatars)
  max           Aggressive + supercompression + lower vertex precision

${c.bold}EXAMPLES${c.reset}
  ${c.dim}# Compress single file${c.reset}
  glb-compress model.glb

  ${c.dim}# Compress with aggressive preset${c.reset}
  glb-compress model.glb -p aggressive

  ${c.dim}# Compress multiple files to output directory${c.reset}
  glb-compress *.glb -o ./compressed/ -p balanced

  ${c.dim}# Quiet mode for scripts${c.reset}
  glb-compress model.glb -q -p max
`);
}

interface Options {
	output?: string;
	simplify?: number;
	preset: CompressPreset;
	quiet: boolean;
	force: boolean;
}

async function compressFile(
	inputPath: string,
	options: Options,
): Promise<{ success: boolean; error?: string }> {
	const { output, simplify, quiet, force } = options;

	// Determine output path
	let outputPath: string;
	if (output) {
		outputPath = join(
			output,
			basename(inputPath).replace(/\.(glb|gltf)$/i, '-compressed.glb'),
		);
	} else {
		outputPath = inputPath.replace(/\.(glb|gltf)$/i, '-compressed.glb');
	}

	// Check if output exists
	if (!force && (await Bun.file(outputPath).exists())) {
		return {
			success: false,
			error: `Output file exists: ${outputPath} (use -f to overwrite)`,
		};
	}

	// Read input file
	const inputFile = Bun.file(inputPath);
	if (!(await inputFile.exists())) {
		return { success: false, error: `File not found: ${inputPath}` };
	}

	const input = new Uint8Array(await inputFile.arrayBuffer());

	// Validate GLB
	try {
		validateGlbMagic(input);
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : 'Invalid GLB file',
		};
	}

	const startTime = performance.now();

	if (!quiet) {
		process.stdout.write(
			`${c.cyan}Compressing${c.reset} ${basename(inputPath)} ${c.dim}(${formatBytes(input.byteLength)})${c.reset}...`,
		);
	}

	try {
		const result = await compress(input, {
			simplifyRatio: simplify,
			preset: options.preset,
			quiet,
		});

		// Ensure output directory exists
		if (output) {
			await Bun.write(join(output, '.keep'), ''); // Create dir
		}

		// Write output
		await Bun.write(outputPath, result.buffer);

		const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
		const ratio = (
			(1 - result.buffer.byteLength / input.byteLength) *
			100
		).toFixed(1);

		if (!quiet) {
			console.log(
				` ${c.green}done${c.reset} ${c.dim}(${elapsed}s)${c.reset}\n` +
					`  ${formatBytes(input.byteLength)} -> ${c.bold}${formatBytes(result.buffer.byteLength)}${c.reset} ` +
					`${c.green}(-${ratio}%)${c.reset} via ${c.magenta}${result.method}${c.reset}\n` +
					`  ${c.dim}-> ${outputPath}${c.reset}`,
			);
		}

		return { success: true };
	} catch (err) {
		if (!quiet) {
			console.log(` ${c.red}failed${c.reset}`);
		}
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function main() {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			output: { type: 'string', short: 'o' },
			preset: { type: 'string', short: 'p' },
			simplify: { type: 'string', short: 's' },
			quiet: { type: 'boolean', short: 'q', default: false },
			force: { type: 'boolean', short: 'f', default: false },
			help: { type: 'boolean', short: 'h', default: false },
			version: { type: 'boolean', short: 'v', default: false },
		},
		allowPositionals: true,
	});

	if (values.help) {
		printHelp();
		process.exit(0);
	}

	if (values.version) {
		console.log(`glb-compress v${version}`);
		process.exit(0);
	}

	if (positionals.length === 0) {
		console.error(`${c.red}Error:${c.reset} No input files specified\n`);
		printHelp();
		process.exit(1);
	}

	// Parse preset
	const preset: CompressPreset = (values.preset as CompressPreset) ?? 'default';
	if (!VALID_PRESETS.includes(preset)) {
		console.error(
			`${c.red}Error:${c.reset} Invalid preset: "${values.preset}" (must be one of: ${VALID_PRESETS.join(', ')})`,
		);
		process.exit(1);
	}

	// Parse simplify ratio
	const simplify = values.simplify
		? parseSimplifyRatio(values.simplify)
		: undefined;
	if (values.simplify && simplify === undefined) {
		console.error(
			`${c.red}Error:${c.reset} Invalid simplify ratio: ${values.simplify} (must be between 0 and 1)`,
		);
		process.exit(1);
	}

	// Expand globs
	const files: string[] = [];
	for (const pattern of positionals) {
		if (pattern.includes('*')) {
			const glob = new Glob(pattern);
			for await (const file of glob.scan({
				cwd: process.cwd(),
				absolute: true,
			})) {
				files.push(file);
			}
		} else {
			files.push(resolve(pattern));
		}
	}

	if (files.length === 0) {
		console.error(`${c.red}Error:${c.reset} No matching files found`);
		process.exit(1);
	}

	// Create output directory if specified
	if (values.output) {
		await Bun.write(join(values.output, '.keep'), '');
	}

	const options: Options = {
		output: values.output,
		simplify,
		preset,
		quiet: values.quiet ?? false,
		force: values.force ?? false,
	};

	if (!options.quiet) {
		console.log(`\n${c.bold}${c.cyan}glb-compress${c.reset} v${version}\n`);
		console.log(`Preset: ${c.bold}${preset}${c.reset}`);
		console.log(`Processing ${c.bold}${files.length}${c.reset} file(s)...\n`);
	}

	// Initialize compression library
	await init();

	let succeeded = 0;
	let failed = 0;

	for (const file of files) {
		const result = await compressFile(file, options);
		if (result.success) {
			succeeded++;
		} else {
			failed++;
			if (!options.quiet) {
				console.error(`  ${c.red}Error:${c.reset} ${result.error}`);
			}
		}
	}

	if (!options.quiet) {
		console.log();
		if (failed === 0) {
			console.log(
				`${c.green}All ${succeeded} file(s) compressed successfully${c.reset}`,
			);
		} else {
			console.log(
				`${c.yellow}Completed: ${succeeded} succeeded, ${failed} failed${c.reset}`,
			);
		}
	}

	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error(`${c.red}Fatal error:${c.reset}`, err);
	process.exit(1);
});
