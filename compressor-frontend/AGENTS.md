# compressor-frontend/

SvelteKit 2 + Svelte 5 + Tailwind CSS v4 web UI for the glb-compressor server.
Workspace member of the root monorepo.

## Stack

- **Svelte 5** (runes: `$props`, `$state`, `$derived`, `{@render}`)
- **SvelteKit 2** with `adapter-static` (output to `../dist/frontend`)
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
  lib/
    index.ts           $lib barrel (empty placeholder)
    compression-session.svelte.ts  Reactive compression state manager
    sse.ts             SSE client for /compress-stream endpoint
    types.ts           Frontend-specific types
    utils.ts           UI utility functions
    assets/
      favicon.svg      Custom GLB-themed favicon
    components/
      Dropzone.svelte       File upload drop zone
      FileList.svelte       Uploaded file list display
      Header.svelte         App header/branding
      LogConsole.svelte     Compression log output
      PresetPicker.svelte   Compression preset selector
      SetupAccordion.svelte Setup instructions accordion
      SetupCommand.svelte   CLI command display
      SetupGuide.svelte     Getting started guide
      SetupServerUrl.svelte Server URL configuration
  routes/
    +layout.svelte     Root layout (Svelte 5 $props())
    +layout.ts         Layout load function
    +page.svelte       Main page
    layout.css         Tailwind v4 entry + plugins
```

## Test conventions

- Specs co-located with source files
- Component tests: `*.svelte.spec.ts` (browser/Playwright project)
- Other tests: `*.spec.ts` (node project)
- `requireAssertions: true` — every test must assert something
- Test filenames drop the `+` prefix (`page.svelte.spec.ts`, not
  `+page.svelte.spec.ts`)

## Integration

Calls glb-compressor server at `/compress` (binary response) and
`/compress-stream` (SSE progress). Wire types from
`@glb-compressor/shared-types`. See `skills/glb-compressor-server/SKILL.md`
for endpoint docs.

## Anti-patterns (this workspace)

- Don't use Svelte 4 patterns: no `export let`, no `$$props`, no `on:event`
  directive — use Svelte 5 runes only.
- Don't use Tailwind v3 syntax: no `@tailwind base`, no `@config` — use v4
  `@import "tailwindcss"`.
- Same type safety rules as root: no `any`, no `!`, no `as Type`.
