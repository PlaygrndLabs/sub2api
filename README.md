# sub2api: a Cloudflare-based LLM gateway and proxy server

[![ci](https://github.com/PlaygrndLabs/sub2api/actions/workflows/ci.yml/badge.svg)](https://github.com/PlaygrndLabs/sub2api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Literally the [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) project, deployed as a Cloudflare Worker in one click.** Turn your Claude, ChatGPT Codex and Gemini subscriptions into your own private API. Point Claude Code, the Anthropic or OpenAI SDKs, or any app at your gateway URL and use your subscription from anywhere, with no server or home machine left running.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PlaygrndLabs/sub2api)

## Why

- **One click, no server.** Cloudflare builds and runs everything. Nothing to keep online.
- **The real CPA.** Built from a pinned upstream release with its official dashboard, so every provider and API CPA supports just works: Anthropic Messages, OpenAI-compatible and Gemini.
- **Private by default.** The dashboard sits behind a password, and every API call needs a key you create. Until then, all calls are refused.
- **Logins that stick.** Config and OAuth logins live in your own R2 bucket and survive restarts and redeploys.
- **Costs little when idle.** The container sleeps after 30 minutes and wakes on the next request.

## Quick start

You need a Cloudflare account on the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) ($5/month; Containers require it).

On the free plan? [free/](free/README.md) has an early, Claude-only version that needs no container.

1. Press **Deploy to Cloudflare** above.
2. Set the two secrets it asks for. Each needs at least 32 characters of `A-Z a-z 0-9 _ -`; `openssl rand -hex 32` makes one:
   - `DASHBOARD_PASSWORD`: your dashboard sign-in password.
   - `MANAGEMENT_KEY`: CPA's management key, asked for after sign-in.
3. Open `https://sub2api.<your-subdomain>.workers.dev`, sign in, and create an API key under **API Keys**.

## Connect a subscription

1. In the dashboard, open **OAuth login** and pick a provider (for Claude: Anthropic).
2. Sign in with the provider. You land on a `localhost` page that doesn't load; that's expected.
3. Copy that address into the dashboard's **Callback URL** field. Or replace `http://localhost:<port>` with your gateway URL and open it in the same browser.

CPA stores the login and refreshes its tokens on its own.

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

`GET /v1/models` lists what your subscriptions offer. Give each app its own key, so you can revoke one without touching the rest.

## How it works

```
app ──► Worker ──► Durable Object ──► Container: CPA ──► Claude / Codex / Gemini
                   · API key check        │
                   · dashboard sign-in    └─► http://r2.internal ──► R2 bucket
```

The Worker hands every request to one Durable Object in front of the CPA container. The Durable Object refuses API calls until a key exists and keeps the dashboard behind a password. CPA's S3 storage is served from an R2 binding, so you never create storage keys. See [SECURITY.md](SECURITY.md) for the full model.

## Update

A Deploy-button copy redeploys whenever its `main` branch changes. To get the latest release:

```bash
git pull https://github.com/PlaygrndLabs/sub2api main
git push
```

If git refuses because the histories are unrelated, add `--allow-unrelated-histories` to the pull once. Logins and config live in R2, so updates keep them.

<details>
<summary><b>Deploy with wrangler or GitHub Actions</b></summary>

```bash
npm ci
npx wrangler login
npx wrangler r2 bucket create sub2api
npx wrangler deploy        # needs Docker to build the image
sh scripts/set-secrets.sh  # generates both secrets, stores them, prints them once
```

To deploy from GitHub Actions, add the repository secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts, Containers, Workers R2 Storage: Edit) and `CLOUDFLARE_ACCOUNT_ID`. Every green `ci` run on `main` then deploys.

`MANAGEMENT_KEY` seeds CPA's config on first start only; after that, change it in the dashboard. `DASHBOARD_PASSWORD` can be changed any time with `wrangler secret put DASHBOARD_PASSWORD`.
</details>

<details>
<summary><b>Develop</b></summary>

```bash
npm ci
npm run verify              # typecheck, lint, unit tests
sh test/container-smoke.sh  # needs Docker: runs CPA against the R2 shim
```

To upgrade CPA, change `CPA_COMMIT` in `container/Dockerfile` together with a matching dashboard release (`PANEL_VERSION`, `PANEL_SHA256`).
</details>

## Good to know

- Requests reach providers from Cloudflare's network. **Check that your provider's terms allow how you use your subscription.**
- The first request after the container sleeps takes a few seconds while it starts.
- Cost is the $5 Workers Paid plan plus container time while awake. See [Containers pricing](https://developers.cloudflare.com/containers/pricing/).
- Lost the management key? Set a new `MANAGEMENT_KEY` secret, delete `config/config.yaml` from the `sub2api` R2 bucket, and redeploy. CPA starts with a fresh config. Provider logins stay, but you recreate your app API keys.

Built on [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). Not affiliated with Anthropic, OpenAI, Google or Cloudflare.

## License

[MIT](LICENSE)
