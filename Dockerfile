# syntax=docker/dockerfile:1.7

# Build-time ARGs that participate in FROM substitutions or cross-stage usage
# must be declared in the global scope (before any FROM). They still need to
# be re-declared inside the stages that consume them in RUN / LABEL / ENV —
# global ARGs are only visible to FROM lines.
ARG BUILD_FROM
ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_DESCRIPTION
ARG BUILD_NAME
ARG BUILD_REF
ARG BUILD_REPOSITORY
ARG BUILD_VERSION

# ─── Stage 1 — build the web bundle ──────────────────────────────────────────
# Uses Docker Hub's multi-arch node:22-alpine; HA Supervisor's build runs on
# the target arch so we never cross-compile.
FROM node:22-alpine AS webbuilder
WORKDIR /build/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build


# ─── Stage 2 — install server deps (tsx is runtime, not just dev) ────────────
FROM node:22-alpine AS serverdeps
WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci


# ─── Stage 3 — Home Assistant add-on runtime ─────────────────────────────────
# hadolint ignore=DL3006
FROM ${BUILD_FROM}

# HA base images are Alpine + s6-overlay + bashio. Add Node 22 (Alpine 3.21+
# main repo) and a CA bundle for outbound HTTPS to the EcoFlow API.
RUN apk add --no-cache nodejs npm ca-certificates tzdata

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DB_PATH=/data/ecoflow.db \
    WEB_DIST_PATH=/app/web/dist

WORKDIR /app
COPY server/ ./server/
COPY --from=serverdeps /build/server/node_modules ./server/node_modules
COPY --from=webbuilder /build/web/dist ./web/dist
# v0.9.55 — bundle the prebuilt HACS Lovelace cards so the add-on can
# serve them at `/lovelace/*` for dashboards that aren't using HACS.
# These are committed to git in `lovelace/dist/` so this stage doesn't
# need a Node build pass for the cards.
COPY lovelace/dist ./lovelace/dist

# s6 service runner — bashio translates HA Options into env vars at start time.
COPY rootfs/ /
RUN chmod a+x /etc/services.d/ecoflow-panel/run

# Web + API; telnet TUI
EXPOSE 8787 2323

# Add-on metadata — re-declare the ARGs we need inside this stage so LABEL
# can substitute them.
ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_DESCRIPTION
ARG BUILD_NAME
ARG BUILD_REF
ARG BUILD_REPOSITORY
ARG BUILD_VERSION
LABEL \
    io.hass.name="${BUILD_NAME}" \
    io.hass.description="${BUILD_DESCRIPTION}" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}" \
    org.opencontainers.image.title="${BUILD_NAME}" \
    org.opencontainers.image.description="${BUILD_DESCRIPTION}" \
    org.opencontainers.image.source="https://github.com/${BUILD_REPOSITORY}" \
    org.opencontainers.image.revision="${BUILD_REF}" \
    org.opencontainers.image.created="${BUILD_DATE}" \
    org.opencontainers.image.licenses="MIT"

# v0.14.0 — promote the build metadata to runtime ENV so /api/version reports the
# real release instead of "dev". These were ARG-only (consumed by LABEL above) and
# therefore absent from the running process's environment, so process.env.BUILD_VERSION
# was always undefined → the version endpoint, GUI/TUI footer and support diagnostics
# all read "dev" on every published image.
ENV BUILD_VERSION=${BUILD_VERSION} \
    BUILD_DATE=${BUILD_DATE} \
    BUILD_REF=${BUILD_REF}
