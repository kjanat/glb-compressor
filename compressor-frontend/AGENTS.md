# compressor-frontend/

SvelteKit 2 + Svelte 5 + Tailwind CSS v4 web UI for the glb-compressor server.
Single-page app deployed to GitHub Pages via `adapter-static`.

## Stack

- **Svelte 5** (runes: `$props`, `$state`, `$derived`, `$effect`, `$bindable`,
  `{@render}`)
- **SvelteKit 2** with `adapter-static` (output to `../dist/frontend`,
  `prerender: true`, `ssr: false`)
- **Tailwind CSS v4** (`@import "tailwindcss"`, `@plugin` syntax, NOT v3
  `@tailwind`/`@config`)
- **Vite 7** (build + dev server)
- **Vitest 4** with Playwright browser testing for component specs

## Tooling (differs from root)

| Aspect       | Root project | This workspace                   |
| ------------ | ------------ | -------------------------------- |
| Linter       | Biome        | ESLint 9 + eslint-plugin-svelte  |
| Formatter    | dprint       | None configured                  |
| Type checker | tsgo         | svelte-check (wraps tsc)         |
| Tests        | bun:test     | Vitest (browser + node projects) |
| Build        | Custom Bun   | Vite                             |

## Commands

```sh
bun run dev         # Vite dev server
bun run build       # Vite production build
bun run bd          # Build via Bun runtime (faster)
bun run preview     # Build + preview
bun run check       # svelte-kit sync + svelte-check
bun run lint        # ESLint
bun run test        # vitest run (single)
bun run test:unit   # vitest (watch)
```

## Structure

```text
src/
  app.html            SvelteKit shell
  app.d.ts            Global type augmentation
  demo.spec.ts        Node test project smoke test
  lib/
    index.ts           $lib barrel (empty placeholder -- unused)
    compression-session.svelte.ts  Reactive compression state manager (~770 lines)
    sse.ts             SSE client (DEAD CODE -- unused since queue migration)
    types.ts           Frontend types + PRESETS constant
    utils.ts           UI utilities (formatBytes, download helpers)
    assets/
      favicon.svg      Custom GLB-themed favicon
    components/
      Dropzone.svelte       File upload drag-and-drop + click-to-browse
      FileList.svelte       File queue with status/size/download/remove
      Header.svelte         Branding + live server status dot
      LogConsole.svelte     Scrollable log output, auto-scroll on new entries
      PresetPicker.svelte   4-column grid preset selector ($bindable)
      SetupAccordion.svelte Container: SetupServerUrl + SetupGuide
      SetupCommand.svelte   Copyable CLI command block
      SetupGuide.svelte     Expandable setup instructions
      SetupServerUrl.svelte Editable server URL with local edit shadow state
  routes/
    +layout.svelte     Root layout (Svelte 5 $props())
    +layout.ts         prerender + ssr config
    +page.svelte       Main page (entire app)
    page.svelte.spec.ts Browser test for +page
    layout.css         Tailwind v4 entry + design tokens + dark theme only
static/
  robots.txt          Static robots policy
```

## Architecture

### State management

`createCompressionSession()` returns a reactive `CompressionSession` object
using closure-based `$state()`. Not a class, not a Svelte store. The page
component calls it once and destructures `session.state` for reactive reads.
Mutations happen through returned methods that mutate `state.*` in-place,
relying on Svelte 5's deep proxy tracking.

### Communication protocol

Uses **queue-based REST polling** (NOT SSE):

1. `POST /jobs?preset=X` -> 202 with `statusUrl` + `resultUrl`
2. Poll `GET {statusUrl}` every 500ms until `done` or `error`
3. `GET {resultUrl}` -> binary blob download

### glTF resource resolution

For `.gltf` files: parses JSON, extracts `buffers[*].uri` + `images[*].uri`,
resolves against a `resourcePool` (SvelteMap) of non-model files. Multi-strategy
URI matching: raw, normalized, decoded, basename.

### Data flow (`+page.svelte`)

```text
createCompressionSession() -> session
  +--> Header (serverOnline)
  +--> SetupAccordion (serverUrl, serverOnline, onurlchange)
  +--> Dropzone (onfiles -> session.addFiles)
  +--> FileList (files, onremove, onclear, ondownload)
  +--> PresetPicker (bind:selected -> state.selectedPreset)
  +--> compress button (onclick -> session.compressAll)
  +--> LogConsole (bind:open -> state.logOpen, logs)
```

## Complexity hotspots

- `compression-session.svelte.ts` (~770 lines) -- largest file; hand-rolled
  JSON parsers for all server responses (no `as`/`any`); `pollJob()` is an
  infinite `for(;;)` loop with no timeout/max-retry guard; `compressAll()` fires
  `Promise.all` with no concurrency limit; `resourcePool` SvelteMap grows
  monotonically (never cleared)
- `parseQueueJobSnapshot()` (~80 lines) -- deepest nesting for manual runtime
  type validation
- `clearFiles()` preserves active jobs (not a true "clear all" despite UI label)

## Dead code

- `lib/sse.ts` -- SSE client module, not imported anywhere since migration to
  queue-based polling
- `lib/types.ts` `StreamCompressResult` type -- `payloadType: 'base64'` branch
  never constructed
- `lib/utils.ts` `downloadBase64()` -- unreachable (only called for
  StreamCompressResult)
- `lib/index.ts` -- empty `$lib` barrel placeholder
- Several `SvelteMap`/`SvelteSet` usages in non-reactive contexts where plain
  `Map`/`Set` would suffice

## Test conventions

- Specs co-located with source files
- Component tests: `*.svelte.spec.ts` (browser/Playwright project)
- Other tests: `*.spec.ts` (node project)
- `requireAssertions: true` -- every test must assert something
- Test filenames drop the `+` prefix (`page.svelte.spec.ts`, not
  `+page.svelte.spec.ts`)

## Anti-patterns (this workspace)

- Don't use Svelte 4 patterns: no `export let`, no `$$props`, no `on:event`
  directive -- use Svelte 5 runes only.
- Don't use Tailwind v3 syntax: no `@tailwind base`, no `@config` -- use v4
  `@import "tailwindcss"`.
- Same type safety rules as root: no `any`, no `!`, no `as Type`.
