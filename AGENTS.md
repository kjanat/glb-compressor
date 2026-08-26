# glb-compressor

Multi-phase GLB/glTF 3D model compression toolkit. Node.js monorepo with a tsdown build. CLI (`glb-compressor`), HTTP
server (`glb-server`), library API, and SvelteKit web UI.

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
src/index.ts          Meta-package barrel (re-exports @glb-compressor/core)
bin/                  npm bin shims (#!/usr/bin/env node wrappers)
build.ts              Node.js build orchestrator
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
| Fix Node.js compat     | Runtime package using the affected API       |
| Change build targets   | `build.ts`                                   |
| Public API surface     | `packages/core/src/mod.ts` (barrel)          |
| Wire protocol types    | `packages/shared-types/src/index.ts`         |
| Frontend UI            | `compressor-frontend/src/`                   |

## Architecture

- **Workspace monorepo**: 4 packages under `packages/`, 2 frontend workspaces. All `@glb-compressor/*` packages use
  `workspace:*` deps.
- **Node.js runtime**: runtime code uses `node:` APIs and Web Platform APIs. Production exports point to Node bundles;
  the `development` condition points to TypeScript source.
- **Skinned-model-aware**: pipeline detects skinned meshes and skips transforms that break skeleton hierarchies
  (flatten, join, weld, mergeByDistance, reorder, quantize).
- **gltfpack-first**: prefers external `gltfpack` binary; falls back to meshopt WASM if unavailable.
- **WASM pre-warm**: Draco + Meshopt WASM initialized eagerly at module load. Importing `@glb-compressor/core` triggers
  WASM loading as a side effect.
- **Dependency graph**: `core` is the root -- `cli` and `server` depend on it. `shared-types` is a leaf.

## Workspace packages

| Package                        | Entry          | Role                | Deps                                              |
| ------------------------------ | -------------- | ------------------- | ------------------------------------------------- |
| `@glb-compressor/core`         | `src/mod.ts`   | Compression library | gltf-transform, sharp, draco3dgltf, meshoptimizer |
| `@glb-compressor/cli`          | `src/main.ts`  | CLI binary          | core                                              |
| `@glb-compressor/server`       | `src/main.ts`  | HTTP server         | core, shared-types, @peculiar/x509                |
| `@glb-compressor/shared-types` | `src/index.ts` | Wire protocol types | (none)                                            |

## Conventions

- **Node.js-first** -- use `node:` standard-library APIs for filesystem, subprocess, HTTP, TLS, and workers.
- **Tabs**, single quotes, 120-char line width (TS/JS).
- **Strict TypeScript** -- `strict: true`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (use `import type` for
  type-only imports).
- **Biome** for linting (formatter disabled), **dprint** for formatting (`npm run fmt`). Prettier explicitly disabled.
- **Type checker**: TypeScript (`npm run typecheck`).
- Import organization automated by Biome except in barrel/entry files (`mod.ts`, `index.ts`, `main.ts`).
- Exact dependency versions (`bunfig.toml`: `install.exact = true`).
- Default branch: `master`.

## Anti-patterns

- Don't use express -- use the native `node:http` / `node:https` server.
- Don't use dotenv -- configuration is read from `process.env`.
- Don't introduce Bun-native globals or `bun:` imports into runtime code.
- No `any`, no `!` non-null assertions, no `as Type` casts.
- Don't flatten/join/weld/quantize skinned models.
- **Never modify `.github/workflows/`** -- CI/CD workflows are owner-managed.

## Commands

```sh
npm run dev         # Hot-reload server + frontend
npm run cli         # Run CLI from source
npm run test        # Vitest test suite
npm run check       # Biome lint + format check
npm run fmt         # dprint format
npm run typecheck   # TypeScript type check
npm run build       # Node.js bundles + declarations
npm run bench       # Run compression benchmarks
```

## Build targets

| Target  | Output        | Format  | Notes                       |
| ------- | ------------- | ------- | --------------------------- |
| Node.js | `dist/node/`  | ESM     | Library, server, and worker |
| CLI     | `dist/cli/`   | ESM     | Standalone Node.js CLI      |
| Types   | `dist/types/` | `.d.ts` | TypeScript declarations     |

Externals (never bundled): `sharp`, `draco3dgltf`, `meshoptimizer`.

`tsdown.config.ts` aliases workspace imports to source entry points at build time because production exports point to
`dist/`, which does not exist yet.

## Conditional exports

Root `package.json` maps library, server, and CLI subpaths to Node.js bundles. The `development` condition maps those
imports to TypeScript source.

Bin stubs in `bin/` use `#!/usr/bin/env node` for npm global installs.

## CI/CD

| Workflow      | Trigger                            | Purpose                                        |
| ------------- | ---------------------------------- | ---------------------------------------------- |
| `autofix.yml` | push(`master`), PRs, workflow_call | Biome lint-fix + dprint format, auto-committed |
| `publish.yml` | release, workflow_dispatch         | Build + `npm publish --provenance`             |
| `pages.yml`   | push(`master`), workflow_dispatch  | Build + deploy SvelteKit frontend to GH Pages  |
| `claude.yml`  | mentions, PR/issue events, manual  | AI-assisted code review and PR work            |

## Skills

Agent skills in `skills/` following the [Agent Skills](https://agentskills.io/) format. Read-only documentation -- no
scripts, no build step.

| Skill                    | Purpose                               | References                |
| ------------------------ | ------------------------------------- | ------------------------- |
| `glb-compressor-cli`     | CLI usage, flags, presets, examples   | --                        |
| `glb-compressor-library` | Programmatic API, types, pipeline     | `api.md`, `transforms.md` |
| `glb-compressor-server`  | HTTP endpoints, SSE streaming, errors | --                        |

### When to update skills

- **Add/change CLI flag** -> update `glb-compressor-cli/SKILL.md`
- **Add/change API export** -> update `glb-compressor-library/SKILL.md` + `references/api.md`
- **Add/change transform** -> update `references/transforms.md` (safety matrix)
- **Add/change endpoint** -> update `glb-compressor-server/SKILL.md`
- **Add/change preset** -> update all three skills (CLI, library, server)
- **Add/change constant** -> update `references/api.md`

## Notes

- `packages/server/src/main.ts` uses a Node.js entry-path guard -- safe to import as a library.
- Root and server tests use Vitest. Server integration coverage lives in `packages/server/test/jobs-queue.test.ts`.
- `models/` dir (gitignored) contains `.glb` fixtures for benchmarking.
- `prepublishOnly` uses Prettier for README only (dprint's markdown plugin differs).
