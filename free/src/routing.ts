import { ordered, type Candidate, type RoutingTable, type Strategy } from "./providers.ts";

// CPA's request routing across credentials: the strategy that picks the next credential, the
// failover to the next one when a credential fails, retry rounds, and the cooldowns that keep a
// failing or rate-limited credential out of rotation for a while. Durations follow CPA's auth
// conductor; cooldowns are kept per isolate and shared through the Durable Object.

export interface RoutingSettings {
  readonly strategy: Strategy;
  // Extra rounds after the first has tried every eligible credential.
  readonly requestRetry: number;
  // How many credentials one round may try; 0 for all.
  readonly maxRetryCredentials: number;
  // The longest wait, in seconds, for a cooldown to end before another round; 0 never waits.
  readonly maxRetryInterval: number;
  readonly disableCooling: boolean;
  // Seconds a transient upstream error cools a credential: 0 for CPA's 60, negative for none.
  readonly transientCooldownSeconds: number;
}

// CPA's values when the config leaves a field out.
export const DEFAULT_ROUTING: RoutingSettings = {
  strategy: "round-robin",
  requestRetry: 0,
  maxRetryCredentials: 0,
  maxRetryInterval: 0,
  disableCooling: false,
  transientCooldownSeconds: 0,
};

// Upstream calls one request may make in all, well inside the 50 subrequests a Worker gets on
// the Free plan (the Durable Object and token calls count too).
export const MAX_ATTEMPTS = 10;
// Rounds wait at most this long in all, whatever max-retry-interval says.
const MAX_TOTAL_WAIT_SECONDS = 120;

// A credential (`model` "") or one of its models, kept out of rotation until `until`.
export interface Cooldown {
  readonly id: string;
  readonly model: string;
  readonly until: number;
  // CPA's reason codes: unauthorized, payment_required, not_found, quota, transient_error.
  readonly reason: string;
  readonly status: number;
  // Steps up the quota backoff (1 s, 2 s, 4 s ... 30 min) until the credential succeeds again.
  readonly level: number;
}

// What an isolate tells the Durable Object: a new cooldown, or that a credential succeeded.
export type CooldownEvent = Cooldown | { readonly id: string; readonly clear: true };

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const AUTH_COOLDOWN = 30 * MINUTE;
const NOT_FOUND_COOLDOWN = 12 * HOUR;
const TRANSIENT_COOLDOWN = MINUTE;
const QUOTA_MAX = 30 * MINUTE;
const QUOTA_FLOOR = 10;
const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 529]);
// After these, the next credential is tried in the same round.
const FAILOVER_STATUSES = new Set([401, 402, 403, 404, 429, ...TRANSIENT_STATUSES]);
// After these, a further round may start once the first has run out of credentials (as in CPA).
const ROUND_STATUSES = new Set([403, 408, 429, 500, 502, 503, 504, 529]);
// Local entries stay this long so a request soon after doesn't depend on the shared copy.
const LOCAL_SECONDS = 2 * MINUTE;
const LOCAL_LIMIT = 1000;

type Tree = Record<string, unknown>;

function isTree(value: unknown): value is Tree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function strategyOf(value: unknown): Strategy {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["weighted-round-robin", "weightedroundrobin", "wrr"].includes(name)) return "weighted-round-robin";
  if (["fill-first", "fillfirst", "ff"].includes(name)) return "fill-first";
  return "round-robin";
}

// Reads CPA's v8 `routing` section, and the old top-level spellings CPA still accepts.
export function routingSettings(config: unknown): RoutingSettings {
  const root = isTree(config) ? config : {};
  const routing = isTree(root.routing) ? root.routing : {};
  const retry = isTree(routing.retry) ? routing.retry : {};
  const cooldown = isTree(routing.cooldown) ? routing.cooldown : {};
  return {
    strategy: strategyOf(routing.strategy),
    requestRetry: Math.max(0, Math.min(10, integer(retry["request-retry"] ?? root["request-retry"], DEFAULT_ROUTING.requestRetry))),
    maxRetryCredentials: Math.max(0, integer(retry["max-retry-credentials"] ?? root["max-retry-credentials"], 0)),
    maxRetryInterval: Math.max(0, integer(retry["max-retry-interval"] ?? root["max-retry-interval"], 0)),
    disableCooling: (cooldown["disable-cooling"] ?? root["disable-cooling"]) === true,
    transientCooldownSeconds: integer(cooldown["transient-error-cooldown-seconds"] ?? root["transient-error-cooldown-seconds"], 0),
  };
}

export function cooldownKey(id: string, model: string): string {
  return `${id}\n${model}`;
}

function parseSeconds(value: string, now: number): number | null {
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.ceil(Number(text));
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, Math.ceil(date / 1000 - now)) : null;
}

