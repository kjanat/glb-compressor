# glb-compressor

Multi-phase GLB/glTF 3D model compression toolkit. Bun-first monorepo with
dual-runtime (Bun + Node.js) build. CLI (`glb-compressor`), HTTP server
(`glb-server`), library API, and SvelteKit web UI.

## Structure

```text
packages/
  core/src/           Compression library (barrel: mod.ts)
    compress.ts       6-phase pipeline orchestrator (~600 lines)
    transforms.ts     Custom glTF-Transform transforms (~780 lines)
    constants.ts      Shared constants + error codes
    utils.ts          Utility functions
  cli/src/main.ts     CLI entry (bin: glb-compressor)
  server/src/         HTTP server + job queue + TLS (8 source files)
    main.ts           Server entrypoint + route handlers
    http.ts           Request parsing, CORS, error responses
    job-queue.ts      Serial compression queue with Worker dispatch
    job-types.ts      Domain types + factory
    job-protocol.ts   Worker message wire types
    worker-runtime.ts Worker message parser + specifier resolver
    worker.ts         Worker thread entry
    tls.ts            Auto-generated TLS certs
  shared-types/src/   Wire protocol types (SSE events)
  bun-polyfill/src/   Node.js polyfill plugin (build-time only)
src/index.ts          Meta-package barrel (re-exports @glb-compressor/core)
bin/                  npm bin shims (#!/usr/bin/env node wrappers)
build.ts              4-target build script
bench.ts              Compression benchmark runner (dev-only)
scripts/              Dev utilities (e.g. social preview generator)
compressor-frontend/  SvelteKit 2 + Svelte 5 + Tailwind v4 web UI
shitty-frontend/      React 19 prototype (throwaway)
skills/               Agent skill documentation (read-only)
```

## Where to look

| Task                   | Location                                     |
| ---------------------- | -------------------------------------------- |
| Add/change compression | `packages/core/src/compress.ts`              |
| Add glTF transform     | `packages/core/src/transforms.ts`            |
| Change presets         | `packages/core/src/compress.ts` -> `PRESETS` |
| Add CLI flag           | `packages/cli/src/main.ts`                   |
| Add server endpoint    | `packages/server/src/main.ts`                |
| Add/change job queue   | `packages/server/src/job-queue.ts`           |
| Fix request parsing    | `packages/server/src/http.ts`                |
| Fix Node.js compat     | `packages/bun-polyfill/src/polyfills.ts`     |
| Change build targets   | `build.ts`                                   |
| Public API surface     | `packages/core/src/mod.ts` (barrel)          |
| Wire protocol types    | `packages/shared-types/src/index.ts`         |
| Frontend UI            | `compressor-frontend/src/`                   |

## Architecture

- **Bun workspace monorepo**: 5 packages under `packages/`, 2 frontend
  workspaces. All `@glb-compressor/*` packages use `workspace:*` deps.
- **Dual-runtime**: written against Bun APIs, compiled to Node.js via polyfill
  layer. `package.json` exports use conditional `"bun"` vs `"node"` fields.
- **Skinned-model-aware**: pipeline detects skinned meshes and skips transforms
  that break skeleton hierarchies (flatten, join, weld, mergeByDistance,
  reorder, quantize).
- **gltfpack-first**: prefers external `gltfpack` binary; falls back to meshopt
  WASM if unavailable.
- **WASM pre-warm**: Draco + Meshopt WASM initialized eagerly at module load.
  Importing `@glb-compressor/core` triggers WASM loading as a side effect.
- **Dependency graph**: `core` is the root -- `cli` and `server` depend on it.
  `shared-types` is a leaf. `bun-polyfill` is build-time only (`private: true`).

## Workspace packages

| Package                        | Entry           | Role                    | Deps                                              |
| ------------------------------ | --------------- | ----------------------- | ------------------------------------------------- |
| `@glb-compressor/core`         | `src/mod.ts`    | Compression library     | gltf-transform, sharp, draco3dgltf, meshoptimizer |
| `@glb-compressor/cli`          | `src/main.ts`   | CLI binary              | core                                              |
| `@glb-compressor/server`       | `src/main.ts`   | HTTP server             | core, shared-types, @peculiar/x509                |
| `@glb-compressor/shared-types` | `src/index.ts`  | Wire protocol types     | (none)                                            |
| `@glb-compressor/bun-polyfill` | `src/plugin.ts` | Node.js build polyfills | (none, private)                                   |

## Conventions

