# @glb-compressor/shared-types

Shared wire protocol types for server/frontend boundaries.

## Files

```text
src/
  index.ts   SSE event payload interfaces + event map
```

## Exported contracts

- `CompressionLogEvent` (`message`)
- `CompressionErrorEvent` (`message?`, `requestId?`, `code?`)
- `CompressionResultEvent` (`requestId`, `filename`, `data`, `originalSize`,
  `compressedSize`, `ratio`, `method`)
- `CompressionStreamEventMap` (`log|error|result` -> payload type)

## Consumers

- Producer: `packages/server/src/main.ts` (`handleCompressStream`)
- Consumer: `compressor-frontend/src/lib/sse.ts` (currently dead code --
  frontend switched to queue-based polling)

## Anti-patterns

- Don't add runtime code; package should stay type-only.
- Don't break event field names/types without coordinated server + frontend
  updates.
