# @glb-compressor/server

HTTP API package exposing GLB compression over `Bun.serve()`.

## Files

```text
src/
  main.ts   Server entrypoint + route handlers + request parsing
```

## Endpoints

- `GET /healthz` → `ok`
- `POST /compress` → binary GLB response
- `POST /compress-stream` → SSE (`log`, `result`, `error` events)
- `OPTIONS` on POST routes → CORS preflight

## Request handling

- `parseCompressRequest()` supports multipart + raw body (raw disabled for
  stream endpoint)
- Validates size against `MAX_FILE_SIZE`
- Validates GLB magic via `validateGlbMagic()`
- Resolves options from query params + form fields (`preset`, `simplify`)
- Sanitizes filename before response headers/events

## Runtime

- `startServer()` exported for library import (`bin/glb-server.js`)
- Direct execution guarded by `if (import.meta.main)`
- CORS headers are centralized in `CORS_HEADERS`

## Anti-patterns

- Don't bypass `jsonError()`; keep structured `code/message/requestId` shape.
- Don't change SSE event payloads without updating `@glb-compressor/shared-types`.
- Don't import from CLI; server depends on core + shared-types only.
