import type { UpstreamCredential } from "./providers.ts";
import type { Sql } from "./vault.ts";

// Request counts per credential and request log lines, which CPA keeps in memory and in its log
// file and shows on the dashboard's Usage and Logs pages. Here they live in the Durable Object.

// CPA's recent-request window: twenty 10-minute buckets.
export const BUCKET_SECONDS = 10 * 60;
export const BUCKET_COUNT = 20;
const KEPT_LINES = 2000;

export interface Attempt {
  // A login file ("file:<name>") or an API key ("<provider>\n<base url>|<key>").
  readonly key: string;
  readonly ok: boolean;
}

export interface UsageRecord {
  readonly at: number;
  readonly line: string;
  readonly attempts: readonly Attempt[];
}

export interface RecentBucket {
  readonly time: string;
  readonly success: number;
  readonly failed: number;
}

export interface UsageStats {
  readonly success: number;
  readonly failed: number;
  readonly recent_requests: RecentBucket[];
}

export function loginKey(name: string): string {
  return `file:${name}`;
}

// CPA groups API keys by provider, naming OpenAI-compatible ones by their entry's name.
export function apiKeyProvider(credential: UpstreamCredential): string {
  return credential.kind === "openai-compatibility" ? credential.group.toLowerCase() || "openai-compatibility" : credential.kind;
}

export function apiKeyKey(credential: UpstreamCredential): string {
  return `${apiKeyProvider(credential)}\n${credential.baseUrl}|${credential.apiKey}`;
}

