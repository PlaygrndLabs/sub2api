import { OAuthError, authorizeUrl, exchangeCode, parseCallback, randomToken, refresh, type Credential, type Fetcher } from "./claude-oauth.ts";
import { Config } from "./config.ts";
import { upstreamCredentials, type RoutingTable, type UpstreamCredential } from "./providers.ts";
import { claudeCredential, claudeFileData, type CredentialFile, type LoginSession, type Vault } from "./vault.ts";

export type TokenResult = { ok: true; accessToken: string; expiresAt: number } | { ok: false; status: number; message: string };

// Everything the Worker asks of the Durable Object. The Durable Object is one instance, so the
// state below (config, token refreshes, login sessions) is never raced by another copy.
export interface Backend {
  keyValid(hash: string): Promise<boolean>;
  token(): Promise<TokenResult>;
  invalidate(accessToken: string): Promise<void>;
  attemptAllowed(client: string): Promise<boolean>;
  manage(request: Request): Promise<Response>;
  routing(): Promise<RoutingTable>;
}

export const REFRESH_MARGIN_SECONDS = 5 * 60;
const FORCED_REFRESH_GAP_SECONDS = 60;
const NOT_CONNECTED = "No Claude account is connected yet: add one under OAuth login in the dashboard.";

export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`sub2api key v1\0${key}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Account {
  private config: Config | null = null;
  private upstreams: UpstreamCredential[] | null = null;
  private keyHashes: Set<string> | null = null;
  private readonly refreshing = new Map<string, Promise<TokenResult>>();
  private readonly lastForcedRefresh = new Map<string, number>();
  private next = 0;

  constructor(
    readonly vault: Vault,
    readonly fetcher: Fetcher,
    readonly nowSeconds: () => number,
  ) {}

  currentConfig(): Config {
    this.config ??= new Config(this.vault.configText());
    return this.config;
  }

  saveConfig(config: Config): void {
    this.vault.saveConfigText(config.text);
    this.config = config;
    this.keyHashes = null;
    this.upstreams = null;
  }

  // What the Worker needs to pick an upstream for a request: the configured API-key providers
  // and whether any Claude login is on.
  async routing(): Promise<RoutingTable> {
    this.upstreams ??= upstreamCredentials(this.currentConfig().read([]));
    return { credentials: this.upstreams, claudeOAuth: this.claudeFiles().length > 0 };
  }

  async keyValid(hash: string): Promise<boolean> {
    if (this.keyHashes === null) {
      this.keyHashes = new Set(await Promise.all(this.currentConfig().apiKeys().map(hashKey)));
    }
    // Keys made by the first free release's own dashboard were stored only as hashes.
    return this.keyHashes.has(hash) || this.vault.keyExists(hash);
  }

  claudeFiles(): CredentialFile[] {
    return this.vault.credentialFiles().filter((file) => file.provider === "claude" && !file.disabled);
  }

  // Picks the next enabled Claude login in turn (round-robin), refreshing it when near expiry.
  async token(): Promise<TokenResult> {
    const files = this.claudeFiles();
    if (files.length === 0) return { ok: false, status: 503, message: NOT_CONNECTED };
    const file = files[this.next % files.length] as CredentialFile;
    this.next += 1;
    return this.tokenFor(file);
  }

  async tokenFor(file: CredentialFile, force = false): Promise<TokenResult> {
    const current = claudeCredential(file.data);
    if (current === null) return { ok: false, status: 503, message: `The Claude login ${file.name} has no tokens: sign in again.` };
    if (!force && current.expiresAt - this.nowSeconds() > REFRESH_MARGIN_SECONDS) return granted(current);
    let pending = this.refreshing.get(file.name);
    if (pending === undefined) {
      pending = this.refresh(file, current).finally(() => this.refreshing.delete(file.name));
      this.refreshing.set(file.name, pending);
    }
    return pending;
  }

  // Anthropic refused this token: refresh before its stated expiry, at most once a minute per
  // login so a client that keeps getting refused can't hammer the token endpoint.
  async invalidate(accessToken: string): Promise<void> {
    const now = this.nowSeconds();
    for (const file of this.claudeFiles()) {
      if (file.data.access_token !== accessToken) continue;
      if (now - (this.lastForcedRefresh.get(file.name) ?? Number.NEGATIVE_INFINITY) < FORCED_REFRESH_GAP_SECONDS) return;
      this.lastForcedRefresh.set(file.name, now);
      this.vault.saveCredentialFile(file.name, file.provider, { ...file.data, expired: new Date(0).toISOString() }, now);
      return;
    }
  }

  async attemptAllowed(client: string): Promise<boolean> {
    return this.vault.attemptAllowed(client, this.nowSeconds());
  }

  async startLogin(provider: string): Promise<{ url: string; state: string }> {
    const state = randomToken(32);
    const verifier = randomToken(96);
    this.vault.saveSession({ state, provider, verifier, createdAt: this.nowSeconds(), status: "wait", error: "" }, this.nowSeconds());
    return { url: await authorizeUrl(state, verifier), state };
  }

  session(state: string): LoginSession | null {
    return this.vault.session(state, this.nowSeconds());
  }

  // Exchanges the code right away, so the session is finished by the time the dashboard polls.
  async finishLogin(state: string, code: string, error: string): Promise<{ status: number; error?: string }> {
    const session = this.session(state);
    if (session === null) return { status: 404, error: "unknown or expired state" };
    if (session.status === "ok") return { status: 409, error: "oauth flow is already completed" };
    if (session.status === "error") return { status: 409, error: session.error || "oauth flow failed" };
    const finish = (status: "ok" | "error", message = "") => this.vault.saveSession({ ...session, status, error: message }, this.nowSeconds());
    if (error !== "") {
      finish("error", "Bad request");
      return { status: 200 };
    }
    try {
      const credential = await exchangeCode(this.fetcher, code.split("#")[0] ?? code, state, session.verifier, this.nowSeconds());
      this.vault.saveCredentialFile(`claude-${credential.email || randomToken(6)}.json`, "claude", claudeFileData(credential), this.nowSeconds());
      finish("ok");
    } catch (failure) {
      finish("error", failure instanceof OAuthError ? `Failed to exchange authorization code for tokens: ${failure.message}` : "Failed to exchange authorization code for tokens");
    }
    return { status: 200 };
  }

  // Accepts a pasted callback address or "code#state" text.
  async finishLoginFromText(text: string): Promise<string | null> {
    const parsed = parseCallback(text);
    if (parsed === null) return "That doesn't look like the callback address. Paste the whole localhost address from the address bar.";
    const result = await this.finishLogin(parsed.state, parsed.code, "");
    if (result.error !== undefined) return result.error;
    const session = this.session(parsed.state);
    return session?.status === "ok" ? null : session?.error || "Login failed.";
  }

  private async refresh(file: CredentialFile, current: Credential): Promise<TokenResult> {
    try {
      const next = await refresh(this.fetcher, current, this.nowSeconds());
      this.vault.saveCredentialFile(file.name, "claude", { ...file.data, ...claudeFileData(next) }, this.nowSeconds());
      this.vault.setCredentialStatus(file.name, false, "", this.nowSeconds());
      return granted(next);
    } catch (error) {
      if (error instanceof OAuthError && (error.status === 400 || error.status === 401)) {
        this.vault.setCredentialStatus(file.name, false, "token expired", this.nowSeconds());
        return { ok: false, status: 503, message: "The Claude login has expired: sign in again under OAuth login in the dashboard." };
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
