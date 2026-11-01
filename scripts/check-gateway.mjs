// Checks a deployed gateway end to end: model list, a GPT text answer, a Claude answer, and a
// Realtime voice session. Prints status codes and model names only, never keys or answers.
//   SUB2API_URL=https://sub2api.<subdomain>.workers.dev SUB2API_KEY=<gateway API key> node scripts/check-gateway.mjs
const base = (process.env.SUB2API_URL ?? "").replace(/\/+$/, "");
const key = process.env.SUB2API_KEY ?? "";
if (base === "" || key === "") {
  console.error("Set SUB2API_URL and SUB2API_KEY.");
  process.exit(64);
}
const auth = { authorization: `Bearer ${key}` };
const results = [];

async function check(name, run) {
  try {
    const detail = await run();
    results.push(true);
    console.log(`ok   ${name}${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : "failed"}`);
  }
}

async function post(path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`HTTP ${response.status}${typeof json?.error?.type === "string" ? ` ${json.error.type}` : ""}`);
  return json;
}

// The container may be asleep, so the first call waits for it to start.
let models = [];
await check("GET /v1/models", async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(`${base}/v1/models`, { headers: auth, signal: AbortSignal.timeout(60_000) });
    if (response.status === 503) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    models = ((await response.json()).data ?? []).map((model) => String(model.id));
    return `${models.length} models`;
  }
  throw new Error("still starting after 2 minutes");
});

const gpt = models.find((id) => /^gpt-5/.test(id) && !/codex|image|realtime|mini|nano/.test(id)) ?? models.find((id) => /^gpt-/.test(id));
const claude = models.find((id) => /^claude-sonnet/.test(id)) ?? models.find((id) => /^claude-/.test(id));

await check(`GPT text (${gpt ?? "no gpt model listed"})`, async () => {
  if (gpt === undefined) throw new Error("no gpt model listed");
  const json = await post("/v1/responses", { model: gpt, input: "Reply with the word hi." });
  const text = (json?.output ?? []).flatMap((item) => item.content ?? []).some((part) => typeof part.text === "string" && part.text.length > 0);
  if (!text) throw new Error("no text in the answer");
});

await check(`Claude (${claude ?? "no claude model listed"})`, async () => {
  if (claude === undefined) throw new Error("no claude model listed");
  const json = await post("/v1/messages", { model: claude, max_tokens: 32, messages: [{ role: "user", content: "Reply with the word hi." }] }, { "anthropic-version": "2023-06-01" });
  if (!(json?.content ?? []).some((part) => part.type === "text")) throw new Error("no text in the answer");
});

await check("Realtime voice (/v1/realtime WebSocket)", () =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace(/^http/, "ws")}/v1/realtime?model=gpt-realtime`, { headers: auth });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("no session.created within 30 s"));
    }, 30_000);
    socket.addEventListener("message", (event) => {
      let type;
      try {
        type = JSON.parse(String(event.data)).type;
      } catch {
        return;
      }
      if (type === "session.created") {
        clearTimeout(timer);
        socket.close();
        resolve("session.created");
      } else if (type === "error") {
        clearTimeout(timer);
        socket.close();
        reject(new Error("upstream sent an error event"));
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket did not open"));
    });
  }),
);

process.exit(results.every(Boolean) ? 0 : 1);
