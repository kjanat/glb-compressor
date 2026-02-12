# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- LICENSE file (MIT).
- npm badge and install instructions in README.
- `description`, `keywords` in package.json for npm discoverability.
- Server section in README explaining `glb-server` purpose.
- JSDoc docstrings for `BunFile` polyfill helpers.

### Changed

- CLI binary renamed from `glb-compress` to `glb-compressor`.
- README examples now use installed binaries instead of `bun run cli`.
- Publish workflow uses `bun pm version from-git` and inlines YAML formatting.

### Fixed

- Publish workflow environment URL output now references correct step id.

## [0.0.2] - 2026-02-12

### Changed

- Repository field in package.json expanded to full `{ type, url }` format.
- Bin paths switched from `./dist/` to `dist/` (no leading dot).

## [0.0.1] - 2026-02-12

### Added

- `bytes()` method on `BunFile` polyfill for Node.js compatibility.

### Changed

- Tarball `files` globs narrowed to `**/*.*js` to exclude sourcemaps.

## [0.0.0] - 2026-02-12

### Added

- Multi-phase GLB/glTF compression pipeline with 5 phases: cleanup, geometry,
  GPU optimizations, animation/weights, and texture compression.
- Automatic skinned-model detection — skips destructive transforms on skeleton
  hierarchies.
- CLI with preset selection (`default`, `balanced`, `aggressive`, `max`),
  simplification ratio, batch processing, and quiet mode.
- HTTP server with `/compress` (synchronous) and `/compress-stream` (SSE)
  endpoints.
- Library API exporting `compress()`, `init()`, and individual transforms.
- Multi-target build system (Bun, Bun bytecode, Node.js) with Node.js polyfills
  for `Bun.file`, `Bun.write`, and `Bun.$`.
- TypeScript declaration generation.
- WebP texture compression via sharp (max 1024x1024).
- gltfpack integration with automatic fallback to meshopt WASM.
- Draco decompression for handling pre-compressed input models.
- README with usage docs, preset benchmarks, and pipeline diagram.
- GitHub Actions: autofix CI, Claude PR assistant, npm publish on release.

[Unreleased]: https://github.com/kjanat/glb-compressor/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/kjanat/glb-compressor/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/kjanat/glb-compressor/compare/v0.0.0...v0.0.1
[0.0.0]: https://github.com/kjanat/glb-compressor/releases/tag/v0.0.0
