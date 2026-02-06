# Stage 1: Build gltfpack with BasisU support
FROM debian:bookworm-slim AS gltfpack-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Clone meshoptimizer and basis_universal at pinned versions
RUN git clone --depth 1 https://github.com/zeux/meshoptimizer.git /meshoptimizer && \
    git clone --depth 1 --branch v2_0_2 https://github.com/BinomialLLC/basis_universal.git /basis_universal

WORKDIR /meshoptimizer

# Build with BasisU support for texture compression (-tc flag)
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release \
    -DMESHOPT_BUILD_GLTFPACK=ON \
    -DMESHOPT_GLTFPACK_BASISU_PATH=/basis_universal \
    && cmake --build build --config Release --target gltfpack -j$(nproc) \
    && cp build/gltfpack /usr/local/bin/gltfpack \
    && chmod +x /usr/local/bin/gltfpack \
    && gltfpack -v

# Stage 2: Bundle with bytecode (not standalone)
FROM oven/bun:1-debian AS builder

WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source (lib + server + cli)
COPY lib/ ./lib/
COPY server/ ./server/
COPY cli/ ./cli/

# Bundle with bytecode compilation (creates .js + .jsc files)
# --bytecode: pre-compile JS to bytecode for faster startup
# --minify: reduce code size
# --external: keep native/WASM modules external
RUN bun build ./server/main.ts \
    --outdir=./dist \
    --target=bun \
    --bytecode \
    --minify \
    --external sharp \
    --external draco3dgltf

# Stage 3: Final minimal image
FROM oven/bun:1-debian

# Create non-root user
RUN groupadd --gid 1001 appuser && \
    useradd --uid 1001 --gid 1001 --no-create-home --shell /bin/false appuser

# Copy gltfpack binary
COPY --from=gltfpack-builder /usr/local/bin/gltfpack /usr/local/bin/gltfpack

WORKDIR /app

# Copy bundled server with bytecode
COPY --from=builder /app/dist ./dist

# Copy external modules with native/WASM dependencies
COPY --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/node_modules/@img/sharp-linux-x64 ./node_modules/@img/sharp-linux-x64
COPY --from=builder /app/node_modules/@img/sharp-libvips-linux-x64 ./node_modules/@img/sharp-libvips-linux-x64
COPY --from=builder /app/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=builder /app/node_modules/semver ./node_modules/semver
COPY --from=builder /app/node_modules/@img/colour ./node_modules/@img/colour
# Draco WASM files
COPY --from=builder /app/node_modules/draco3dgltf ./node_modules/draco3dgltf

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://localhost:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER appuser

CMD ["bun", "run", "./dist/index.js"]
