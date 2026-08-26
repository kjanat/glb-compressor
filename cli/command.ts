/**
 * The `glb-compressor` command surface, built on dreamcli.
 *
 * Declares the typed schema (files, output, preset, simplify, keep-nodes,
 * force) and the action that expands globs and runs the library pipeline per
 * file. `--help`, `--version`/`-V`, `--quiet`/`-q`, and `--json` are owned by
 * the dreamcli root.
 *
 * @module cli/command
 */

import { version } from '#pkg';
import { compress, type CompressPreset, formatBytes, init, parseSimplifyRatio, validateGlbMagic } from '$lib/mod';
import { arg, cli, CLIError, command, flag } from 'dreamcli';
import { glob, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

/**
 * Every preset name, spelled out so `flag.enum()` infers the literal union.
 * `satisfies` guarantees membership in {@link CompressPreset}; the CLI test
 * asserts the list matches `Object.keys(PRESETS)` exactly.
 */
export const CLI_PRESETS = ['default', 'balanced', 'aggressive', 'max'] as const satisfies readonly CompressPreset[];

const GLOB_PATTERN = /[*?[\]{!]/;

async function expandPatterns(patterns: readonly string[]): Promise<string[]> {
	const files: string[] = [];
	for (const pattern of patterns) {
		if (GLOB_PATTERN.test(pattern)) {
			for await (const match of glob(pattern)) {
				files.push(resolve(match));
			}
		} else {
			files.push(resolve(pattern));
		}
	}
	return files;
}

function outputPathFor(inputPath: string, outputDir: string | undefined): string {
	if (outputDir) {
		return join(outputDir, basename(inputPath).replace(/\.(glb|gltf)$/i, '-compressed.glb'));
	}
	return inputPath.replace(/\.(glb|gltf)$/i, '-compressed.glb');
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** The single (default) command: compress every given GLB file. */
export const compressGlb = command('compress')
	.description('Compress GLB/glTF files')
	.example(({ name }) => `${name} model.glb`, 'Compress a single file')
	.example(({ name }) => `${name} ./models/*.glb -o ./compressed/ -p balanced`, 'Batch compress into a directory')
	.example(({ name }) => `${name} model.glb -q -p max`, 'Quiet mode for scripts')
	.arg('files', arg.string().variadic().describe('GLB files to compress (supports glob patterns)'))
	.flag(
		'output',
		flag
			.path({ type: 'directory', create: true })
			.alias('o')
			.describe('Output directory (default: same as input with -compressed suffix)'),
	)
	.flag('preset', flag.enum(CLI_PRESETS).default('default').alias('p').describe('Compression preset'))
	.flag(
		'simplify',
		flag.number().alias('s').describe('Additional mesh simplification ratio, between 0 and 1 (e.g. 0.5 = 50%)'),
	)
	.flag(
		'keep-nodes',
		flag
			.boolean()
			.alias('k')
			.describe('Preserve node hierarchy, node and material names, for parts moved at runtime by name (wheels, doors)'),
	)
	.flag('force', flag.boolean().alias('f').describe('Overwrite existing output files'))
	.derive(({ flags }) => {
		if (flags.simplify === undefined) return { simplifyRatio: undefined };
		const simplifyRatio = parseSimplifyRatio(String(flags.simplify));
		if (simplifyRatio === undefined) {
			throw new CLIError(`Invalid simplify ratio: ${flags.simplify}`, {
				code: 'INVALID_SIMPLIFY_RATIO',
				suggest: 'Pass a ratio between 0 and 1, exclusive',
			});
		}
		return { simplifyRatio };
	})
	.action(async ({ args, flags, ctx, out }) => {
		const files = await expandPatterns(args.files);
		if (files.length === 0) {
			throw new CLIError('No matching files found', { code: 'NO_MATCHING_FILES' });
		}

		out.status(`preset ${flags.preset}, ${files.length} file(s)`);
		await init();

		let failed = 0;
		for (const inputPath of files) {
			const error = await compressOne(inputPath);
			if (error !== undefined) {
				failed++;
				out.error(`${basename(inputPath)}: ${error}`);
			}
		}

		if (failed > 0) {
			out.setExitCode(1);
			out.status(`${files.length - failed} succeeded, ${failed} failed`);
		} else {
			out.status(`All ${files.length} file(s) compressed successfully`);
		}

		/** Compress one file to disk; a string return is the failure to report. */
		async function compressOne(inputPath: string): Promise<string | undefined> {
			const outputPath = outputPathFor(inputPath, flags.output);
			if (resolve(outputPath) === resolve(inputPath)) {
				return `Output path is the same as input (non-standard extension?): ${inputPath}`;
			}
			if (!flags.force && (await pathExists(outputPath))) {
				return `Output file exists: ${outputPath} (use -f to overwrite)`;
			}
			if (!(await pathExists(inputPath))) {
				return `File not found: ${inputPath}`;
			}

			const input = await readFile(inputPath);
			try {
				validateGlbMagic(input);
			} catch (err) {
				return err instanceof Error ? err.message : 'Invalid GLB file';
			}

			const startTime = performance.now();
			const spinner = out.spinner(`Compressing ${basename(inputPath)} (${formatBytes(input.byteLength)})`);
			try {
				const result = await compress(input, {
					simplifyRatio: ctx.simplifyRatio,
					preset: flags.preset,
					keepNodes: flags['keep-nodes'],
					quiet: true,
					onLog: (msg) => out.status(msg),
				});
				await writeFile(outputPath, result.buffer);

				const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
				const ratio = input.byteLength > 0
					? ((1 - result.buffer.byteLength / input.byteLength) * 100).toFixed(1)
					: '0.0';
				spinner.succeed(`${basename(inputPath)} done (${elapsed}s)`);
				out.log(
					`${formatBytes(input.byteLength)} -> ${out.color.bold(formatBytes(result.buffer.byteLength))} `
						+ `${out.color.green(`(-${ratio}%)`)} via ${out.color.magenta(result.method)} -> ${outputPath}`,
				);
				return undefined;
			} catch (err) {
				spinner.fail(`${basename(inputPath)} failed`);
				return err instanceof Error ? err.message : String(err);
			}
		}
	});

/** The CLI root: version, description, and the compress command as default. */
export function buildCli() {
	return cli('glb-compressor').version(version).description('Compress GLB/glTF files').default(compressGlb);
}
