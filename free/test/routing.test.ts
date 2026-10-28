import { describe, expect, it } from "vitest";
import { cooldownAfter, DEFAULT_ROUTING, retryHint, routingSettings, type Cooldown } from "../src/routing.ts";

const NOW = 1_800_000_000;
const key = { kind: "openai-compatibility", login: false, disableCooling: false } as const;
const claudeKey = { kind: "claude", login: false, disableCooling: false } as const;
const none = () => null;

function after(status: number, cooled: Parameters<typeof cooldownAfter>[2] = key, hint: number | null = null, previous: Cooldown | null = null, settings = DEFAULT_ROUTING) {
  return cooldownAfter("k", "m", cooled, { status, hint }, () => previous, settings, NOW);
}

describe("routing settings", () => {
  it("reads CPA's v8 routing section and the old top-level spellings, with CPA's defaults", () => {
    expect(routingSettings({})).toEqual(DEFAULT_ROUTING);
    expect(routingSettings({ routing: { strategy: "WRR", retry: { "request-retry": 3, "max-retry-credentials": 2, "max-retry-interval": 30 }, cooldown: { "disable-cooling": true, "transient-error-cooldown-seconds": 5 } } })).toEqual({
      strategy: "weighted-round-robin",
      requestRetry: 3,
      maxRetryCredentials: 2,
      maxRetryInterval: 30,
      disableCooling: true,
      transientCooldownSeconds: 5,
    });
    expect(routingSettings({ "request-retry": 2, routing: { strategy: "ff" } })).toMatchObject({ strategy: "fill-first", requestRetry: 2 });
    expect(routingSettings({ routing: { strategy: "nonsense", retry: { "request-retry": 99 } } })).toMatchObject({ strategy: "round-robin", requestRetry: 10 });
  });
});

describe("cooldowns", () => {
  it("follows CPA's durations for each failure", () => {
    expect(after(401)).toMatchObject({ model: "", until: NOW + 1800, reason: "unauthorized" });
    expect(after(401, { ...claudeKey, login: true })).toMatchObject({ model: "", until: NOW + 60 });
    expect(after(402)).toMatchObject({ model: "", until: NOW + 1800, reason: "payment_required" });
    expect(after(403)).toMatchObject({ model: "", until: NOW + 1800, reason: "payment_required" });
    expect(after(404)).toMatchObject({ model: "m", until: NOW + 12 * 3600, reason: "not_found" });
    expect(after(503)).toMatchObject({ model: "m", until: NOW + 60, reason: "transient_error" });
    expect(after(503, key, null, null, { ...DEFAULT_ROUTING, transientCooldownSeconds: 5 })).toMatchObject({ until: NOW + 5 });
    expect(after(503, key, null, null, { ...DEFAULT_ROUTING, transientCooldownSeconds: -1 })).toBeNull();
    expect(after(400)).toBeNull();
    expect(after(429, { ...key, disableCooling: true })).toBeNull();
  });

  it("backs off on repeated quota errors, sharing an open window, and honours a stated wait", () => {
    const first = after(429, claudeKey);
    expect(first).toMatchObject({ model: "", until: NOW + 1, reason: "quota", level: 1 });
    const later = { ...(first as Cooldown), until: NOW - 1 };
    expect(after(429, claudeKey, null, later)).toMatchObject({ until: NOW + 2, level: 2 });
    expect(after(429, claudeKey, null, { ...later, until: NOW + 50 })).toMatchObject({ until: NOW + 50, level: 1 });
    expect(after(429, claudeKey, null, { ...later, level: 20 })).toMatchObject({ until: NOW + 1800, level: 20 });
    expect(after(429, claudeKey, 3)).toMatchObject({ until: NOW + 10 });
    expect(after(429, claudeKey, 600)).toMatchObject({ until: NOW + 600 });
    // Gemini and OpenAI-compatible limits are per model.
    expect(after(429, key)).toMatchObject({ model: "m" });
    expect(cooldownAfter("k", "m", claudeKey, { status: 429, hint: null }, none, DEFAULT_ROUTING, NOW)).toMatchObject({ level: 1 });
  });
});

describe("wait hints", () => {
  it("reads Retry-After in seconds or as a date", () => {
    expect(retryHint(new Headers({ "retry-after": "17" }), "", NOW)).toBe(17);
    expect(retryHint(new Headers({ "retry-after": new Date((NOW + 40) * 1000).toUTCString() }), "", NOW)).toBe(40);
    expect(retryHint(new Headers(), "", NOW)).toBeNull();
  });

  it("reads Anthropic's rejected windows, Codex's usage limit and Gemini's retry delay", () => {
    const anthropic = new Headers({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(NOW + 3600), "anthropic-ratelimit-unified-7d-reset": String(NOW + 99_999) });
    expect(retryHint(anthropic, "", NOW)).toBe(3600);
    expect(retryHint(new Headers(), JSON.stringify({ error: { type: "usage_limit_reached", resets_at: NOW + 500 } }), NOW)).toBe(500);
    expect(retryHint(new Headers(), JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 70 } }), NOW)).toBe(70);
    expect(retryHint(new Headers(), JSON.stringify([{ error: { code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12.5s" }] } }]), NOW)).toBe(13);
    expect(retryHint(new Headers(), "not json", NOW)).toBeNull();
  });
});
