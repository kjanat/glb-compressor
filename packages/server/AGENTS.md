# @glb-compressor/server

HTTP API package exposing GLB compression over `Bun.serve()`. Supports
synchronous, SSE streaming, and async job queue modalities.

## Files

```text
src/
  main.ts             Server entrypoint, route handlers, Bun.serve() config
  http.ts             CORS headers, request parsing, error response factory
  job-types.ts        Domain types (JobRecord, JobSnapshot, JobEvent, etc.) + factory
  job-protocol.ts     Worker<->main thread message protocol types
  job-queue.ts        CompressionJobQueue class (serial queue, Worker dispatch, pub/sub)
  worker-runtime.ts   Worker message parser + specifier resolver (main-thread side)
  worker.ts           Worker thread entry (runs compress pipeline in dedicated thread)
  tls.ts              TLS cert resolution (custom, cached self-signed, or auto-generated)

test/
  jobs-queue.test.ts  Integration test for /jobs API (bun:test, real server)
  fixtures/           valid-minimal.gltf, invalid.gltf, invalid.glb
```

## Internal dependency graph

```text
job-types.ts         <- leaf, pure types + factory
job-protocol.ts      <- leaf, pure types
worker-runtime.ts    <- job-protocol
worker.ts            <- job-protocol + @glb-compressor/core (separate thread)
http.ts              <- @glb-compressor/core only
tls.ts               <- @peculiar/x509 + node:fs/promises only
job-queue.ts         <- job-types, job-protocol, worker-runtime, core
main.ts              <- job-queue, http, tls, core, shared-types
```

## Endpoints

| Method  | Path               | Handler                | Response                                            |
| ------- | ------------------ | ---------------------- | --------------------------------------------------- |
| GET     | `/healthz`         | static                 | `"ok"`                                              |
| POST    | `/compress`        | `handleCompress`       | Binary GLB (synchronous, awaits completion)         |
| POST    | `/compress-stream` | `handleCompressStream` | SSE stream (`log`, `result`, `error` events)        |
| POST    | `/jobs`            | `handleCreateJob`      | 202 JSON with `requestId`, `statusUrl`, `resultUrl` |
| GET     | `/jobs/:id`        | `handleGetJobStatus`   | Job snapshot JSON                                   |
| GET     | `/jobs/:id/result` | `handleGetJobResult`   | Binary GLB or error                                 |
| OPTIONS | POST/job routes    | `handleOptions`        | 204 CORS preflight                                  |

All three POST endpoints share `parseCompressRequest()` -> `jobQueue.submit()`.
They differ in delivery: `/compress` awaits completion, `/compress-stream`
subscribes via pub/sub for SSE, `/jobs` returns 202 immediately for polling.

### Routing architecture

Static routes (`/healthz`, `/compress`, `/compress-stream`) use Bun's `routes`
object. Dynamic routes (`/jobs/:id`, `/jobs/:id/result`) use the `fetch`
fallback with manual `parseJobRoute()` parsing -- Bun's `routes` doesn't support
path params.

## Job queue architecture

- **Serial execution**: one job at a time, FIFO pending queue
- **Worker-first**: compression runs in a `Worker` thread by default; falls back
  to main-thread `runInline()` when Workers unavailable (Node.js runtime)
- **Worker crash recovery**: error event -> fail active job -> recreate Worker
- **Pub/sub with replay**: `subscribe()` replays existing logs to late-joining
  SSE clients before registering for live events
- **Auto-pruning**: finished jobs pruned after `JOB_RETENTION_MS` (10 min),
  triggered lazily on `submit()`, `getSnapshot()`, `getResult()`
- **Log capping**: `MAX_LOG_ENTRIES = 200`; oldest shifted off

## TLS

Server generates and caches self-signed TLS certs by default:

1. `NO_TLS=true` env -> plain HTTP
2. `TLS_CERT` + `TLS_KEY` env -> custom cert/key file paths
3. Cached at `~/.glb-compressor/tls/*.pem` -> reuse if present
4. Auto-generate EC P-256 cert (SAN: localhost, 127.0.0.1, ::1, 365-day)

Uses `node:fs/promises` for `mkdir` + `Bun.file`/`Bun.write` for I/O (mixed
because `Bun.write` doesn't create parent dirs).

## Complexity hotspots

- `parseCompressRequest()` (http.ts) -- handles multipart + raw body, `.gltf`
  resource bundle detection, cumulative size check
- `isObjectRecord` defined 3 times (job-queue, worker-runtime, worker) -- worker
  can't share code (separate thread), but job-queue and worker-runtime could
- Filename transform (`-compressed.glb` suffix) duplicated in job-queue.ts and
  worker.ts -- must stay in sync
- `resolveWorkerSpecifier()` inspects file extension heuristic to pick worker
  entry -- breaks silently on naming convention changes
- `createJobRecord()` deferred promise with noop `.catch()` -- removing this
  crashes the process on polling-only error jobs
- SSE stream has no heartbeat/keepalive; long compressions may trigger proxy
  idle timeouts

## Anti-patterns

- Don't bypass `jsonError()`; keep structured `code/message/requestId` shape.
- Don't change SSE event payloads without updating
  `@glb-compressor/shared-types`.
- Don't import from CLI; server depends on core + shared-types only.
- Don't change Worker message protocol types without updating BOTH
  `parseWorkerResponse()` (main-thread) and `parseWorkerRequest()` (worker) --
  each side validates independently.
