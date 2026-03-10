# Stage 1: Build gltfpack with BasisU support
FROM debian:bookworm-slim AS gltfpack-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
	build-essential \
	cmake \
	git \
	ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Clone pinned revisions for reproducible builds.
RUN git clone --depth 1 --branch v0.22 https://github.com/zeux/meshoptimizer.git /meshoptimizer && \
	git clone --depth 1 --branch v2_0_2 https://github.com/BinomialLLC/basis_universal.git /basis_universal

WORKDIR /meshoptimizer

# Build gltfpack with BasisU support for texture compression (-tc flag)
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release \
	-DMESHOPT_BUILD_GLTFPACK=ON \
	-DMESHOPT_GLTFPACK_BASISU_PATH=/basis_universal \
	&& cmake --build build --config Release --target gltfpack -j$(nproc) \
	&& cp build/gltfpack /usr/local/bin/gltfpack \
	&& chmod +x /usr/local/bin/gltfpack \
	&& gltfpack -v

# Stage 2: Build monorepo artifacts
FROM oven/bun:1-debian AS builder

WORKDIR /app

COPY package.json bun.lock* bunfig.toml build.ts tsconfig*.json ./
COPY bin ./bin
COPY src ./src
COPY packages ./packages

RUN bun install --frozen-lockfile
RUN bun build.ts

# Keep runtime image smaller: prune to production dependencies only.
RUN bun install --frozen-lockfile --production

# Stage 3: Runtime image
FROM oven/bun:1-debian

RUN groupadd --gid 1001 appuser && \
	useradd --uid 1001 --gid 1001 --no-create-home --shell /bin/false appuser

WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=gltfpack-builder /usr/local/bin/gltfpack /usr/local/bin/gltfpack

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD bun -e "fetch('http://localhost:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER appuser

CMD ["bun", "run", "./dist/bun-bytecode/server/src/main.cjs"]