- **Bun-first** -- always prefer Bun APIs over Node.js equivalents.
- **Tabs**, single quotes, 120-char line width (TS/JS).
- **Strict TypeScript** -- `strict: true`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax` (use `import type` for type-only imports).
- **Biome** for linting (formatter disabled), **dprint** for formatting
  (`bun run fmt`). Prettier explicitly disabled.
- **Type checker**: `tsgo` (`bun run typecheck`), not `tsc`.
- Import organization automated by Biome except in barrel/entry files (`mod.ts`,
  `index.ts`, `main.ts`).
- Exact dependency versions (`bunfig.toml`: `install.exact = true`).
- Default branch: `master`.

## Anti-patterns

- Don't use npm/yarn/pnpm -- use `bun`.
- Don't use express -- use `Bun.serve()`.
- Don't use dotenv -- Bun auto-loads `.env`.
- Don't use `node:fs` readFile/writeFile -- use `Bun.file` / `Bun.write`.
- Don't use execa -- use `Bun.$`.
- No `any`, no `!` non-null assertions, no `as Type` casts.
- Don't flatten/join/weld/quantize skinned models.
- **Never modify `.github/workflows/`** -- CI/CD workflows are owner-managed.

## Commands

```sh
bun run dev         # Hot-reload server + frontend
bun run cli         # Run CLI from source
bun run check       # Biome lint + format check
bun run lint        # Biome lint only
bun run fmt         # dprint format
bun run typecheck   # tsgo type check
bun build.ts        # Multi-target build
bun bench.ts        # Run compression benchmarks
```

## Build targets

| Target       | Output               | Format       | Notes                    |
| ------------ | -------------------- | ------------ | ------------------------ |
| Node.js      | `dist/node/`         | ESM          | Polyfilled, not minified |
| Bun          | `dist/bun/`          | ESM          | Minified                 |
| Bun bytecode | `dist/bun-bytecode/` | CJS + `.jsc` | Minified, no sourcemaps  |
| Types        | `dist/types/`        | `.d.ts`      | Via tsgo                 |

Externals (never bundled): `sharp`, `draco3dgltf`, `meshoptimizer`.

`build.ts` contains a `workspaceResolverPlugin()` that redirects
`@glb-compressor/*` imports to source `.ts` files at build time because the
`"node"` export condition points to `dist/` which doesn't exist during build.
The bun-polyfill plugin also resolves the `pkg` alias to root `package.json`.

## Conditional exports (dual-runtime)

Root `package.json` maps each subpath to the appropriate build:

- Library (`.`): Bun ESM, Node ESM
- Server (`./server`): Bun **bytecode**, Node ESM
- CLI (`./cli`): Bun **bytecode**, Node ESM

Bin stubs in `bin/` use `#!/usr/bin/env node` for npm global installs.

## CI/CD

| Workflow      | Trigger                            | Purpose                                        |
| ------------- | ---------------------------------- | ---------------------------------------------- |
| `autofix.yml` | push(`master`), PRs, workflow_call | Biome lint-fix + dprint format, auto-committed |
| `publish.yml` | release, workflow_dispatch         | Build + `npm publish --provenance`             |
| `pages.yml`   | push(`master`), workflow_dispatch  | Build + deploy SvelteKit frontend to GH Pages  |
| `claude.yml`  | mentions, PR/issue events, manual  | AI-assisted code review and PR work            |

## Skills

Agent skills in `skills/` following the [Agent Skills](https://agentskills.io/)
format. Read-only documentation -- no scripts, no build step.

| Skill                    | Purpose                               | References                |
| ------------------------ | ------------------------------------- | ------------------------- |
| `glb-compressor-cli`     | CLI usage, flags, presets, examples   | --                        |
| `glb-compressor-library` | Programmatic API, types, pipeline     | `api.md`, `transforms.md` |
| `glb-compressor-server`  | HTTP endpoints, SSE streaming, errors | --                        |

### When to update skills

- **Add/change CLI flag** -> update `glb-compressor-cli/SKILL.md`
- **Add/change API export** -> update `glb-compressor-library/SKILL.md` +
  `references/api.md`
- **Add/change transform** -> update `references/transforms.md` (safety matrix)
- **Add/change endpoint** -> update `glb-compressor-server/SKILL.md`
- **Add/change preset** -> update all three skills (CLI, library, server)
- **Add/change constant** -> update `references/api.md`

## Notes

- `packages/server/src/main.ts` guards startup with `import.meta.main` -- safe
  to import as library.
- No tests exist in core packages yet. Intended framework: `bun:test`. Server
  has one integration test (`test/jobs-queue.test.ts`).
- `models/` dir (gitignored) contains `.glb` fixtures for benchmarking.
- `prepublishOnly` uses Prettier for README only (dprint's markdown plugin
  differs).
