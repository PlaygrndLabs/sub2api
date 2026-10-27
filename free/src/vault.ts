import type { Credential } from "./claude-oauth.ts";
import { DEFAULT_CONFIG } from "./config.ts";

// The slice of Durable Object SQLite storage this file uses, so tests can back it with node:sqlite.
export interface Sql {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] };
}

// One login or key for an upstream provider, stored as the JSON a CPA auth file holds, so files
// move between the paid and free installs unchanged.
export interface CredentialFile {
  readonly name: string;
  readonly provider: string;
  readonly data: Record<string, unknown>;
  readonly disabled: boolean;
  readonly statusMessage: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// A provider sign-in started from the dashboard, kept until its callback arrives.
export interface LoginSession {
  readonly state: string;
  readonly provider: string;
  readonly verifier: string;
  readonly createdAt: number;
  readonly status: "wait" | "ok" | "error";
  readonly error: string;
}

export interface KeyRow {
  readonly id: number;
  readonly name: string;
  readonly hint: string;
  readonly createdAt: number;
}

const SESSION_SECONDS = 15 * 60;
const ATTEMPT_WINDOW = 60;
const ATTEMPT_LIMIT = 5;

export class Vault {
  constructor(private readonly sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS credential (
      id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL, email TEXT NOT NULL)`);
    sql.exec("DROP TABLE IF EXISTS pending_login");
    sql.exec("CREATE TABLE IF NOT EXISTS login_attempts (client TEXT NOT NULL, at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK (id = 1), yaml TEXT NOT NULL)");
    sql.exec(`CREATE TABLE IF NOT EXISTS credentials (
      name TEXT PRIMARY KEY, provider TEXT NOT NULL, data TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
      status_message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS oauth_sessions (
      state TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'wait', error TEXT NOT NULL DEFAULT '')`);
    this.migrateSingleLogin();
  }

  // The first free release kept one Claude login in its own table; it becomes a credential file.
  private migrateSingleLogin(): void {
    const old = this.credential();
    if (old === null) return;
    const name = `claude-${old.email || "account"}.json`;
    if (this.credentialFile(name) === null) {
      this.saveCredentialFile(name, "claude", claudeFileData(old), old.expiresAt);
    }
    this.sql.exec("DELETE FROM credential");
  }

  configText(): string {
    const row = this.sql.exec("SELECT yaml FROM config WHERE id = 1").toArray()[0];
    return row === undefined ? DEFAULT_CONFIG : String(row.yaml);
  }

  saveConfigText(text: string): void {
    this.sql.exec("INSERT INTO config (id, yaml) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET yaml = excluded.yaml", text);
  }

  credentialFiles(): CredentialFile[] {
    return this.sql
      .exec("SELECT name, provider, data, disabled, status_message, created_at, updated_at FROM credentials ORDER BY lower(name)")
      .toArray()
      .map(toCredentialFile);
  }

  credentialFile(name: string): CredentialFile | null {
    const row = this.sql.exec("SELECT name, provider, data, disabled, status_message, created_at, updated_at FROM credentials WHERE name = ?", name).toArray()[0];
    return row === undefined ? null : toCredentialFile(row);
  }

  saveCredentialFile(name: string, provider: string, data: Record<string, unknown>, nowSeconds: number): void {
    this.sql.exec(
      `INSERT INTO credentials (name, provider, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET provider = excluded.provider, data = excluded.data, updated_at = excluded.updated_at`,
      name,
      provider,
      JSON.stringify(data),
      nowSeconds,
      nowSeconds,
    );
  }

  setCredentialStatus(name: string, disabled: boolean, statusMessage: string, nowSeconds: number): boolean {
    const found = this.credentialFile(name) !== null;
    this.sql.exec("UPDATE credentials SET disabled = ?, status_message = ?, updated_at = ? WHERE name = ?", disabled ? 1 : 0, statusMessage, nowSeconds, name);
    return found;
  }

  removeCredentialFile(name: string): boolean {
    const found = this.credentialFile(name) !== null;
    this.sql.exec("DELETE FROM credentials WHERE name = ?", name);
    return found;
  }

  keyExists(hash: string): boolean {
    return this.sql.exec("SELECT 1 FROM api_keys WHERE hash = ?", hash).toArray().length > 0;
  }

  keys(): KeyRow[] {
    return this.sql
      .exec("SELECT id, name, hint, created_at FROM api_keys ORDER BY id")
      .toArray()
      .map((row) => ({ id: Number(row.id), name: String(row.name), hint: String(row.hint), createdAt: Number(row.created_at) }));
  }

  addKey(name: string, hash: string, hint: string, nowSeconds: number): void {
    this.sql.exec("INSERT INTO api_keys (name, hash, hint, created_at) VALUES (?, ?, ?, ?)", name, hash, hint, nowSeconds);
  }

  removeKey(id: number): void {
    this.sql.exec("DELETE FROM api_keys WHERE id = ?", id);
  }

  credential(): Credential | null {
    const row = this.sql.exec("SELECT access_token, refresh_token, expires_at, email FROM credential WHERE id = 1").toArray()[0];
    if (row === undefined) return null;
    return { accessToken: String(row.access_token), refreshToken: String(row.refresh_token), expiresAt: Number(row.expires_at), email: String(row.email) };
  }

  saveCredential(credential: Credential | null): void {
    if (credential === null) {
      this.sql.exec("DELETE FROM credential");
      return;
    }
    this.sql.exec(
      `INSERT INTO credential (id, access_token, refresh_token, expires_at, email) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, email = excluded.email`,
      credential.accessToken,
      credential.refreshToken,
      credential.expiresAt,
      credential.email,
    );
  }

  saveSession(session: LoginSession, nowSeconds: number): void {
    this.sql.exec("DELETE FROM oauth_sessions WHERE created_at < ?", nowSeconds - SESSION_SECONDS);
    this.sql.exec(
      `INSERT INTO oauth_sessions (state, provider, verifier, created_at, status, error) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (state) DO UPDATE SET status = excluded.status, error = excluded.error`,
      session.state,
      session.provider,
      session.verifier,
      session.createdAt,
      session.status,
      session.error,
    );
  }

  session(state: string, nowSeconds: number): LoginSession | null {
    const row = this.sql.exec("SELECT state, provider, verifier, created_at, status, error FROM oauth_sessions WHERE state = ?", state).toArray()[0];
    if (row === undefined || Number(row.created_at) < nowSeconds - SESSION_SECONDS) return null;
    const status = String(row.status);
    return {
      state: String(row.state),
      provider: String(row.provider),
      verifier: String(row.verifier),
      createdAt: Number(row.created_at),
      status: status === "ok" || status === "error" ? status : "wait",
      error: String(row.error),
    };
  }

  removeSession(state: string): boolean {
    const found = this.sql.exec("SELECT 1 FROM oauth_sessions WHERE state = ?", state).toArray().length > 0;
    this.sql.exec("DELETE FROM oauth_sessions WHERE state = ?", state);
    return found;
  }

  // Sign-in throttle: at most ATTEMPT_LIMIT tries per client per minute.
  attemptAllowed(client: string, nowSeconds: number): boolean {
    this.sql.exec("DELETE FROM login_attempts WHERE at <= ?", nowSeconds - ATTEMPT_WINDOW);
    const count = Number(this.sql.exec("SELECT COUNT(*) AS n FROM login_attempts WHERE client = ?", client).toArray()[0]?.n ?? 0);
    if (count >= ATTEMPT_LIMIT) return false;
    this.sql.exec("INSERT INTO login_attempts (client, at) VALUES (?, ?)", client, nowSeconds);
    return true;
  }
}

function toCredentialFile(row: Record<string, unknown>): CredentialFile {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(row.data));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // A damaged row lists with no fields rather than breaking the whole list.
  }
  return {
    name: String(row.name),
    provider: String(row.provider),
    data,
    disabled: Number(row.disabled) === 1,
    statusMessage: String(row.status_message),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function claudeFileData(credential: Credential): Record<string, unknown> {
  return {
    type: "claude",
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    email: credential.email,
    expired: new Date(credential.expiresAt * 1000).toISOString(),
    last_refresh: new Date().toISOString(),
  };
}

export function claudeCredential(data: Record<string, unknown>): Credential | null {
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") return null;
  const expires = typeof data.expired === "string" ? Date.parse(data.expired) : Number.NaN;
  return {
    accessToken,
    refreshToken,
    expiresAt: Number.isFinite(expires) ? Math.floor(expires / 1000) : 0,
    email: typeof data.email === "string" ? data.email : "",
  };
}