// API keys are stored only as a hash, so a key removed from the config doesn't linger here.
export async function storedKey(key: string): Promise<string> {
  if (key.startsWith("file:")) return key;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return `key:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function clock(date: Date): string {
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

// Go's duration format, as CPA's request lines print latency.
function latency(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Number(seconds.toFixed(3))}s`;
  return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)}s`;
}

export interface RequestLine {
  readonly at: number;
  readonly requestId: string;
  readonly status: number;
  readonly ms: number;
  readonly ip: string;
  readonly method: string;
  readonly path: string;
  readonly provider: string;
  readonly model: string;
}

// CPA's line for a served request: "[time] [request id] [level] status | latency | ip | method path".
export function requestLine(request: RequestLine): string {
  const date = new Date(request.at);
  const time = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  const level = request.status >= 500 ? "error" : request.status >= 400 ? "warn " : "info ";
  const fields = [request.provider === "" ? "" : ` provider=${request.provider}`, request.model === "" ? "" : ` model=${JSON.stringify(request.model)}`].join("");
  return `[${time}] [${request.requestId}] [${level}] ${request.status} | ${latency(request.ms).padStart(13)} | ${request.ip.padStart(15)} | ${request.method.padEnd(7)} ${JSON.stringify(request.path)}${fields}`;
}

export class UsageStore {
  constructor(private readonly sql: Sql) {
    sql.exec("CREATE TABLE IF NOT EXISTS usage_totals (key TEXT PRIMARY KEY, success INTEGER NOT NULL, failed INTEGER NOT NULL)");
    sql.exec(`CREATE TABLE IF NOT EXISTS usage_buckets (key TEXT NOT NULL, bucket INTEGER NOT NULL, success INTEGER NOT NULL, failed INTEGER NOT NULL,
      PRIMARY KEY (key, bucket))`);
    sql.exec("CREATE TABLE IF NOT EXISTS request_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, line TEXT NOT NULL)");
  }

  record(records: readonly UsageRecord[], keepLines: boolean, nowSeconds: number): void {
    for (const record of records) {
      for (const attempt of record.attempts) {
        const success = attempt.ok ? 1 : 0;
        const failed = attempt.ok ? 0 : 1;
        this.sql.exec(
          "INSERT INTO usage_totals (key, success, failed) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET success = success + excluded.success, failed = failed + excluded.failed",
          attempt.key,
          success,
          failed,
        );
        this.sql.exec(
          "INSERT INTO usage_buckets (key, bucket, success, failed) VALUES (?, ?, ?, ?) ON CONFLICT (key, bucket) DO UPDATE SET success = success + excluded.success, failed = failed + excluded.failed",
          attempt.key,
          Math.floor(record.at / 1000 / BUCKET_SECONDS),
          success,
          failed,
        );
      }
      if (keepLines) this.sql.exec("INSERT INTO request_log (at, line) VALUES (?, ?)", Math.floor(record.at / 1000), record.line);
    }
    this.sql.exec("DELETE FROM usage_buckets WHERE bucket <= ?", Math.floor(nowSeconds / BUCKET_SECONDS) - BUCKET_COUNT);
    if (keepLines) this.sql.exec("DELETE FROM request_log WHERE id <= (SELECT MAX(id) FROM request_log) - ?", KEPT_LINES);
  }

  stats(key: string, nowSeconds: number): UsageStats {
    const total = this.sql.exec("SELECT success, failed FROM usage_totals WHERE key = ?", key).toArray()[0];
    const current = Math.floor(nowSeconds / BUCKET_SECONDS);
    const counts = new Map(this.sql.exec("SELECT bucket, success, failed FROM usage_buckets WHERE key = ? AND bucket > ?", key, current - BUCKET_COUNT).toArray().map((row) => [Number(row.bucket), row]));
    const recent: RecentBucket[] = [];
    for (let bucket = current - BUCKET_COUNT + 1; bucket <= current; bucket += 1) {
      const row = counts.get(bucket);
      recent.push({
        time: `${clock(new Date(bucket * BUCKET_SECONDS * 1000))}-${clock(new Date((bucket + 1) * BUCKET_SECONDS * 1000))}`,
        success: row === undefined ? 0 : Number(row.success),
        failed: row === undefined ? 0 : Number(row.failed),
      });
    }
    return { success: total === undefined ? 0 : Number(total.success), failed: total === undefined ? 0 : Number(total.failed), recent_requests: recent };
  }

  // Log lines after a cursor (a line id) or a time, oldest first, keeping the newest `limit`.
  lines(options: { cursor: string; after: number; limit: number }): { lines: string[]; latest: number; nextCursor: string; reset: boolean } {
    const oldest = Number(this.sql.exec("SELECT MIN(id) AS id FROM request_log").toArray()[0]?.id ?? 0);
    let reset = false;
    let after = 0;
    if (options.cursor !== "") {
      after = /^\d+$/.test(options.cursor) ? Number(options.cursor) : -1;
      // An unreadable cursor, or one for lines already dropped, starts again from the tail.
      if (after < 0 || (oldest > 0 && after < oldest - 1)) {
        reset = true;
        after = 0;
      }
    }
    const limit = options.limit > 0 ? options.limit : KEPT_LINES;
    const rows =
      after > 0 || options.cursor !== ""
        ? this.sql.exec("SELECT id, at, line FROM (SELECT id, at, line FROM request_log WHERE id > ? ORDER BY id DESC LIMIT ?) ORDER BY id", after, limit).toArray()
        : this.sql.exec("SELECT id, at, line FROM (SELECT id, at, line FROM request_log WHERE at > ? ORDER BY id DESC LIMIT ?) ORDER BY id", options.after, limit).toArray();
    const last = rows.at(-1);
    const newest = this.sql.exec("SELECT MAX(id) AS id, MAX(at) AS at FROM request_log").toArray()[0];
    return {
      lines: rows.map((row) => String(row.line)),
      latest: Math.max(options.after, Number(last?.at ?? newest?.at ?? 0)),
      nextCursor: String(last?.id ?? newest?.id ?? after),
      reset,
    };
  }

  clearLines(): number {
    const count = Number(this.sql.exec("SELECT COUNT(*) AS count FROM request_log").toArray()[0]?.count ?? 0);
    this.sql.exec("DELETE FROM request_log");
    return count;
  }
}
