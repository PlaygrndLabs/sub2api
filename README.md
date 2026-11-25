# sub2api: a Cloudflare-based LLM gateway and proxy server

[![ci](https://github.com/PlaygrndLabs/sub2api/actions/workflows/ci.yml/badge.svg)](https://github.com/PlaygrndLabs/sub2api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA), deployed as a Cloudflare Worker in one click.** Turn your Claude, ChatGPT Codex, Gemini and Kimi subscriptions into your own private API, with no server left running.

Free and open source; sub2api never charges you anything.

| Install | Your Cloudflare plan | What runs | Deploy |
|---|---|---|---|
| **Container** | Workers Paid ($5/month, for Containers) | The latest CPA release in a container | <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/PlaygrndLabs/sub2api"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" width="170"></a> |

## Quick start

You need the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) ($5/month, for Containers). On Workers Free, the build stops before deploying; use the [Workers-only install (beta)](#workers-only-install-beta).

1. Press **Deploy to Cloudflare** above.
2. Set `DASHBOARD_PASSWORD`, your dashboard password. CPA's management key is derived from it.
3. Open `https://sub2api.<your-subdomain>.workers.dev`, sign in, and create an API key under **API Keys**.

## Connect a subscription

1. In the dashboard, open **OAuth login** and pick a provider (for Claude: Anthropic).
2. Sign in. You land on a `localhost` page that doesn't load; that's expected.
3. Paste that address into the **Callback URL** field.

CPA refreshes tokens on its own.

## Use it

Claude Code, the Claude Agent SDK and the Anthropic SDKs:

```bash
export ANTHROPIC_BASE_URL=https://sub2api.<your-subdomain>.workers.dev
export ANTHROPIC_API_KEY=<your gateway API key>
```

OpenAI-compatible clients (Codex CLI, OpenAI SDKs, Cursor, and others):

```bash
export OPENAI_BASE_URL=https://sub2api.<your-subdomain>.workers.dev/v1
export OPENAI_API_KEY=<your gateway API key>
```

Gemini clients use `<gateway>/v1beta` with the same key.

```bash
curl https://sub2api.<your-subdomain>.workers.dev/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5-5","max_tokens":64,"messages":[{"role":"user","content":"Say hi"}]}'
```

`GET /v1/models` lists your models. Give each app its own key.

## Why

- **One click, no server.** Cloudflare builds and runs everything.
- **The real CPA.** The latest release and official dashboard, rebuilt weekly. Anthropic, OpenAI-compatible and Gemini APIs.
- **Private by default.** The dashboard needs a password; API calls need a key you create.
- **Logins that stick.** Config and logins live in your own R2 bucket.
- **Costs little when idle.** The container sleeps after 30 minutes.

## How it works

```
app ──► Worker ──► Durable Object ──► Container: CPA ──► Claude / Codex / Gemini
                   · API key check        │
                   · dashboard sign-in    └─► http://r2.internal ──► R2 bucket
```

A Durable Object in front of the container checks API keys and the dashboard password. CPA's storage is an R2 binding, so you never create storage keys. See [SECURITY.md](SECURITY.md).

## Update

A Deploy-button copy redeploys when its `main` branch changes. To update:

```bash
git pull https://github.com/PlaygrndLabs/sub2api main
git push
```

If git refuses unrelated histories, add `--allow-unrelated-histories` once. Logins and config survive updates.

<details>
<summary><b>Deploy with wrangler or GitHub Actions</b></summary>

```bash
npm ci
npx wrangler login
npx wrangler r2 bucket create sub2api
npm run deploy             # needs Docker to build the image
sh scripts/set-secrets.sh  # generates the password, stores it, prints it once
```

GitHub Actions: add the secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts, Containers, Workers R2 Storage: Edit) and `CLOUDFLARE_ACCOUNT_ID`, then run **deploy container** once by hand. After that, every green `ci` run on `main` deploys, and a weekly run picks up the newest CPA. Each workflow updates only the install your Worker `sub2api` already runs.

Change the password with `wrangler secret put DASHBOARD_PASSWORD`. It signs out every session. Installs with a `MANAGEMENT_KEY` secret keep using that key.
</details>

<details>
<summary><b>Develop</b></summary>

```bash
npm ci
npm run verify              # typecheck, lint, unit tests
sh test/container-smoke.sh  # needs Docker: runs CPA against the R2 shim
```

To freeze CPA and the dashboard, set `CPA_VERSION`, `PANEL_VERSION` and `PANEL_SHA256` in `container/Dockerfile`.
</details>

## Workers-only install (beta)

**Beta**, and may change between releases. The Container install is the main install.

For Workers Free. The Worker runs our TypeScript port of CPA, with the same dashboard. API keys work with every app and provider. Logins are limited: Claude only with Claude Code, ChatGPT only for voice over WebSocket.

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/PlaygrndLabs/sub2api/tree/main/worker"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" width="170"></a>

See [worker/README.md](worker/README.md) for setup.

### Limits

If you need anything marked **No**, use the Container install.

| Feature | Container | Workers&#8209;only |
|---|---|---|
| ChatGPT (Codex) login: text and code | Yes | **No**: chatgpt.com blocks Workers with HTTP 403 (use a Codex API key) |
| ChatGPT login: voice | WebSocket and WebRTC | WebSocket only (WebRTC gets the same 403) |
| ChatGPT login: quota in the dashboard | Yes | **No** |
| Claude login | Any app | Claude Code only (Anthropic answers other apps with HTTP 429; use a Claude API key) |
| Logins | Every CPA provider | Claude, ChatGPT, Kimi, and Vertex service accounts |
| Images, video, speech (`/v1/images`, `/v1/videos`, `/v1/audio/speech`) | Yes | **No** |
| Responses WebSocket, `/v1/responses/compact`, legacy `/v1/completions` | Yes | **No** |
| Realtime client secrets, sideband, SIP, translations | Yes | **No** |
| Request logs | Full detail | Last 2,000 lines, no request detail |
| Gemini safety filters | Off, as in CPA | Google's defaults |

[Workers Free caps](https://developers.cloudflare.com/workers/platform/limits/) apply; past a daily cap, calls fail until 00:00 UTC:

- **100,000 requests a day** for the Worker and for its Durable Object.
- **10 ms of CPU per request.** Very long conversations translated between formats can fail.
- **50 outgoing requests per request**, so a call tries at most 10 logins or keys.
- **5 GB of storage.**

Moving to Workers Paid? `sh scripts/move-to-container.sh` (or the **move to container** workflow) copies logins, keys and config to the Container install's R2 bucket. Add `--replace` to swap the Worker too.

## Good to know

- Requests reach providers from Cloudflare's network. **Check that your provider's terms allow your use.**
- The first request after the container sleeps takes a few seconds.
- A second install needs its own Worker name and R2 bucket. Installs that share a bucket share logins, keys and config.
- Cost: the $5 Workers Paid plan plus [container time](https://developers.cloudflare.com/containers/pricing/) while awake.

Built on [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). Not affiliated with Anthropic, OpenAI, Google or Cloudflare.

## License

[MIT](LICENSE)