// How long an upstream asked to wait, in seconds, from what CPA reads: Retry-After, Anthropic's
// unified rate-limit resets for a rejected window, Codex's usage_limit_reached reset, and
// Gemini's RetryInfo delay.
export function retryHint(headers: Headers, body: string, now: number): number | null {
  const hints: number[] = [];
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = parseSeconds(retryAfter, now);
    if (seconds !== null) hints.push(seconds);
  }
  for (const window of ["", "5h-", "7d-"]) {
    if (headers.get(`anthropic-ratelimit-unified-${window}status`)?.trim().toLowerCase() !== "rejected") continue;
    const reset = Number(headers.get(`anthropic-ratelimit-unified-${window}reset`) ?? "");
    if (Number.isFinite(reset) && reset > now) hints.push(Math.ceil(reset - now));
  }
  if (body !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    const root = Array.isArray(parsed) ? parsed[0] : parsed;
    const error = isTree(root) && isTree(root.error) ? root.error : isTree(root) ? root : {};
    if (error.type === "usage_limit_reached") {
      const resetsAt = integer(error.resets_at, 0);
      const resetsIn = integer(error.resets_in_seconds, 0);
      if (resetsAt > now) hints.push(resetsAt - now);
      else if (resetsIn > 0) hints.push(resetsIn);
    }
    const details = Array.isArray(error.details) ? error.details : [];
    for (const detail of details) {
      if (!isTree(detail) || typeof detail.retryDelay !== "string") continue;
      const delay = /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay.trim());
      if (delay !== null) hints.push(Math.ceil(Number(delay[1])));
    }
  }
  return hints.length === 0 ? null : Math.max(...hints);
}

export interface Failure {
  readonly status: number;
  // Seconds the upstream asked to wait, if it said.
  readonly hint: number | null;
}

interface Cooled {
  readonly kind: Candidate["credential"]["kind"];
  readonly login: boolean;
  readonly disableCooling: boolean;
}

// The cooldown CPA sets after a failure, or null when the credential stays in rotation.
// `recorded` finds the last cooldown of the credential ("") or a model, for the quota backoff.
export function cooldownAfter(id: string, model: string, cooled: Cooled, failure: Failure, recorded: (model: string) => Cooldown | null, settings: RoutingSettings, now: number): Cooldown | null {
  if (cooled.disableCooling) return null;
  const { status, hint } = failure;
  const transient = settings.transientCooldownSeconds < 0 ? 0 : settings.transientCooldownSeconds || TRANSIENT_COOLDOWN;
  const make = (scope: "credential" | "model", seconds: number, reason: string, level = 0): Cooldown | null =>
    seconds > 0 ? { id, model: scope === "credential" ? "" : model, until: now + seconds, reason, status, level } : null;
  // A login's token is refreshed after a 401, so it is only rested like a transient error.
  if (status === 401) return cooled.login ? make("credential", transient, "unauthorized") : make("credential", AUTH_COOLDOWN, "unauthorized");
  if (status === 402 || status === 403) return make("credential", AUTH_COOLDOWN, "payment_required");
  if (status === 404) return make("model", hint !== null && hint > 0 ? hint : NOT_FOUND_COOLDOWN, "not_found");
  if (status === 429) {
    // Claude and ChatGPT limits are per account; Gemini and OpenAI-compatible ones per model.
    const scope = cooled.kind === "claude" || cooled.kind === "codex" ? "credential" : "model";
    const last = recorded(scope === "credential" ? "" : model);
    const previous = last?.reason === "quota" ? last : null;
    const level = previous?.level ?? 0;
    if (hint !== null) return make(scope, Math.max(QUOTA_FLOOR, hint), "quota", level);
    // Failures while an earlier quota window is still open share it, so a burst steps once.
    if (previous !== null && previous.until > now) return make(scope, previous.until - now, "quota", level);
    const seconds = Math.min(QUOTA_MAX, 2 ** level);
    return make(scope, seconds, "quota", seconds >= QUOTA_MAX ? level : level + 1);
  }
  if (TRANSIENT_STATUSES.has(status)) return make("model", hint !== null && hint > 0 ? hint : transient, "transient_error");
  return null;
}

// This isolate's cooldowns, on top of the Durable Object's copy in the routing table.
export class CooldownBook {
  private readonly local = new Map<string, { cooldown: Cooldown; seenAt: number }>();
  // Credentials that succeeded here since the table was read, whose shared entries are stale.
  private cleared = new Set<string>();
  private clearedFor: RoutingTable | null = null;

  private shared(table: RoutingTable, id: string): readonly Cooldown[] {
    if (this.clearedFor !== table) {
      this.clearedFor = table;
      this.cleared = new Set();
    }
    return this.cleared.has(id) ? [] : (table.cooldowns ?? []).filter((cooldown) => cooldown.id === id);
  }

  // The latest cooldown recorded for a credential ("") or one of its models, active or not.
  find(table: RoutingTable, id: string, model: string): Cooldown | null {
    const shared = this.shared(table, id).find((cooldown) => cooldown.model === model) ?? null;
    const local = this.local.get(cooldownKey(id, model))?.cooldown ?? null;
    if (shared === null || local === null) return local ?? shared;
    return local.until >= shared.until ? local : shared;
  }

