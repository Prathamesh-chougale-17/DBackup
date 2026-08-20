# SqlPackage, for the Azure SQL Database adapter.
#
# Built in its own stage so the .NET SDK never reaches the runtime image. The tool
# is published as portable IL under tools/<tfm>/any, so this produces the correct
# architecture automatically: buildx runs this stage once per target platform.
# Verified on linux/arm64 as well as linux/amd64 - Microsoft's standalone zip is
# x64-only, which is why the dotnet tool is used instead of the download.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS sqlpackage-build
RUN dotnet tool install --tool-path /tmp/sqlpkg microsoft.sqlpackage && \
    PAYLOAD="$(find /tmp/sqlpkg/.store -type d -path '*/tools/net10.0/any' | head -1)" && \
    test -n "$PAYLOAD" && \
    mkdir -p /opt/sqlpackage && \
    cp -a "$PAYLOAD"/. /opt/sqlpackage/

# Base Image: Node.js 24 on Debian Slim (bookworm)
FROM node:24-slim AS base

# Install system tools for database backups
# mariadb-client (Debian 12)       -> mysql, mysqldump, mariadb, mariadb-dump (libmariadb3 3.3.x supports caching_sha2_password)
# postgresql-client-18 (PGDG)      -> pg_dump, pg_restore, psql (backward compatible with PG 12-18)
# mongodb-database-tools (CDN)     -> mongodump, mongorestore (direct download - APT repo has no arm64 builds for Debian 12;
#                                    MongoDB only ships debian12 x86_64 packages; arm64 uses ubuntu2204 package)
# redis-tools                      -> redis-cli (for Redis backups)
# smbclient                        -> SMB/CIFS storage
# sqlite3                          -> SQLite backups
# gosu                             -> privilege dropping (replaces Alpine su-exec)

# Step 1: Install prerequisites for adding external APT repositories
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Step 2: Configure external APT repositories
RUN \
    # PGDG: PostgreSQL 18 client
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg && \
    echo "deb [signed-by=/etc/apt/trusted.gpg.d/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list

