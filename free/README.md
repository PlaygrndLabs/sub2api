# sub2api, Workers-only install

A container-free version of sub2api that runs on Cloudflare's **free** Workers plan. It is a TypeScript rewrite of CPA (CLIProxyAPI), not CPA itself, and serves **CPA's own dashboard** (Cli-Proxy-API-Management-Center) through a port of CPA's v8 management API. So both installs look and work the same in the browser.

It covers **Claude and ChatGPT (Codex) subscriptions** and **API keys** for Claude, Gemini, Codex and any OpenAI-compatible provider. More OAuth providers and format translation come in later phases.

- CPA's dashboard, downloaded at build time from the latest panel release (pin one with `PANEL_VERSION`, and its checksum with `PANEL_SHA256`).
- Claude and ChatGPT (Codex) OAuth logins from the dashboard's **OAuth Login** page (the same PKCE flows as CPA, Claude Code and the Codex CLI), with tokens refreshed automatically.
- Several logins per provider, used in turn. Upload, download, disable, edit and delete them under **Auth Files**, in CPA's auth-file format, so files move between the two installs.
- CPA's YAML config, edited in the **Config Panel**. Client API keys live in `access.api-keys`, as in CPA.
- `POST /v1/messages` and `POST /v1/messages/count_tokens`, streamed straight through to Anthropic.
- API-key providers added under **AI Providers** (CPA's `api-keys` config): Claude, Gemini, Codex and OpenAI-compatible endpoints such as OpenRouter. Model aliases, `prefix/model` routing, priorities, key weights and excluded models work as in CPA, and a request moves on to the next key when one is rate limited or failing.
- Codex CLI through a ChatGPT login, on `/backend-api/codex/responses` or `/v1/responses`. Other OpenAI Responses clients work too: their requests are adapted to what the ChatGPT endpoint takes, and a non-streaming request gets the final response as JSON.
- Claude Code on an OpenAI-compatible key (OpenRouter and the like): ask for one of the provider's model aliases and the request goes out as Chat Completions, with the answer streamed back as Anthropic events, following CPA's Claude-to-OpenAI translator.
- Claude Code on a ChatGPT login or a Codex API key: ask for a ChatGPT model (for example `ANTHROPIC_MODEL=gpt-5.6-sol`) and the request is translated to OpenAI Responses and the answer streamed back as Anthropic events, with thinking, tool calls and images, following CPA's Claude-to-Codex translator.
- Claude Code on a Gemini API key: ask for a Gemini model (for example `ANTHROPIC_MODEL=gemini-2.5-flash`) and the request goes out as Gemini `generateContent`, with thinking, tool calls and images, following CPA's Claude-to-Gemini translator. Unlike CPA, Google's default safety filters stay on; a blocked answer ends with a `refusal` stop reason.
- OpenAI Chat clients (Cursor, Cline, the OpenAI SDKs and the like) on a Claude API key: ask `/v1/chat/completions` for a Claude model and the request goes out as Anthropic Messages, with reasoning effort, tool calls, images, files and prompt caching, and the answer comes back as Chat Completions, following CPA's OpenAI-to-Claude translator. Claude logins aren't offered to these clients, since without CPA's cloaking Anthropic accepts a subscription token from Claude Code only.
- OpenAI Responses clients on a Claude API key, the same way, following CPA's Responses-to-Claude translator: reasoning, function and custom tool calls, images and files, streamed as Responses events or returned whole.
- OpenAI Chat and Responses clients on any other provider too (a Gemini key, an OpenAI-compatible key, a Codex key or a ChatGPT login): the request is translated to Anthropic Messages and on to the provider's format, and the answer back the same way.
- Each client talks in its own format: Anthropic (`/v1/messages`), OpenAI Chat (`/v1/chat/completions`), OpenAI Responses (`/v1/responses`) and Gemini (`/v1beta/models/{model}:generateContent`). A request goes to a provider that takes the same format, apart from the translations above.
- Model lists as in CPA: `GET /v1/models` (OpenAI's shape, or Anthropic's for Claude Code and the Anthropic SDKs), `GET /v1beta/models` and `GET /v1beta/models/{model}` list every model across the logins and API keys, and so does the dashboard's **Available Models**. A login or key with no model list of its own lists CPA's catalog for its provider, and a ChatGPT login the catalog for its plan. The catalog is refreshed from CPA's model catalog every three hours, with a built-in copy as fallback; it only decides what is listed, never where a request goes.
- Usage and logs as in CPA: each login and API key shows its success and failure counts and the last 200 minutes in 10-minute buckets, and with **Logging to file** on, the **Logs** page shows a line per API request (the last 2,000). Lines hold the time, status, latency, client IP, path, provider and model, never request bodies or keys. Records are sent to the Durable Object in batches a few seconds apart.
- Everything is stored in one SQLite-backed Durable Object, which the free plan includes.

Claude Code and Codex CLI request bodies are never parsed, so a Worker spends well under 1 ms of its 10 ms CPU budget even on a 600 KB Claude Code request (see the CPU test in `test/app.test.ts`). Requests that need a model rewritten or a body adapted are parsed once. Translated requests cost the most, about 4 to 6 ms for a 600 KB conversation; very long conversations translated can run past the free plan's 10 ms, which the Container install doesn't have.

Not included yet: Gemini clients on other providers, Gemini and other OAuth logins, the Codex CLI's own model list (`/v1/models?client_version=`), and CPA's per-request detail logs. Deliberately left out: CPA's request cloaking and TLS fingerprint spoofing. Clients other than Claude Code may be refused by Anthropic when they use a subscription token.

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

1. Open `https://sub2api-free.<your-subdomain>.workers.dev` and sign in with the dashboard password.
2. CPA's dashboard opens and asks for the management key: enter `MANAGEMENT_KEY`.
3. Under **OAuth Login**, press **+** on Claude, approve on Claude's page, then paste the `localhost` address you land on into **Callback URL**.
4. Under **Config Panel**, add an API key and save, then point Claude Code at the gateway:

```bash
export ANTHROPIC_BASE_URL=https://sub2api-free.<your-subdomain>.workers.dev
export ANTHROPIC_API_KEY=<your gateway API key>
claude
```

For the Codex CLI, sign in under **OAuth Login** on Codex the same way, then add a provider to `~/.codex/config.toml` and set `SUB2API_KEY` to your gateway API key:

```toml
model_provider = "sub2api"

[model_providers.sub2api]
name = "sub2api"
base_url = "https://sub2api-free.<your-subdomain>.workers.dev/backend-api/codex"
wire_api = "responses"
env_key = "SUB2API_KEY"
```

Keys and the login made with the first free release keep working: the old login is turned into an auth file on first use.

The management API sits behind both the sign-in cookie and the management key. It stays off until `MANAGEMENT_KEY` is set to at least 16 characters and differs from the dashboard password, because the dashboard keeps the key in browser storage.

## Deploying from GitHub

With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set as repository secrets (the same ones the main deploy uses), `.github/workflows/deploy-free.yml` deploys this Worker whenever `free/` changes on `main`. Add a gateway API key as the `SUB2API_FREE_TEST_KEY` secret and each deploy also runs Claude Code through the gateway: one short prompt and one long streamed answer. To freeze the dashboard, set the `PANEL_VERSION` and `PANEL_SHA256` repository variables; each build log prints the SHA-256 of the dashboard it downloaded.

## Checked live

On 2026-10-27, against a deployed gateway: the Claude login connected from the Worker, `GET /v1/models` answered 200, and Claude Code (`claude -p`) answered both a short prompt and a long streamed one through the gateway.
