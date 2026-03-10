# @glb-compressor/cli

CLI package wrapping `@glb-compressor/core` compression for local files.
Published bin name is `glb-compressor` (root wrapper); help text still prints
`glb-compress`.

## Files

```text
src/
  main.ts   CLI entrypoint (arg parsing, glob expansion, per-file compression)
```

## Key flow (`src/main.ts`)

- Parse args with `node:util parseArgs`
- Validate `--preset` against `PRESETS`
- Parse `--simplify` via `parseSimplifyRatio`
- Expand globs via `new Glob(pattern).scan()`
- Pre-warm core with `init()`
- Compress files sequentially with `compressFile()`
- Exit `0` on full success, `1` if any file fails

## Flags

- `-o, --output` output dir
- `-p, --preset` preset (`default|balanced|aggressive|max`)
- `-s, --simplify` ratio `(0,1)`
- `-q, --quiet` suppress progress
- `-f, --force` overwrite output
- `-h, --help`, `-v, --version`

## Anti-patterns

- Don't bypass `validateGlbMagic()` for input validation.
- Don't parallelize blindly; current sequential flow keeps output readable and
  avoids contention with heavy compression subprocesses.
- Don't import from `server/`; CLI depends only on core.
