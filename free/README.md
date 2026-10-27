# sub2api, Workers-only install

A container-free version of sub2api that runs on Cloudflare's **free** Workers plan. It is a TypeScript rewrite of CPA (CLIProxyAPI), not CPA itself, and serves **CPA's own dashboard** (Cli-Proxy-API-Management-Center) through a port of CPA's v8 management API. So both installs look and work the same in the browser.

It covers **Claude subscriptions** today; other providers and formats are coming in later phases.

- CPA's dashboard, downloaded at build time from a pinned release and checked against its SHA-256. A weekly PR bumps it, together with the container install's CPA.
- Claude OAuth login from the dashboard's **OAuth Login** page (the same PKCE flow as CPA and Claude Code), with tokens refreshed automatically.
- Several Claude logins, used in turn. Upload, download, disable, edit and delete them under **Auth Files**, in CPA's auth-file format, so files move between the two installs.
- CPA's YAML config, edited in the **Config Panel**. Client API keys live in `access.api-keys`, as in CPA.
- `POST /v1/messages`, `POST /v1/messages/count_tokens` and `GET /v1/models`, streamed straight through to Anthropic.
- Everything is stored in one SQLite-backed Durable Object, which the free plan includes.

Request bodies are never parsed, so a Worker spends well under 1 ms of its 10 ms CPU budget even on a 600 KB Claude Code request (see the CPU test in `test/app.test.ts`).

Not included yet: OpenAI/Gemini formats, Codex, Gemini and other accounts, usage statistics and request logs. Deliberately left out: CPA's request cloaking and TLS fingerprint spoofing. Clients other than Claude Code may be refused by Anthropic when they use a subscription token.

## Try it

You need a Cloudflare account. The free plan is enough.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PlaygrndLabs/sub2api/tree/main/free)

It asks for `DASHBOARD_PASSWORD` (at least 16 characters) and optionally `MANAGEMENT_KEY`. Or from a clone:

```bash
cd free && npm ci
npx wrangler login
npx wrangler deploy
npx wrangler secret put DASHBOARD_PASSWORD   # at least 16 characters
npx wrangler secret put MANAGEMENT_KEY       # optional; defaults to the dashboard password
```

1. Open `https://sub2api-free.<your-subdomain>.workers.dev` and sign in with the dashboard password.
2. CPA's dashboard opens and asks for the management key: enter `MANAGEMENT_KEY`, or the dashboard password if you didn't set one.
3. Under **OAuth Login**, press **+** on Claude, approve on Claude's page, then paste the `localhost` address you land on into **Callback URL**.
4. Under **Config Panel**, add an API key and save, then point Claude Code at the gateway:

```bash
export ANTHROPIC_BASE_URL=https://sub2api-free.<your-subdomain>.workers.dev
export ANTHROPIC_API_KEY=<your gateway API key>
claude
```

Keys and the login made with the first free release keep working: the old login is turned into an auth file on first use.

The management API sits behind both the sign-in cookie and the management key. It is off when neither secret is at least 16 characters.

## Deploying from GitHub

With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set as repository secrets (the same ones the main deploy uses), `.github/workflows/deploy-free.yml` deploys this Worker whenever `free/` changes on `main`. Add a gateway API key as the `SUB2API_FREE_TEST_KEY` secret and each deploy also runs Claude Code through the gateway: one short prompt and one long streamed answer. The `PANEL_VERSION` and `PANEL_SHA256` repository variables override the pinned dashboard; each build log prints the SHA-256 of the one it downloaded.

## Checked live

On 2026-10-27, against a deployed gateway: the Claude login connected from the Worker, `GET /v1/models` answered 200, and Claude Code (`claude -p`) answered both a short prompt and a long streamed one through the gateway.
