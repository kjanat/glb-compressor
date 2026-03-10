# @glb-compressor/bun-polyfill

Node.js compatibility layer. Build-time only (`private: true`) — never imported
at runtime. Used exclusively by `build.ts` for the Node.js target.

## Files

### plugin.ts (Bun bundler plugin)

Three hooks applied only to the Node.js ESM build target:

1. **onResolve** — redirects `import from 'bun'` to `polyfills.ts`
2. **onLoad** — injects `import { Bun } from "bun"` when files use `Bun.*`
   globals; replaces `import.meta.main` with Node-compatible check
3. **onResolve** — resolves `pkg` tsconfig alias to `package.json`

### polyfills.ts (~360 lines, highest-risk maintenance surface)

Reimplements Bun APIs using Node.js stdlib:

| Polyfill      | Node equivalent                        | Notes                               |
| ------------- | -------------------------------------- | ----------------------------------- |
| `Bun.file()`  | `fs/promises` readFile                 | Returns `BunFile` interface         |
| `Bun.write()` | `writeFile` with auto `mkdir -p`       |                                     |
| `Bun.spawn()` | `child_process.spawn`                  | Web ReadableStream stderr, no stdin |
| `Bun.serve()` | `http.createServer` (~100 lines)       | Route-based API bridge              |
| `Bun.which()` | PATH-based binary lookup               | Cross-platform                      |
| `Glob` class  | `readdir({ recursive: true })` + regex | ReDoS-protected (1024 char limit)   |
| `$` tag       | `child_process.execFile`               | Template literal shell commands     |

## Complexity hotspots

- `serve()` is ~100 lines bridging Bun's route-based API to Node's req/res.
  Must handle URL construction, header conversion, body streaming, three-way
  route matching, and Web Response -> Node ServerResponse with backpressure.
- `Glob.scan()` has two code paths: globstar vs simple patterns. Handles
  Node 18 vs 20 `readdir` API differences (`entry.parentPath` vs `entry.path`).
- `file().arrayBuffer()` uses `buf.buffer.slice(buf.byteOffset, ...)` because
  Node's Buffer can share the underlying ArrayBuffer with other views.

## Anti-patterns (this package)

- Don't import from `core/`, `cli/`, or `server/` — build infra is
  self-contained.
- Don't use polyfills at runtime — they exist only for the Node.js build target.
- `as Type` casts exist here for Node->Web API bridging — tolerated
  but minimize additions.
- Don't add Bun API polyfills without verifying both Node 18 and 20 compat.
