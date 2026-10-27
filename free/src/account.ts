import { OAuthError, authorizeUrl, exchangeCode, parseCallback, randomToken, refresh, type Credential, type Fetcher } from "./claude-oauth.ts";
import type { KeyRow, Vault } from "./vault.ts";

export type TokenResult = { ok: true; accessToken: string; expiresAt: number } | { ok: false; status: number; message: string };

export interface Overview {
  readonly account: { email: string; expiresAt: number } | null;
  readonly keys: KeyRow[];
}

// Everything the Worker asks of the Durable Object. The Durable Object is one instance, so the
// token refresh below never runs twice at once.
export interface Backend {
  keyValid(hash: string): Promise<boolean>;
  token(): Promise<TokenResult>;
  invalidate(accessToken: string): Promise<void>;
  overview(): Promise<Overview>;
  createKey(name: string): Promise<string>;
  revokeKey(id: number): Promise<void>;
  startLogin(): Promise<string>;
  finishLogin(callback: string): Promise<string | null>;
  disconnect(): Promise<void>;
  attemptAllowed(client: string): Promise<boolean>;
}

export const REFRESH_MARGIN_SECONDS = 5 * 60;
const FORCED_REFRESH_GAP_SECONDS = 60;
const NOT_CONNECTED = "No Claude account is connected yet: connect one in the dashboard.";

export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`sub2api key v1\0${key}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Account implements Backend {
  private refreshing: Promise<TokenResult> | null = null;
  private lastForcedRefresh = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly vault: Vault,
    private readonly fetcher: Fetcher,
    private readonly nowSeconds: () => number,
  ) {}

  async keyValid(hash: string): Promise<boolean> {
    return this.vault.keyExists(hash);
  }

  async token(): Promise<TokenResult> {
    const current = this.vault.credential();
    if (current === null) return { ok: false, status: 503, message: NOT_CONNECTED };
    if (current.expiresAt - this.nowSeconds() > REFRESH_MARGIN_SECONDS) return granted(current);
    this.refreshing ??= this.refresh(current).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  // Anthropic refused this token: refresh before its stated expiry, at most once a minute so a
  // client that keeps getting refused can't hammer the token endpoint.
  async invalidate(accessToken: string): Promise<void> {
    const current = this.vault.credential();
    const now = this.nowSeconds();
    if (current?.accessToken !== accessToken || now - this.lastForcedRefresh < FORCED_REFRESH_GAP_SECONDS) return;
    this.lastForcedRefresh = now;
    this.vault.saveCredential({ ...current, expiresAt: 0 });
  }

  async overview(): Promise<Overview> {
    const credential = this.vault.credential();
    return { account: credential && { email: credential.email, expiresAt: credential.expiresAt }, keys: this.vault.keys() };
  }

  async createKey(name: string): Promise<string> {
    const key = `sk-s2a-${randomToken(32)}`;
    this.vault.addKey(name.trim().slice(0, 60) || "Unnamed key", await hashKey(key), key.slice(-4), this.nowSeconds());
    return key;
  }

  async revokeKey(id: number): Promise<void> {
    this.vault.removeKey(id);
  }

  async startLogin(): Promise<string> {
    const state = randomToken(32);
    const verifier = randomToken(96);
    this.vault.savePending(state, verifier, this.nowSeconds());
    return authorizeUrl(state, verifier);
  }

  async finishLogin(callback: string): Promise<string | null> {
    const parsed = parseCallback(callback);
    if (parsed === null) return "That doesn't look like the callback address. Paste the whole localhost address from the address bar.";
    const verifier = this.vault.takePending(parsed.state, this.nowSeconds());
    if (verifier === null) return "This login has expired or was already used. Start the login again.";
    try {
      this.vault.saveCredential(await exchangeCode(this.fetcher, parsed.code, parsed.state, verifier, this.nowSeconds()));
      return null;
    } catch (error) {
      return error instanceof OAuthError ? `Login failed. ${error.message}` : "Login failed: Anthropic couldn't be reached.";
    }
  }

  async disconnect(): Promise<void> {
    this.vault.saveCredential(null);
  }

  async attemptAllowed(client: string): Promise<boolean> {
    return this.vault.attemptAllowed(client, this.nowSeconds());
  }

  private async refresh(current: Credential): Promise<TokenResult> {
    try {
      const next = await refresh(this.fetcher, current, this.nowSeconds());
      this.vault.saveCredential(next);
      return granted(next);
    } catch (error) {
      if (error instanceof OAuthError && (error.status === 400 || error.status === 401)) {
        return { ok: false, status: 503, message: "The Claude login has expired: connect the account again in the dashboard." };
      }
      // A token that hasn't actually expired yet is still worth using.
      if (current.expiresAt > this.nowSeconds()) return granted(current);
      const reason = error instanceof OAuthError ? error.message : "Anthropic couldn't be reached";
      return { ok: false, status: 503, message: `Couldn't refresh the Claude login. ${reason}` };
    }
  }
}

function granted(credential: Credential): TokenResult {
  return { ok: true, accessToken: credential.accessToken, expiresAt: credential.expiresAt };
}
