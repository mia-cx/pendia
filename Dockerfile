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
RUN bun build --compile apps/server/src/index.ts --outfile /app/thalia

FROM debian:trixie-slim AS runtime

# Trixie ships ffmpeg 7.1.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl ffmpeg \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system thalia \
  && useradd --system --gid thalia --home-dir /app --no-create-home --shell /usr/sbin/nologin thalia \
  && install --directory --owner thalia --group thalia /var/lib/thalia

WORKDIR /app

COPY --from=build --chown=thalia:thalia /app/thalia /app/thalia
COPY --from=build --chown=thalia:thalia /app/apps/server/drizzle /app/drizzle
COPY --from=build --chown=thalia:thalia /app/apps/web/build /app/web

ENV THALIA_PORT=3000
ENV THALIA_WEB_ROOT=/app/web

USER thalia

EXPOSE 3000

ENTRYPOINT ["/app/thalia"]
CMD ["--role", "all"]
