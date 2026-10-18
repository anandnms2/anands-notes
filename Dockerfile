# =============================================================================
# Anands Notes = Joplin Server (pinned upstream release) + Anands branding.
# This repo contains no Joplin source: the build clones upstream, applies
# branding/apply-branding.py, then builds exactly like upstream's Dockerfile.server.
# =============================================================================
ARG JOPLIN_REF=server-v3.7.2

# -----------------------------------------------------------------------------
# Source stage: upstream + branding
# -----------------------------------------------------------------------------
FROM node:24 AS source
ARG JOPLIN_REF
RUN apt-get update && apt-get install -y --no-install-recommends git python3 \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${JOPLIN_REF} https://github.com/laurent22/joplin.git /src
COPY branding /branding
RUN python3 /branding/apply-branding.py /src /branding/overlay \
    && python3 /branding/apply-sso.py /src /branding/sso

# -----------------------------------------------------------------------------
# Build stage
# -----------------------------------------------------------------------------
FROM node:24 AS builder

RUN apt-get update \
    && apt-get install -y \
    python3 tini \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /build

COPY --from=source /src/.yarn/releases ./.yarn/releases
COPY --from=source /src/.yarn/patches ./.yarn/patches
COPY --from=source /src/package.json .
COPY --from=source /src/.yarnrc.yml .
COPY --from=source /src/yarn.lock .
COPY --from=source /src/gulpfile.js .
COPY --from=source /src/tsconfig.json .
COPY --from=source /src/packages/turndown ./packages/turndown
COPY --from=source /src/packages/turndown-plugin-gfm ./packages/turndown-plugin-gfm
COPY --from=source /src/packages/fork-htmlparser2 ./packages/fork-htmlparser2
COPY --from=source /src/packages/fork-sax ./packages/fork-sax
COPY --from=source /src/packages/fork-uslug ./packages/fork-uslug
COPY --from=source /src/packages/htmlpack ./packages/htmlpack
COPY --from=source /src/packages/renderer ./packages/renderer
COPY --from=source /src/packages/tools ./packages/tools
COPY --from=source /src/packages/utils ./packages/utils
COPY --from=source /src/packages/lib ./packages/lib
COPY --from=source /src/packages/server ./packages/server

# onenote-converter is not used by the server
RUN sed --in-place '/onenote-converter/d' ./packages/lib/package.json

RUN --mount=type=cache,target=/build/.yarn/cache --mount=type=cache,target=/build/.yarn/berry/cache \
    BUILD_SEQUENCIAL=1 yarn config set cacheFolder /build/.yarn/cache \
    && yarn install --inline-builds \
    && sed --in-place 's/"postinstall": ".*"/"postinstall": ""/' ./package.json ./packages/*/package.json \
    && yarn workspaces focus --production --all

# -----------------------------------------------------------------------------
# Final stage
# -----------------------------------------------------------------------------
FROM node:24-slim

ARG user=joplin
RUN useradd --create-home --shell /bin/bash $user

RUN npm i -g pm2@5.4.3 && mkdir -p /opt/pm2 && chown -R $user:$user /opt/pm2
ENV PM2_HOME=/opt/pm2

USER $user

COPY --chown=$user:$user --from=builder /build/packages /home/$user/packages
COPY --chown=$user:$user --from=builder /usr/bin/tini /usr/local/bin/tini

RUN pm2 install https://registry.npmjs.org/pm2-logrotate/-/pm2-logrotate-3.0.0.tgz \
	&& pm2 set pm2-logrotate:max_size 100MB \
	&& pm2 set pm2-logrotate:retain 5 \
	&& pm2 set pm2-logrotate:compress true

ENV LICENSE_REQUIRED=0
ENV NODE_ENV=production
ENV RUNNING_IN_DOCKER=1
ENV APP_PORT=22300
ENV APP_NAME="Anands Notes"
EXPOSE 22300

# node:slim has no curl/wget, so the health check uses node itself
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||22300)+'/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /home/$user/packages/server
ENTRYPOINT ["tini", "--"]
CMD ["yarn", "start-prod"]

LABEL org.opencontainers.image.title="Anands Notes" \
      org.opencontainers.image.description="Joplin Server with Anands branding" \
      org.opencontainers.image.source="https://github.com/anandnms2/anands-notes"
