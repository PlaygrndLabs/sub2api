# sub2api, Workers-only install

A container-free version of sub2api that runs on Cloudflare's **free** Workers plan. It is a TypeScript rewrite of CPA (CLIProxyAPI), not CPA itself, and serves **CPA's own dashboard** (Cli-Proxy-API-Management-Center) through a port of CPA's v8 management API. So both installs look and work the same in the browser.

It covers **Claude, ChatGPT (Codex) and Kimi subscriptions**, **Vertex AI service accounts**, and **API keys** for Claude, Gemini (including Interactions), Vertex AI, Codex, xAI and any OpenAI-compatible provider.

- CPA's dashboard, downloaded at build time from the latest panel release (pin one with `PANEL_VERSION`, and its checksum with `PANEL_SHA256`).
- Claude and ChatGPT (Codex) logins from the dashboard's **OAuth Login** page (the same PKCE flows as CPA, Claude Code and the Codex CLI), Kimi logins through Kimi's device sign-in, and Vertex service accounts from a Google Cloud key file. Tokens refresh automatically.
- Several logins per provider, used in turn. Upload, download, disable, edit and delete them under **Auth Files**, in CPA's auth-file format, so files move between the two installs.
- CPA's YAML config, edited in the **Config Panel**. Client API keys live in `access.api-keys`, as in CPA.
- API-key providers under **AI Providers** (CPA's `api-keys` config), with model aliases, `prefix/model` routing, priorities, weights and excluded models as in CPA.
- Each client talks in its own format: Anthropic (`/v1/messages`), OpenAI Chat (`/v1/chat/completions`), OpenAI Responses (`/v1/responses`, or `/backend-api/codex/responses` for the Codex CLI), Gemini (`/v1beta/models/{model}:generateContent`) and Gemini Interactions (`/v1beta/interactions`, Interactions keys only, as in CPA).
- Any client reaches any provider. A request the provider can't take as sent is translated, following CPA's translators, with thinking, tool calls, images and streaming. Claude Code and Codex CLI requests to their own logins pass through untouched.
- Claude logins serve Claude Code only: without CPA's cloaking, Anthropic accepts a subscription token from Claude Code alone. Other clients use Claude models through a Claude API key.
- Model lists as in CPA: `GET /v1/models`, `GET /v1beta/models` and the dashboard's **Available Models** list every model across logins and keys, from CPA's model catalog (refreshed every three hours). The Codex CLI gets its own catalog format (see `model_catalog_url` below).
- CPA's routing, set in the `routing` config section: `round-robin`, `weighted-round-robin` and `fill-first`, failover to the next login or key, retries, and CPA's cooldowns for rate-limited or failing credentials, honouring the provider's stated reset. **Auth Files** shows each login's cooldowns. A request makes at most 10 upstream attempts within 2 minutes, to stay inside the free plan's limits.
- Usage and logs as in CPA: success and failure counts per login and key, and with **Logging to file** on, a **Logs** line per API request (the last 2,000), never with request bodies or keys.
- Everything is stored in one SQLite-backed Durable Object, which the free plan includes.

Claude Code and Codex CLI request bodies are never parsed, so a Worker spends well under 1 ms of its 10 ms CPU budget even on a 600 KB Claude Code request (see the CPU test in `test/app.test.ts`). Requests that need a model rewritten or a body adapted are parsed once. Translated requests cost the most, about 4 to 6 ms for a 600 KB conversation; very long translated conversations can run past the free plan's 10 ms, which the Container install doesn't have.

Not included yet: Gemini and other OAuth logins, and CPA's per-request detail logs. Deliberately left out: CPA's request cloaking and TLS fingerprint spoofing. Unlike CPA, Google's default safety filters stay on for Gemini.

## Try it

You need a Cloudflare account. The free plan is enough.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PlaygrndLabs/sub2api/tree/main/free)

It asks for `DASHBOARD_PASSWORD` and `MANAGEMENT_KEY`, each at least 16 characters and different from each other, as on the Container install. Or from a clone:

```bash
cd free && npm ci
npx wrangler login
npx wrangler deploy
npx wrangler secret put DASHBOARD_PASSWORD   # at least 16 characters
npx wrangler secret put MANAGEMENT_KEY       # at least 16 characters, not the dashboard password
```

The Worker is named `sub2api`, like the Container install, so put only one of the two on an account. Installs made before 2026-10-29 were named `sub2api-free`, and updating one creates a new, empty Worker. To keep your logins and keys, set `"name": "sub2api-free"` in `free/wrangler.jsonc` before you update.

1. Open `https://sub2api.<your-subdomain>.workers.dev` and sign in with the dashboard password.
2. CPA's dashboard opens and asks for the management key: enter `MANAGEMENT_KEY`.
3. Under **OAuth Login**, press **+** on Claude, approve on Claude's page, then paste the `localhost` address you land on into **Callback URL**.
4. Under **Config Panel**, add an API key and save, then point Claude Code at the gateway:

```bash
export ANTHROPIC_BASE_URL=https://sub2api.<your-subdomain>.workers.dev
export ANTHROPIC_API_KEY=<your gateway API key>
claude
```

For the Codex CLI, sign in under **OAuth Login** on Codex the same way, then add a provider to `~/.codex/config.toml` and set `SUB2API_KEY` to your gateway API key:

```toml
model_provider = "sub2api"

[model_providers.sub2api]
name = "sub2api"
base_url = "https://sub2api.<your-subdomain>.workers.dev/backend-api/codex"
wire_api = "responses"
env_key = "SUB2API_KEY"
model_catalog_url = "https://sub2api.<your-subdomain>.workers.dev/v1/models"
```

`model_catalog_url` makes the Codex CLI's model picker list every model the gateway serves (Claude, Gemini and the rest, not only ChatGPT's), in the CLI's own catalog format, as CPA answers it. Leave it out to keep the CLI's built-in list.

Keys and the login made with the first free release keep working: the old login is turned into an auth file on first use.

The management API sits behind both the sign-in cookie and the management key. It stays off until `MANAGEMENT_KEY` is set to at least 16 characters and differs from the dashboard password, because the dashboard keeps the key in browser storage.

## Deploying from GitHub

With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set as repository secrets (the same ones the main deploy uses), `.github/workflows/deploy-free.yml` deploys this Worker whenever `free/` changes on `main`. Add a gateway API key as the `SUB2API_FREE_TEST_KEY` secret and each deploy also runs Claude Code through the gateway: one short prompt and one long streamed answer. To freeze the dashboard, set the `PANEL_VERSION` and `PANEL_SHA256` repository variables; each build log prints the SHA-256 of the dashboard it downloaded.

## Checked live

On 2026-10-27, against a deployed gateway: the Claude login connected from the Worker, `GET /v1/models` answered 200, and Claude Code (`claude -p`) answered both a short prompt and a long streamed one through the gateway.
