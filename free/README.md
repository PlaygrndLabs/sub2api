# sub2api for the Workers Free plan (spike)

A container-free version of sub2api that runs on Cloudflare's **free** Workers plan. It is a small TypeScript gateway, not CPA, and for now it covers **Claude subscriptions only**:

- Claude OAuth login (the same PKCE flow as CPA and Claude Code), with the token refreshed automatically.
- `POST /v1/messages`, `POST /v1/messages/count_tokens` and `GET /v1/models`, streamed straight through to Anthropic.
- API keys and the Claude login live in one SQLite-backed Durable Object, which the free plan includes.
- A password-protected dashboard at `/` for connecting the account and managing keys.

Request bodies are never parsed, so a Worker spends well under 1 ms of its 10 ms CPU budget even on a 600 KB Claude Code request (see the CPU test in `test/app.test.ts`).

Not included: OpenAI/Gemini formats, Codex and Gemini accounts, multiple accounts, and CPA's request rewriting. Clients other than Claude Code may be refused by Anthropic when they use a subscription token.

## Try it

You need a Cloudflare account. The free plan is enough.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PlaygrndLabs/sub2api/tree/main/free)

It asks for `DASHBOARD_PASSWORD` (at least 16 characters). Or from a clone:

```bash
cd free && npm ci
npx wrangler login
npx wrangler deploy
npx wrangler secret put DASHBOARD_PASSWORD   # at least 16 characters
```

1. Open `https://sub2api-free.<your-subdomain>.workers.dev` and sign in.
2. Press **Connect Claude**, approve on Claude's page, then paste the `localhost` address you land on.
3. Create an API key, then point Claude Code at the gateway:

```bash
export ANTHROPIC_BASE_URL=https://sub2api-free.<your-subdomain>.workers.dev
export ANTHROPIC_API_KEY=<your gateway API key>
claude
```

## Deploying from GitHub

With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set as repository secrets (the same ones the main deploy uses), `.github/workflows/deploy-free.yml` deploys this Worker whenever `free/` changes on `main`. Add a gateway API key as the `SUB2API_FREE_TEST_KEY` secret and each deploy also runs Claude Code through the gateway: one short prompt and one long streamed answer.

## Checked live

On 2026-10-27, against a deployed gateway: the Claude login connected from the Worker, `GET /v1/models` answered 200, and Claude Code (`claude -p`) answered both a short prompt and a long streamed one through the gateway.