  // When the candidate is free again; at or before `now` means it is free.
  freeAt(table: RoutingTable, candidate: Candidate, now: number): number {
    const id = candidate.credential.id;
    return Math.max(this.find(table, id, "")?.until ?? 0, this.find(table, id, candidate.model)?.until ?? 0, now);
  }

  note(cooldown: Cooldown, now: number): void {
    this.prune(now);
    if (this.local.size >= LOCAL_LIMIT) this.local.clear();
    this.local.set(cooldownKey(cooldown.id, cooldown.model), { cooldown, seenAt: now });
  }

  // A success ends the credential's backoff. Reports whether anything was recorded for it, so the
  // Durable Object is told once.
  succeed(table: RoutingTable, id: string): boolean {
    let found = this.shared(table, id).length > 0;
    this.cleared.add(id);
    for (const key of this.local.keys()) {
      if (!key.startsWith(`${id}\n`)) continue;
      this.local.delete(key);
      found = true;
    }
    return found;
  }

  clear(): void {
    this.local.clear();
    this.cleared = new Set();
    this.clearedFor = null;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.local) if (entry.cooldown.until <= now && entry.seenAt + LOCAL_SECONDS <= now) this.local.delete(key);
  }
}

export interface Attempted {
  readonly response: Response;
  // Seconds the upstream asked to wait, read from the upstream's own answer.
  readonly hint: number | null;
}

export interface RouteOptions {
  readonly table: RoutingTable;
  readonly usable: readonly Candidate[];
  readonly turn: number;
  readonly book: CooldownBook;
  readonly nowSeconds: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly isLogin: (candidate: Candidate) => boolean;
  readonly attempt: (candidate: Candidate) => Promise<Attempted>;
  readonly report: (event: CooldownEvent) => void;
  // The answer when every credential is cooling down, given the seconds until one is free.
  readonly cooling: (seconds: number) => Response;
}

// A failed answer kept whole, so the client gets the last upstream error if nothing succeeds.
async function kept(response: Response): Promise<Response> {
  const body = await response.arrayBuffer().catch(() => new ArrayBuffer(0));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

// Tries the candidates as CPA does: in strategy order within each round, skipping cooling ones,
// moving on after a credential failure, and starting another round while request-retry allows.
export async function route(options: RouteOptions): Promise<Response> {
  const { table, book } = options;
  const settings = table.settings ?? DEFAULT_ROUTING;
  const sorted = [...options.usable].sort((a, b) => b.credential.priority - a.credential.priority);
  const retries = (candidate: Candidate) => candidate.credential.requestRetry ?? settings.requestRetry;
  const rounds = Math.max(0, ...sorted.map(retries));
  let budget = MAX_ATTEMPTS;
  let waited = 0;
  let last: Response | null = null;
  for (let round = 0; round <= rounds && budget > 0; round += 1) {
    const admitted = round === 0 ? sorted : sorted.filter((candidate) => retries(candidate) >= round);
    if (admitted.length === 0) break;
    const free = () => admitted.filter((candidate) => book.freeAt(table, candidate, options.nowSeconds()) <= options.nowSeconds());
    let open = free();
    if (open.length === 0) {
      const now = options.nowSeconds();
      const wait = Math.min(...admitted.map((candidate) => book.freeAt(table, candidate, now))) - now;
      if (settings.maxRetryInterval <= 0 || wait > settings.maxRetryInterval || waited + wait > MAX_TOTAL_WAIT_SECONDS) return last ?? options.cooling(wait);
      waited += wait;
      await options.sleep(wait * 1000);
      open = free();
      if (open.length === 0) return last ?? options.cooling(wait);
    }
    let list = ordered(open, options.turn + round, settings.strategy);
    if (list.length === 0) list = open;
    if (settings.maxRetryCredentials > 0) list = list.slice(0, settings.maxRetryCredentials);
    let status = 0;
    for (const candidate of list) {
      if (budget === 0) break;
      budget -= 1;
      const { response, hint } = await options.attempt(candidate);
      status = response.status;
      const id = candidate.credential.id;
      if (status < 400) {
        if (book.succeed(table, id)) options.report({ id, clear: true });
        return response;
      }
      if (!FAILOVER_STATUSES.has(status)) return response;
      const now = options.nowSeconds();
      const cooled = { kind: candidate.credential.kind, login: options.isLogin(candidate), disableCooling: candidate.credential.disableCooling ?? settings.disableCooling };
      const cooldown = cooldownAfter(id, candidate.model, cooled, { status, hint }, (model) => book.find(table, id, model), settings, now);
      if (cooldown !== null) {
        book.note(cooldown, now);
        options.report(cooldown);
      }
      last = await kept(response);
    }
    if (!ROUND_STATUSES.has(status)) break;
  }
  return last ?? options.cooling(0);
}
