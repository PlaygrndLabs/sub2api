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

```bash
npm ci
npx wrangler login
npx wrangler deploy -c free/wrangler.jsonc
npx wrangler secret put DASHBOARD_PASSWORD -c free/wrangler.jsonc   # at least 16 characters
```

1. Open `https://sub2api-free.<your-subdomain>.workers.dev` and sign in.
2. Press **Connect Claude**, approve on Claude's page, then paste the `localhost` address you land on.
3. Create an API key, then point Claude Code at the gateway:

```bash
export ANTHROPIC_BASE_URL=https://sub2api-free.<your-subdomain>.workers.dev
export ANTHROPIC_API_KEY=<your gateway API key>
claude
```

## What the spike should confirm

- Connecting the account works: Anthropic's token endpoint accepts the code exchange from a Worker.
- Claude Code works through the gateway, including long streamed answers.
- CPU time stays under 10 ms: check **Workers & Pages → sub2api-free → Metrics → CPU time**.
- The token refresh after about 8 hours works on its own.
