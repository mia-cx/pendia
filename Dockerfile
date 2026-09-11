FROM oven/bun:1.4 AS build

WORKDIR /app

COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/plugin-api/package.json packages/plugin-api/package.json
COPY plugins/webhooks/package.json plugins/webhooks/package.json

RUN bun install --frozen-lockfile

COPY apps apps
COPY packages packages
COPY plugins plugins

RUN bun run --cwd apps/web build
RUN bun build --compile apps/server/src/index.ts --outfile /app/pendia

FROM debian:trixie-slim AS runtime

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system pendia \
  && useradd --system --gid pendia --home-dir /app --no-create-home --shell /usr/sbin/nologin pendia

WORKDIR /app

COPY --from=build --chown=pendia:pendia /app/pendia /app/pendia
COPY --from=build --chown=pendia:pendia /app/apps/web/build /app/web

ENV PENDIA_PORT=3000
ENV PENDIA_WEB_ROOT=/app/web

USER pendia

EXPOSE 3000

ENTRYPOINT ["/app/pendia"]
CMD ["--role", "all"]
