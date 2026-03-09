# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build-base

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
ENV HTTP_PROXY="${HTTP_PROXY}"
ENV HTTPS_PROXY="${HTTPS_PROXY}"
ENV NO_PROXY="${NO_PROXY}"
ENV http_proxy="${http_proxy}"
ENV https_proxy="${https_proxy}"
ENV no_proxy="${no_proxy}"

RUN set -eux; \
  PROXY="${http_proxy:-${HTTP_PROXY:-}}"; \
  HTTPS_PROXY_VALUE="${https_proxy:-${HTTPS_PROXY:-}}"; \
  if [ -n "${PROXY}" ]; then npm config set proxy "${PROXY}"; fi; \
  if [ -n "${HTTPS_PROXY_VALUE}" ]; then npm config set https-proxy "${HTTPS_PROXY_VALUE}"; fi; \
  npm install -g pnpm@10.30.3

FROM build-base AS deps
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY .npmrc ./
RUN pnpm install --frozen-lockfile

FROM build-base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm build

FROM node:22-bookworm-slim AS runner

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV HTTP_PROXY="${HTTP_PROXY}"
ENV HTTPS_PROXY="${HTTPS_PROXY}"
ENV NO_PROXY="${NO_PROXY}"
ENV http_proxy="${http_proxy}"
ENV https_proxy="${https_proxy}"
ENV no_proxy="${no_proxy}"

WORKDIR /app

RUN set -eux; \
  PROXY="${http_proxy:-${HTTP_PROXY:-}}"; \
  HTTPS_PROXY_VALUE="${https_proxy:-${HTTPS_PROXY:-}}"; \
  if [ -n "${PROXY}" ] || [ -n "${HTTPS_PROXY_VALUE}" ]; then \
    { \
      [ -n "${PROXY}" ] && printf 'Acquire::http::Proxy "%s";\n' "${PROXY}"; \
      [ -n "${HTTPS_PROXY_VALUE}" ] && printf 'Acquire::https::Proxy "%s";\n' "${HTTPS_PROXY_VALUE}"; \
    } > /etc/apt/apt.conf.d/99proxy; \
  fi; \
  apt-get update \
  && apt-get install -y --no-install-recommends curl zip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/data/.gitkeep ./data/.gitkeep

RUN groupadd --gid 1001 nodejs \
  && useradd --uid 1001 --gid nodejs --create-home nextjs \
  && mkdir -p /app/data \
  && chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server.js"]
