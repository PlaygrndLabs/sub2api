import type { Credential } from "./claude-oauth.ts";

// The slice of Durable Object SQLite storage this file uses, so tests can back it with node:sqlite.
export interface Sql {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] };
}

export interface KeyRow {
  readonly id: number;
  readonly name: string;
  readonly hint: string;
  readonly createdAt: number;
}

const PENDING_SECONDS = 15 * 60;
const ATTEMPT_WINDOW = 60;
const ATTEMPT_LIMIT = 5;

export class Vault {
  constructor(private readonly sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS credential (
      id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL, email TEXT NOT NULL)`);
    sql.exec("CREATE TABLE IF NOT EXISTS pending_login (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, created_at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS login_attempts (client TEXT NOT NULL, at INTEGER NOT NULL)");
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

  savePending(state: string, verifier: string, nowSeconds: number): void {
    this.sql.exec("DELETE FROM pending_login WHERE created_at < ?", nowSeconds - PENDING_SECONDS);
    this.sql.exec("INSERT INTO pending_login (state, verifier, created_at) VALUES (?, ?, ?)", state, verifier, nowSeconds);
  }

  takePending(state: string, nowSeconds: number): string | null {
    const row = this.sql.exec("SELECT verifier, created_at FROM pending_login WHERE state = ?", state).toArray()[0];
    this.sql.exec("DELETE FROM pending_login WHERE state = ?", state);
    if (row === undefined || Number(row.created_at) < nowSeconds - PENDING_SECONDS) return null;
    return String(row.verifier);
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
