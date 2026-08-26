#!/usr/bin/env node
/**
 * CLI entry point for `glb-compressor`.
 *
 * The command surface lives in {@link module:cli/command}; this file only
 * boots it. Built standalone (bundled and treeshaken) by tsdown into
 * `dist/cli/main.mjs`.
 *
 * @module cli
 */

import { buildCli } from './command';

buildCli().run();