# Step 3: Install backup tools
# mariadb-client on Debian 12 ships with libmariadb3 3.3.x, which supports caching_sha2_password natively.
# It also provides mysql/mysqldump/mysqladmin as compatibility symlinks.
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    mariadb-client \
    postgresql-client-18 \
    redis-tools \
    smbclient \
    lz4 \
    zstd \
    rsync \
    sshpass \
    openssh-client \
    openssl \
    curl \
    zip \
    sqlite3 \
    gosu && \
    # Step 4: MongoDB database tools - direct CDN download for multi-arch support
    # MongoDB ships debian12 packages for x86_64 only; arm64 uses the ubuntu2204 build (compatible on Debian bookworm)
    case "${TARGETARCH:-amd64}" in \
        amd64) MONGO_DEB="mongodb-database-tools-debian12-x86_64-100.16.1.deb" ;; \
        arm64) MONGO_DEB="mongodb-database-tools-ubuntu2204-arm64-100.16.1.deb" ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}"; exit 1 ;; \
    esac && \
    curl -fsSL "https://fastdl.mongodb.org/tools/db/${MONGO_DEB}" -o /tmp/mongo-tools.deb && \
    apt-get install -y --no-install-recommends /tmp/mongo-tools.deb && \
    rm /tmp/mongo-tools.deb && \
    rm -rf /var/lib/apt/lists/*

# Step 5: Firebird 5.x client tools (gbak, isql) for the Firebird adapter.
# Debian 12's apt repos only carry a 3.0 client, not 5.x, and the 5.x gbak/isql
# can talk to 3.x/4.x servers over the wire protocol - so download the official
# Firebird release tarball and extract just the client binaries + shared library.
#
# Verified against the actual GitHub release assets (2026-07-04):
# - Release tag (v${FIREBIRD_RELEASE_TAG}) and asset filename version
#   (${FIREBIRD_ASSET_VERSION}) differ - assets embed a build number, e.g.
#   "Firebird-5.0.3.1683-0-linux-x64.tar.gz" for tag "v5.0.3". Bump both when
#   upgrading.
# - The top-level tarball only contains an install.sh + a nested
#   buildroot.tar.gz - the actual bin/lib payload lives at
#   buildroot.tar.gz:./opt/firebird/{bin,lib}, not at the tarball root.
# - gbak/isql depend on libtommath.so.1 and gbak also needs libz.so.1, neither
#   of which ship inside buildroot.tar.gz - installed via apt below.
#   libicuuc/libicui18n are dlopen'd at runtime for extended collations only
#   (soft dependency) - omitted here since backup/restore doesn't need them.
ARG FIREBIRD_RELEASE_TAG=5.0.3
ARG FIREBIRD_ASSET_VERSION=5.0.3.1683-0
RUN apt-get update && apt-get install -y --no-install-recommends \
    libtommath1 \
    zlib1g && \
    rm -rf /var/lib/apt/lists/* && \
    case "${TARGETARCH:-amd64}" in \
        amd64) FB_ARCH="x64" ;; \
        arm64) FB_ARCH="arm64" ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}"; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/FirebirdSQL/firebird/releases/download/v${FIREBIRD_RELEASE_TAG}/Firebird-${FIREBIRD_ASSET_VERSION}-linux-${FB_ARCH}.tar.gz" -o /tmp/firebird.tar.gz && \
    mkdir -p /tmp/firebird-extract && \
    tar -xzf /tmp/firebird.tar.gz -C /tmp/firebird-extract --strip-components=1 && \
    tar -xzf /tmp/firebird-extract/buildroot.tar.gz -C /tmp/firebird-extract && \
    mkdir -p /opt/firebird/bin /opt/firebird/lib && \
    cp /tmp/firebird-extract/opt/firebird/bin/gbak /opt/firebird/bin/ && \
    cp /tmp/firebird-extract/opt/firebird/bin/isql /opt/firebird/bin/ && \
    cp -a /tmp/firebird-extract/opt/firebird/lib/. /opt/firebird/lib/ && \
    cp /tmp/firebird-extract/opt/firebird/firebird.msg /opt/firebird/ && \
    ln -sf /opt/firebird/bin/gbak /usr/local/bin/gbak && \
    ln -sf /opt/firebird/bin/isql /usr/local/bin/isql && \
    echo "/opt/firebird/lib" > /etc/ld.so.conf.d/firebird.conf && \
    ldconfig && \
    rm -rf /tmp/firebird.tar.gz /tmp/firebird-extract

# Step 6: SqlPackage runtime, for the Azure SQL Database adapter.
#
# Only the .NET runtime, never the SDK - the tool itself came from the stage above.
# libicu is a hard dependency: without it .NET aborts at startup with a globalization
# error that says nothing about the missing package.
#
# The wrapper exists because the adapter resolves the binary with host.which("sqlpackage"),
# and the apphost shim from a --tool-path install is not on PATH here.
RUN apt-get update && apt-get install -y --no-install-recommends libicu72 && \
    rm -rf /var/lib/apt/lists/* && \
    curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh && \
    bash /tmp/dotnet-install.sh --channel 10.0 --runtime dotnet --install-dir /usr/share/dotnet --no-path && \
    rm /tmp/dotnet-install.sh

COPY --from=sqlpackage-build /opt/sqlpackage /opt/sqlpackage

RUN printf '#!/bin/sh\nexec /usr/share/dotnet/dotnet /opt/sqlpackage/sqlpackage.dll "$@"\n' > /usr/local/bin/sqlpackage && \
    chmod +x /usr/local/bin/sqlpackage && \
    sqlpackage /version

# Symlink PostgreSQL 18 binaries into PATH.
# On Debian with PGDG, pg binaries live under /usr/lib/postgresql/18/bin/
RUN ln -sf /usr/lib/postgresql/18/bin/pg_dump /usr/local/bin/pg_dump && \
    ln -sf /usr/lib/postgresql/18/bin/pg_restore /usr/local/bin/pg_restore && \
    ln -sf /usr/lib/postgresql/18/bin/psql /usr/local/bin/psql

# Validate pg_dump version resolves correctly (fail-fast on broken symlinks/packages)
RUN pg_dump --version | grep -q 'PostgreSQL) 18\.' || \
    (echo "ERROR: pg_dump version validation failed! Check PostgreSQL 18 client package." && exit 1)

# Keep pnpm and its cross-platform Corepack cache out of the runtime image.
FROM base AS target-build-base
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

# Install target-platform dependencies only for native runtime payloads.
FROM target-build-base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-${TARGETARCH},target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Install only the lock-resolved Prisma CLI and its runtime dependencies.
FROM deps AS prisma-cli
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN --mount=type=cache,id=pnpm-${TARGETARCH},target=/root/.local/share/pnpm/store \
    PRISMA_VERSION="$(node -p 'require("/app/node_modules/prisma/package.json").version')" && \
    pnpm add --global "prisma@${PRISMA_VERSION}" && \
    prisma --version

# Generate the target-platform Prisma client and Sharp native packages. The full
# dependency tree remains in this disposable stage and never reaches the image.
FROM deps AS target-native
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN pnpm prisma generate && \
    PRISMA_CLIENT="$(node -e 'const path = require("node:path"); process.stdout.write(path.resolve(path.dirname(require.resolve("@prisma/client/package.json")), "../../.prisma/client"))')" && \
    test -d "$PRISMA_CLIENT" && \
    mkdir -p /target-native && \
    cp -aL "$PRISMA_CLIENT" /target-native/prisma-client && \
    SHARP_ARCH="$(node -p 'process.arch')" && \
    copy_target_sharp_package() { \
      PACKAGE="$1"; \
      PACKAGE_METADATA="$2"; \
      SOURCE_PACKAGE="$(node -e 'const { createRequire } = require("node:module"); const sharpRequire = createRequire(require.resolve("sharp")); process.stdout.write(sharpRequire.resolve(process.argv[1]))' "$PACKAGE_METADATA")" || return 1; \
      test -s "$SOURCE_PACKAGE" || return 1; \
      DESTINATION="/target-native/node_modules/$PACKAGE"; \
      mkdir -p "$(dirname "$DESTINATION")" && \
      cp -aL "$(dirname "$SOURCE_PACKAGE")" "$DESTINATION"; \
    }; \
    copy_target_sharp_package "@img/sharp-linux-$SHARP_ARCH" "@img/sharp-linux-$SHARP_ARCH/package" && \
    copy_target_sharp_package "@img/sharp-libvips-linux-$SHARP_ARCH" "@img/sharp-libvips-linux-$SHARP_ARCH/package"

# Build the CPU-neutral application once on the native Linux build platform.
FROM --platform=$BUILDPLATFORM node:24-slim AS app-build-base
ARG BUILDARCH
RUN apt-get update && apt-get install -y --no-install-recommends openssl util-linux && \
    rm -rf /var/lib/apt/lists/* && \
    corepack enable && \
    corepack prepare pnpm@10.29.3 --activate

FROM app-build-base AS app-deps
ARG BUILDARCH
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-${BUILDARCH},target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM app-build-base AS builder
ARG BUILDARCH
WORKDIR /app
COPY --from=app-deps /app/node_modules ./node_modules
COPY . .

# Environment variables for build
ENV NEXT_TELEMETRY_DISABLED=1
ENV DBACKUP_DOCKER_BUILD=1
ENV RAYON_NUM_THREADS=1
ENV TOKIO_WORKER_THREADS=1
ENV NEXT_WEBPACK_PARALLELISM=1
ENV NODE_OPTIONS="--max-old-space-size=1792"

# Generate Prisma Client and build the Next.js app.
# The Docker-only Next.js config externalizes large Node-only dependency graphs
# and delegates type-checking to fresh TypeScript processes below.
RUN --mount=type=cache,id=next-build-${BUILDARCH},target=/app/.next/cache \
    pnpm prisma generate && \
    BUILD_CPU="$(awk '$1 == "Cpus_allowed_list:" { split($2, groups, ","); split(groups[1], range, "-"); print range[1] }' /proc/self/status)" && \
    test -n "$BUILD_CPU" && \
    taskset --cpu-list "$BUILD_CPU" pnpm exec next build --webpack

# Sharp is a direct runtime dependency, but Next's explicit Sharp trace can omit
# pnpm-hoisted transitive packages. Copy only Sharp's target-native runtime closure.
RUN SHARP_ARCH="$(node -p 'process.arch')" && \
    copy_sharp_package() { \
      PACKAGE="$1"; \
      PACKAGE_METADATA="$2"; \
      SOURCE_PACKAGE="$(node -e 'const { createRequire } = require("node:module"); const sharpRequire = createRequire(require.resolve("sharp")); process.stdout.write(sharpRequire.resolve(process.argv[1]))' "$PACKAGE_METADATA")" || return 1; \
      test -s "$SOURCE_PACKAGE" || return 1; \
      DESTINATION=".next/standalone/node_modules/$PACKAGE"; \
      mkdir -p "$(dirname "$DESTINATION")" && \
      rm -rf "$DESTINATION" && \
      cp -aL "$(dirname "$SOURCE_PACKAGE")" "$DESTINATION"; \
    }; \
    copy_sharp_package detect-libc detect-libc/package.json && \
    copy_sharp_package semver semver/package.json && \
    copy_sharp_package @img/colour @img/colour/package.json && \
    copy_sharp_package "@img/sharp-linux-$SHARP_ARCH" "@img/sharp-linux-$SHARP_ARCH/package" && \
    copy_sharp_package "@img/sharp-libvips-linux-$SHARP_ARCH" "@img/sharp-libvips-linux-$SHARP_ARCH/package"

# Compile-check the application and custom server in separate cacheable processes.
RUN \
    NODE_OPTIONS="--max-old-space-size=2560" pnpm exec tsc --noEmit --incremental false && \
    NODE_OPTIONS="--max-old-space-size=2560" pnpm exec tsc -p tsconfig.server.json --incremental false

# Verify that standalone output is complete and contains only Linux native addons.
RUN test -s .next/standalone/server.js && \
    test -s .next/standalone/.next/required-server-files.json && \
    test -s .next/standalone/.next/BUILD_ID && \
    test -d .next/standalone/node_modules/next && \
    test -s custom-server.js && \
    node --check custom-server.js && \
    test -n "$(find .next/standalone -type f -name 'libquery_engine-*.so.node' -print -quit)" && \
    test -n "$(find .next/standalone -type f -path '*sharp-linux-*' -name '*.node' -print -quit)" && \
    ! grep -R -E --include='*.nft.json' 'query_engine-windows|sharp-win32' .next && \
    node -e 'const { createRequire } = require("node:module"); const runtimeRequire = createRequire("/app/.next/standalone/server.js"); for (const dependency of ["next", "@prisma/client", "sharp"]) { const resolved = runtimeRequire.resolve(dependency); if (!resolved.startsWith("/app/.next/standalone/")) throw new Error(`${dependency} resolved outside standalone output: ${resolved}`); runtimeRequire(dependency) }' && \
    find .next/standalone -type f -name '*.node' -exec sh -ec 'for file do signature=$(od -An -tx1 -N4 "$file" | tr -d " \n"); test "$signature" = 7f454c46 || { echo "Non-ELF native addon: $file ($signature)" >&2; exit 1; }; done' sh {} + && \
    BAD_NATIVE="$(find .next/standalone -type f \( -name '*windows*.node' -o -name '*.dll.node' -o -path '*/sharp-win32-*/*' \) -print -quit)" && \
    test -z "$BAD_NATIVE"

# Remove build-platform native payloads before the runtime stage copies the
# standalone tree. Target-native Prisma and Sharp files are grafted below.
FROM builder AS portable-builder
RUN PRISMA_CLIENT="$(node -e 'const path = require("node:path"); const { createRequire } = require("node:module"); const runtimeRequire = createRequire("/app/.next/standalone/server.js"); process.stdout.write(path.resolve(path.dirname(runtimeRequire.resolve("@prisma/client/package.json")), "../../.prisma/client"))')" && \
    test -d "$PRISMA_CLIENT" && \
    rm -rf "$PRISMA_CLIENT" && \
    rm -rf \
      .next/standalone/node_modules/@img/sharp-linux-* \
      .next/standalone/node_modules/@img/sharp-libvips-linux-* \
      .next/standalone/node_modules/.pnpm/@img+sharp-linux-* \
      .next/standalone/node_modules/.pnpm/@img+sharp-libvips-linux-* && \
    test -z "$(find .next/standalone -type f -name '*.node' -print -quit)"

# 3. Runner Phase (The actual image)
FROM base AS runner
ARG TARGETARCH
WORKDIR /app

# The Recovery Kit reads this off disk when a user downloads one, so it has to be in the
# image. A missing file is not a build error - the kit is generated with a placeholder
# apologising for its absence, which nobody discovers until they need it. Guarded by
# tests/unit/lint-guards/recovery-kit-shipped.test.ts.
COPY --from=portable-builder --link --chown=1001:1001 /app/scripts/dbackup-recover.js ./scripts/dbackup-recover.js

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Default environment variables (can be overridden at runtime)
ENV DATABASE_URL="file:/data/db/dbackup.db"
ENV TZ="UTC"
ENV LOG_LEVEL="info"
ENV PUID=1001
ENV PGID=1001

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs --no-create-home nextjs

# Copy built files (--link for better layer caching)
COPY --from=portable-builder --link --chown=1001:1001 /app/public ./public
COPY --from=portable-builder --link --chown=1001:1001 /app/.next/standalone ./
COPY --from=portable-builder --link --chown=1001:1001 /app/.next/static ./.next/static
COPY --from=portable-builder --link --chown=1001:1001 /app/prisma ./prisma

# Graft only the target-platform native runtime payload into the portable tree.
RUN --mount=type=bind,from=target-native,source=/target-native,target=/target-native,ro \
    RUNTIME_CLIENT="$(node -e 'const path = require("node:path"); const { createRequire } = require("node:module"); const runtimeRequire = createRequire("/app/server.js"); process.stdout.write(path.resolve(path.dirname(runtimeRequire.resolve("@prisma/client/package.json")), "../../.prisma/client"))')" && \
    mkdir -p "$RUNTIME_CLIENT" /app/node_modules/@img && \
    cp -a /target-native/prisma-client/. "$RUNTIME_CLIENT"/ && \
    cp -a /target-native/node_modules/@img/. /app/node_modules/@img/ && \
    chown -R 1001:1001 "$RUNTIME_CLIENT" /app/node_modules/@img

# Create runtime data directories and copy the minimal Prisma CLI tree.
RUN mkdir -p /data/storage/avatars /data/db /data/certs && \
    chown -R 1001:1001 /data
COPY --from=prisma-cli --link --chown=1001:1001 /pnpm /pnpm

# Copy compiled custom HTTPS server (replaces default Next.js server entry point)
COPY --from=portable-builder --link --chown=1001:1001 /app/custom-server.js ./custom-server.js

# Fail the build if standalone tracing missed required native runtime packages.
RUN node --check custom-server.js && \
    prisma --version && \
    node -e 'Promise.all(["@aws-sdk/lib-storage", "@microsoft/microsoft-graph-client", "dockerode", "dropbox", "googleapis", "mssql", "ssh2", "ssh2-sftp-client"].map(async (dependency) => { try { await import(dependency); console.log(`${dependency}: available`) } catch (error) { console.error(`${dependency}: ${error.code ?? error.message}`); process.exitCode = 1 } }))' && \
    node -e 'require("@prisma/client"); require("sharp")' && \
    test -n "$(find /app/node_modules -type f -name 'libquery_engine-*.so.node' -print -quit)" && \
    test -n "$(find /app/node_modules -type f -path '*sharp-linux-*' -name '*.node' -print -quit)" && \
    EXPECTED_MACHINE="$(case "$TARGETARCH" in amd64) echo 3e00 ;; arm64) echo b700 ;; *) exit 1 ;; esac)" && \
    find / -xdev -type f -name '*.node' -exec sh -ec 'expected="$1"; shift; for file do signature=$(od -An -tx1 -N4 "$file" | tr -d " \n"); machine=$(od -An -tx1 -j18 -N2 "$file" | tr -d " \n"); test "$signature" = 7f454c46 && test "$machine" = "$expected" || { echo "Wrong native addon: $file (signature=$signature machine=$machine expected=$expected)" >&2; exit 1; }; done' sh "$EXPECTED_MACHINE" {} + && \
    BAD_NATIVE="$(find / -xdev -type f \( -name '*windows*.node' -o -name '*.dll.node' -o -path '*/sharp-win32-*/*' \) -print -quit)" && \
    test -z "$BAD_NATIVE"

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

# Health check: verify app + database are reachable
# Uses --insecure for self-signed certs; falls back to http if DISABLE_HTTPS=true
# PORT env var is respected - defaults to 3000 if not set
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -fk https://localhost:${PORT:-3000}/api/health 2>/dev/null || curl -f http://localhost:${PORT:-3000}/api/health || exit 1

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV DISABLE_HTTPS="false"
ENV DATA_DIR="/data"

ENTRYPOINT ["docker-entrypoint.sh"]
