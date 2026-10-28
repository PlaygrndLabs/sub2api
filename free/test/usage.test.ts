import { describe, expect, it } from "vitest";
import { Account } from "../src/account.ts";
import { handleManagement, MANAGEMENT_PREFIX } from "../src/management.ts";
import { BUCKET_SECONDS, requestLine, UsageStore } from "../src/usage.ts";
import { Vault, claudeFileData } from "../src/vault.ts";
import { memorySql } from "./sqlite.ts";

const NOW = 1_800_000_000;
const ORIGIN = "https://gateway.example";
const LINE = { requestId: "a1b2c3d4", ms: 1234, ip: "1.2.3.4", method: "POST", path: "/v1/messages", provider: "claude", model: "claude-sonnet-5-5" };

describe("request lines", () => {
  it("print as CPA's request log lines", () => {
    expect(requestLine({ ...LINE, at: NOW * 1000, status: 200 })).toBe('[2027-01-15 08:00:00] [a1b2c3d4] [info ] 200 |        1.234s |         1.2.3.4 | POST    "/v1/messages" provider=claude model="claude-sonnet-5-5"');
    expect(requestLine({ ...LINE, at: NOW * 1000, status: 429, ms: 87, provider: "", model: "" })).toBe('[2027-01-15 08:00:00] [a1b2c3d4] [warn ] 429 |          87ms |         1.2.3.4 | POST    "/v1/messages"');
    expect(requestLine({ ...LINE, at: NOW * 1000, status: 502 })).toContain("[error] 502");
  });
});

describe("usage store", () => {
  it("counts attempts per credential in totals and 10-minute buckets", () => {
    const store = new UsageStore(memorySql());
    const at = NOW * 1000;
    store.record(
      [
        { at, line: "a", attempts: [{ key: "file:x.json", ok: false }, { key: "file:y.json", ok: true }] },
        { at: at - BUCKET_SECONDS * 1000, line: "b", attempts: [{ key: "file:x.json", ok: true }] },
        { at: at - 30 * BUCKET_SECONDS * 1000, line: "c", attempts: [{ key: "file:x.json", ok: true }] },
      ],
      false,
      NOW,
    );
    const stats = store.stats("file:x.json", NOW);
    expect(stats.success).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.recent_requests).toHaveLength(20);
    expect(stats.recent_requests.at(-1)).toEqual({ time: "08:00-08:10", success: 0, failed: 1 });
    expect(stats.recent_requests.at(-2)).toEqual({ time: "07:50-08:00", success: 1, failed: 0 });
    expect(store.stats("file:none.json", NOW)).toMatchObject({ success: 0, failed: 0 });
    // Lines are kept only while logging is on.
    expect(store.lines({ cursor: "", after: 0, limit: 0 }).lines).toEqual([]);
  });

  it("reads lines as a tail, after a time, or after a cursor, and resets a stale cursor", () => {
    const store = new UsageStore(memorySql());
    const lines = Array.from({ length: 5 }, (_, index) => ({ at: (NOW + index) * 1000, line: `line ${index}`, attempts: [] }));
    store.record(lines, true, NOW);
    const tail = store.lines({ cursor: "", after: 0, limit: 2 });
    expect(tail).toEqual({ lines: ["line 3", "line 4"], latest: NOW + 4, nextCursor: "5", reset: false });
    expect(store.lines({ cursor: "", after: NOW + 2, limit: 0 }).lines).toEqual(["line 3", "line 4"]);
    store.record([{ at: (NOW + 9) * 1000, line: "line 9", attempts: [] }], true, NOW);
    expect(store.lines({ cursor: tail.nextCursor, after: 0, limit: 0 })).toEqual({ lines: ["line 9"], latest: NOW + 9, nextCursor: "6", reset: false });
    expect(store.lines({ cursor: "6", after: 0, limit: 0 })).toMatchObject({ lines: [], nextCursor: "6" });
    expect(store.clearLines()).toBe(6);
    expect(store.lines({ cursor: "bogus", after: 0, limit: 0 })).toMatchObject({ lines: [], reset: true });
  });
});

describe("usage on the dashboard", () => {
  function setup() {
    const sql = memorySql();
    const vault = new Vault(sql);
    const account = new Account(vault, async () => new Response("unexpected", { status: 500 }), () => NOW);
    const call = (method: string, path: string, body?: string) => handleManagement(new Request(`${ORIGIN}${MANAGEMENT_PREFIX}/${path}`, { method, ...(body === undefined ? {} : { body }) }), account);
    return { sql, vault, account, call };
  }

  it("shows each login's counts and each configured key's usage", async () => {
    const { sql, vault, account, call } = setup();
    vault.saveCredentialFile("claude-a.json", "claude", claudeFileData({ accessToken: "at", refreshToken: "rt", expiresAt: NOW + 3600, email: "a@example.com" }), NOW);
    await call("PATCH", "config", JSON.stringify({ "api-keys": { gemini: [{ name: "g", keys: [{ "api-key": "AIza-1" }] }] } }));
    await account.record([{ at: NOW * 1000, line: "x", attempts: [{ key: "file:claude-a.json", ok: true }, { key: "gemini\nhttps://generativelanguage.googleapis.com|AIza-1", ok: false }] }]);
    const files = (await (await call("GET", "credentials")).json()) as { files: { success: number; failed: number; recent_requests: unknown[] }[] };
    expect(files.files[0]).toMatchObject({ success: 1, failed: 0 });
    expect(files.files[0]?.recent_requests).toHaveLength(20);
    const usage = (await (await call("GET", "observability/usage/api-keys")).json()) as Record<string, Record<string, { success: number; failed: number }>>;
    expect(usage.gemini?.["https://generativelanguage.googleapis.com|AIza-1"]).toMatchObject({ success: 0, failed: 1 });
    // The key itself is stored only as a hash.
    expect(JSON.stringify(sql.exec("SELECT key FROM usage_totals").toArray())).not.toContain("AIza-1");
  });

  it("serves the request log only while logging to file is on", async () => {
    const { account, call } = setup();
    await account.record([{ at: NOW * 1000, line: "dropped", attempts: [] }]);
    expect((await call("GET", "observability/logs")).status).toBe(400);
    await call("PATCH", "config", JSON.stringify({ observability: { logs: { "logging-to-file": true } } }));
    await account.record([{ at: NOW * 1000, line: "kept", attempts: [] }]);
    expect(await (await call("GET", "observability/logs?limit=10")).json()).toEqual({ lines: ["kept"], "line-count": 1, "latest-timestamp": NOW, "next-cursor": "1" });
    expect((await call("GET", "observability/logs?limit=0")).status).toBe(400);
    expect(await (await call("DELETE", "observability/logs")).json()).toMatchObject({ success: true });
    expect(await (await call("GET", "observability/logs")).json()).toMatchObject({ lines: [] });
  });
});
