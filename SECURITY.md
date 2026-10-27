# Security

## Reporting a vulnerability

Please report privately through [GitHub's private vulnerability reporting](https://github.com/PlaygrndLabs/sub2api/security/advisories/new). Don't open a public issue. We aim to reply within a week.

Bugs in CPA itself belong upstream at [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

## Security model

Everything a deploy holds belongs to its owner: your Cloudflare account, your R2 bucket and your secrets. This repository has no keys, telemetry or shared backend.

- **API calls need a key.** On its own, CPA lets every `/v1/*` and `/v1beta/*` call through while its key list is empty. The gateway closes that gap: before forwarding, it asks CPA with a random key (`src/key-guard.ts`). If CPA accepts it, no keys are set up, so the gateway refuses the call. If CPA can't be reached, the gateway refuses too. The check runs in the single Durable Object in front of the container, so every request sees the same answer, and a dashboard change takes effect at once.
- **The dashboard needs two secrets.** First the `DASHBOARD_PASSWORD` sign-in, which sets an HMAC-signed `__Host-` cookie (HttpOnly, Secure, SameSite=Strict) that lasts 12 hours. Then CPA's own management key. Sign-in attempts are limited to 5 a minute per IP. Changing the password signs out every session.
- **Only known paths reach CPA.** The API, the dashboard, `/healthz` and the OAuth callback (for a signed-in user only) are forwarded. Everything else, and any path with encoded separators, returns 404. Browser cookies are stripped before forwarding.
- **State stays in your R2 bucket.** CPA's S3 client talks to `http://r2.internal`, which only the container can reach and which the Worker serves from an R2 binding. No R2 API tokens exist.
- **Pinned upstream, reviewed upgrades.** The container builds a pinned CPA release (`CPA_VERSION`, and `CPA_COMMIT` so a moved tag fails the build), and both installs download a pinned dashboard release checked against its SHA-256 (`container/Dockerfile`, `free/scripts/fetch-panel.mjs`). Every Monday `.github/workflows/bump-upstream.yml` looks for new releases, smoke-tests them and opens a PR. Nothing upstream reaches your gateway until a person merges that PR. Read the upstream changes first: the dashboard runs on your gateway's origin with the management key, and CPA holds every login.

### The Workers-only install (`free/`)

- **API calls need a key from `access.api-keys`.** The key check and the Claude token are cached per Worker isolate for at most a minute, so a key or login you remove stops working everywhere within a minute.
- **The dashboard and management API need two secrets,** as above: the `DASHBOARD_PASSWORD` sign-in cookie and the management key (`MANAGEMENT_KEY`, or the password when it isn't set). Use a separate `MANAGEMENT_KEY`: the dashboard can remember the key it is given in browser storage. Sign-in attempts are limited to 5 a minute per IP, and the dashboard page is never framed.
- **Only Anthropic is called.** The three proxied paths go to `api.anthropic.com` with an allowlist of request headers; the client's key and cookies are never forwarded. OAuth uses PKCE (S256), and refresh tokens stay in the Durable Object's storage.

## Your part

- Use long random secrets: `openssl rand -hex 32`.
- Give each app its own API key, and delete a key the moment it may have leaked.
- Never commit `.dev.vars`. It is in `.gitignore`.
