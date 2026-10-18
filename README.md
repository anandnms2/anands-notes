# Anands Notes

[Joplin Server](https://github.com/laurent22/joplin) with the Anands look: orange/black/grey theme, Anands logos and favicons, "Anands Notes" naming. This covers the **web interface of the server** (login, admin, published notes). Notes are still written in the Joplin desktop and mobile apps and synced here.

This repo contains **no Joplin source code**. The Docker build downloads the pinned upstream release (`JOPLIN_REF`, default `server-v3.7.2`), applies `branding/apply-branding.py` plus the files in `branding/overlay/`, and builds it the same way upstream's `Dockerfile.server` does. If an upstream update stops matching, the build fails loudly instead of producing a half-branded image.

## Deploy on Coolify

1. New Resource -> Public Repository -> `https://github.com/anandnms2/anands-notes`, Build Pack **Docker Compose**.
2. Set the domain of the `app` service (for example `https://notes.anands.xyz`). Coolify supplies `SERVICE_URL_APP_22300` and `SERVICE_PASSWORD_POSTGRES`.
3. Deploy. First build takes a while (full yarn install and TypeScript build).
4. Log in with `admin@localhost` / `admin` and **change the password immediately**.
5. In the Joplin app: Synchronisation target "Joplin Server (Beta)", URL = your domain.

Both services have health checks: `db` uses `pg_isready`, `app` calls `/api/ping`; `app` waits for `db` to be healthy.

## Local

    cp .env.example .env && docker compose up --build

## Licence note

Joplin Server is licensed by its authors under the **Joplin Server Personal Use License** (personal, non-commercial use; no redistribution or modification without their permission). Keep your use within that license. Branding assets (logos, theme) belong to Anands.
