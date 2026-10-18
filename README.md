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

## Single sign-on (OpenID Connect)

Built in and optional. **E-mail + password login keeps working**; SSO adds a "Sign in with SSO" button on the login page and a direct trigger link:

    https://<your-domain>/sso/login          # goes straight to your identity provider
    https://<your-domain>/sso/login?email=a@b.com   # same, with a login hint

The **verified e-mail address is the identity**: the e-mail from the provider is matched to the Joplin user with that e-mail. If no user has it, login is refused with a clear message, unless `OIDC_AUTO_CREATE_USERS=true`, which creates the account on first SSO login. Accounts whose provider e-mail is marked unverified are rejected.

Works with any OIDC provider (Authentik, Keycloak, Google, ...). Authentik example:

1. Create an **OAuth2/OpenID provider** + application. Client type **Confidential**.
2. Redirect URI (strict): `https://<your-domain>/sso/callback`
3. Scopes: `openid`, `email`, `profile`. Pick a signing key (RS256 recommended; HS256 also works).
4. Set these variables on the `app` service in Coolify, then redeploy:

| Variable | Value |
|---|---|
| `OIDC_ENABLED` | `true` |
| `OIDC_ISSUER_URL` | `https://auth.example.com/application/o/<slug>/` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | from the provider |
| `OIDC_AUTO_CREATE_USERS` | `false` (default) or `true` |
| `OIDC_BUTTON_LABEL`, `OIDC_SCOPES`, `OIDC_REDIRECT_URI` | optional |

Implementation: authorization code flow with PKCE, signed state cookie, ID token checks (signature via JWKS, issuer, audience, expiry, nonce). No extra dependencies.

**Sync clients:** the Joplin apps sync with e-mail + password. Apps that authorise through the browser (the *Applications* page) are supported too: the SSO button and `/sso/login?application_auth_id=...` carry that request through, and you land on the authorisation page after SSO (not tested with a real client yet). Users created through SSO have no password, so for plain e-mail sync they need to set one first.

## Local

    cp .env.example .env && docker compose up --build

## Licence note

Joplin Server is licensed by its authors under the **Joplin Server Personal Use License** (personal, non-commercial use; no redistribution or modification without their permission). Keep your use within that license. Branding assets (logos, theme) belong to Anands.
