import { OAuthError, authorizeUrl, exchangeCode, parseCallback, randomToken, refresh, type Fetcher } from "./claude-oauth.ts";
import * as codex from "./codex-oauth.ts";
import { Config } from "./config.ts";
import { CatalogCache } from "./models.ts";
import { upstreamCredentials, type RoutingTable, type UpstreamCredential } from "./providers.ts";
import { storedKey, type UsageRecord } from "./usage.ts";
import * as kimi from "./kimi-oauth.ts";
import { claudeCredential, claudeFileData, type CredentialFile, type LoginSession, type Vault } from "./vault.ts";
import { mintToken, vertexLogin, vertexModelsUrl } from "./vertex-auth.ts";

// `name` is the login file the token belongs to, for its usage counts. `endpoint` is where the
// login's requests go (a Vertex project and location, or a Kimi domain), and `headers` any it
// must send with them.
export type TokenResult =
  | { ok: true; accessToken: string; expiresAt: number; accountId?: string; endpoint?: string; headers?: Record<string, string>; name?: string }
  | { ok: false; status: number; message: string };

// The logins the gateway keeps fresh: subscriptions signed in to from the dashboard, and Vertex
// service accounts imported there.
export type LoginProvider = "claude" | "codex" | "kimi" | "vertex";
export type OAuthProvider = Exclude<LoginProvider, "vertex">;
// Logins the Worker serves like an API key of their provider, with a token and an endpoint.
export type ServedLogin = "kimi" | "vertex";
export const LOGIN_PROVIDERS: readonly LoginProvider[] = ["claude", "codex", "kimi", "vertex"];
const LABEL: Record<LoginProvider, string> = { claude: "Claude", codex: "ChatGPT (Codex)", kimi: "Kimi", vertex: "Vertex AI" };
// CPA names Kimi.ai logins "kimi-ai"; they are Kimi logins on the other domain.
const PROVIDER_OF_FILE: Record<string, LoginProvider> = { "kimi-ai": "kimi" };

// Everything the Worker asks of the Durable Object. The Durable Object is one instance, so the
// state below (config, token refreshes, login sessions) is never raced by another copy.
export interface Backend {
  keyValid(hash: string): Promise<boolean>;
  token(): Promise<TokenResult>;
  codexToken(): Promise<TokenResult>;
  loginToken(provider: ServedLogin): Promise<TokenResult>;
  invalidate(accessToken: string): Promise<void>;
  attemptAllowed(client: string): Promise<boolean>;
  manage(request: Request): Promise<Response>;
  routing(): Promise<RoutingTable>;
  record(records: UsageRecord[]): Promise<void>;
}

// A Kimi device login waiting for approval, kept in its session row.
interface KimiFlow {
  readonly deviceCode: string;
  readonly deviceId: string;
  readonly domain: kimi.KimiDomain;
  readonly interval: number;
  readonly expiresAt: number;
}

export const REFRESH_MARGIN_SECONDS = 5 * 60;
const FORCED_REFRESH_GAP_SECONDS = 60;

interface Login {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly accountId: string;
  readonly endpoint?: string;
  readonly headers?: Record<string, string>;
}

function loginOf(file: CredentialFile): Login | null {
  if (file.provider === "codex") return codex.codexCredential(file.data);
  if (file.provider === "kimi" || file.provider === "kimi-ai") {
    const login = kimi.kimiLogin(file.data);
    return login === null ? null : { accessToken: login.accessToken, refreshToken: login.refreshToken, expiresAt: login.expiresAt, accountId: "", endpoint: kimi.apiBase(login.domain), headers: kimi.identityHeaders(login.deviceId) };
  }
  if (file.provider === "vertex") {
    const login = vertexLogin(file.data);
    return login === null ? null : { accessToken: login.accessToken, refreshToken: "", expiresAt: login.expiresAt, accountId: "", endpoint: vertexModelsUrl(login) };
  }
  const credential = claudeCredential(file.data);
  return credential === null ? null : { ...credential, accountId: "" };
}

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
  private readonly next = new Map<LoginProvider, number>();
  // CPA's model catalog, for the dashboard's model lists.
  readonly catalog = new CatalogCache();
  private readonly nextPoll = new Map<string, number>();

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
  // and which logins are on.
  async routing(): Promise<RoutingTable> {
    this.upstreams ??= upstreamCredentials(this.currentConfig().read([]));
    const codexFiles = this.loginFiles("codex");
    const codexPlans = codexFiles.map((file) => (typeof file.data.plan_type === "string" ? file.data.plan_type : ""));
    return { credentials: this.upstreams, claudeOAuth: this.loginFiles("claude").length > 0, codexOAuth: codexFiles.length > 0, codexPlans, vertexOAuth: this.loginFiles("vertex").length > 0, kimiOAuth: this.loginFiles("kimi").length > 0 };
  }

  async keyValid(hash: string): Promise<boolean> {
    if (this.keyHashes === null) {
      this.keyHashes = new Set(await Promise.all(this.currentConfig().apiKeys().map(hashKey)));
    }
    // Keys made by the first free release's own dashboard were stored only as hashes.
    return this.keyHashes.has(hash) || this.vault.keyExists(hash);
  }

  loginFiles(provider: LoginProvider): CredentialFile[] {
    return this.vault.credentialFiles().filter((file) => (PROVIDER_OF_FILE[file.provider] ?? file.provider) === provider && !file.disabled);
  }

  claudeFiles(): CredentialFile[] {
    return this.loginFiles("claude");
  }

  token(): Promise<TokenResult> {
    return this.loginToken("claude");
  }

  codexToken(): Promise<TokenResult> {
    return this.loginToken("codex");
  }

  // Picks the provider's next enabled login in turn (round-robin), refreshing it when near expiry.
  async loginToken(provider: LoginProvider): Promise<TokenResult> {
    const files = this.loginFiles(provider);
    if (files.length === 0) return { ok: false, status: 503, message: `No ${LABEL[provider]} account is connected yet: add one under OAuth login in the dashboard.` };
    const turn = this.next.get(provider) ?? 0;
    this.next.set(provider, turn + 1);
    return this.tokenFor(files[turn % files.length] as CredentialFile);
  }

  async tokenFor(file: CredentialFile, force = false): Promise<TokenResult> {
    const current = loginOf(file);
    if (current === null) return { ok: false, status: 503, message: file.provider === "vertex" ? `The Vertex file ${file.name} has no usable service account: import it again.` : `The login ${file.name} has no tokens: sign in again.` };
    if (!force && current.expiresAt - this.nowSeconds() > REFRESH_MARGIN_SECONDS) return granted(current, file.name);
    let pending = this.refreshing.get(file.name);
    if (pending === undefined) {
      pending = this.refresh(file, current).finally(() => this.refreshing.delete(file.name));
      this.refreshing.set(file.name, pending);
    }
    return pending;
  }

  // The provider refused this token: refresh before its stated expiry, at most once a minute per
  // login so a client that keeps getting refused can't hammer the token endpoint.
  async invalidate(accessToken: string): Promise<void> {
    const now = this.nowSeconds();
    for (const file of LOGIN_PROVIDERS.flatMap((provider) => this.loginFiles(provider))) {
      if (file.data.access_token !== accessToken) continue;
      if (now - (this.lastForcedRefresh.get(file.name) ?? Number.NEGATIVE_INFINITY) < FORCED_REFRESH_GAP_SECONDS) return;
      this.lastForcedRefresh.set(file.name, now);
      this.vault.saveCredentialFile(file.name, file.provider, { ...file.data, expired: new Date(0).toISOString() }, now);
      return;
    }
  }

  // Counts every attempt; keeps log lines only while the dashboard's "logging to file" is on.
  async record(records: UsageRecord[]): Promise<void> {
    const stored = await Promise.all(records.map(async (record) => ({ ...record, attempts: await Promise.all(record.attempts.map(async (attempt) => ({ ...attempt, key: await storedKey(attempt.key) }))) })));
    this.vault.usage.record(stored, this.loggingEnabled(), this.nowSeconds());
  }

  loggingEnabled(): boolean {
    try {
      return this.currentConfig().read(["observability", "logs", "logging-to-file"]) === true;
    } catch {
      return false;
    }
  }

  async attemptAllowed(client: string): Promise<boolean> {
    return this.vault.attemptAllowed(client, this.nowSeconds());
  }

  async startLogin(provider: OAuthProvider, domain = ""): Promise<{ url: string; state: string; userCode?: string; expiresIn?: number }> {
    const state = randomToken(32);
    if (provider === "kimi") {
      // A device flow: the dashboard opens Kimi's page, and polling the status finishes it.
      const kimiDomain = kimi.kimiDomain(domain);
      const deviceId = crypto.randomUUID();
      const device = await kimi.startDevice(this.fetcher, kimiDomain, deviceId);
      const flow: KimiFlow = { deviceCode: device.deviceCode, deviceId, domain: kimiDomain, interval: device.interval, expiresAt: this.nowSeconds() + device.expiresIn };
      this.vault.saveSession({ state, provider, verifier: JSON.stringify(flow), createdAt: this.nowSeconds(), status: "wait", error: "" }, this.nowSeconds());
      return { url: device.url, state, ...(device.userCode === "" ? {} : { userCode: device.userCode }), expiresIn: device.expiresIn };
    }
    const verifier = randomToken(96);
    this.vault.saveSession({ state, provider, verifier, createdAt: this.nowSeconds(), status: "wait", error: "" }, this.nowSeconds());
    return { url: provider === "codex" ? await codex.authorizeUrl(state, verifier) : await authorizeUrl(state, verifier), state };
  }

  session(state: string): LoginSession | null {
    return this.vault.session(state, this.nowSeconds());
  }

  // Asks Kimi once whether a device login was approved, no sooner than Kimi's interval allows.
  async pollDevice(session: LoginSession): Promise<LoginSession> {
    if (session.provider !== "kimi" || session.status !== "wait") return session;
    let flow: KimiFlow;
    try {
      flow = JSON.parse(session.verifier) as KimiFlow;
    } catch {
      return session;
    }
    const now = this.nowSeconds();
    if (now < (this.nextPoll.get(session.state) ?? 0)) return session;
    this.nextPoll.set(session.state, now + flow.interval);
    const save = (next: LoginSession) => {
      this.vault.saveSession(next, now);
      return next;
    };
    if (now > flow.expiresAt) return save({ ...session, status: "error", error: "Authentication failed: the Kimi code expired" });
    const result = await kimi.pollDevice(this.fetcher, flow.domain, flow.deviceId, flow.deviceCode, flow.interval, now).catch((): kimi.PollResult => ({ status: "wait" }));
    if (result.status === "wait") {
      if (result.interval !== undefined) save({ ...session, verifier: JSON.stringify({ ...flow, interval: result.interval }) });
      return session;
    }
    if (result.status === "error") return save({ ...session, status: "error", error: result.message });
    this.vault.saveCredentialFile(`${flow.domain === "kimi.ai" ? "kimi-ai" : "kimi"}-${now * 1000}.json`, flow.domain === "kimi.ai" ? "kimi-ai" : "kimi", kimi.kimiFileData(result.token, flow.domain, flow.deviceId), now);
    this.nextPoll.delete(session.state);
    return save({ ...session, status: "ok", error: "" });
  }

  // Exchanges the code right away, so the session is finished by the time the dashboard polls.
  async finishLogin(state: string, code: string, error: string): Promise<{ status: number; error?: string }> {
    const session = this.session(state);
    if (session === null) return { status: 404, error: "unknown or expired state" };
    if (session.status === "ok") return { status: 409, error: "oauth flow is already completed" };
    if (session.status === "error") return { status: 409, error: session.error || "oauth flow failed" };
    if (session.provider === "kimi") return { status: 400, error: "Kimi logins finish on Kimi's page, without a callback" };
    const finish = (status: "ok" | "error", message = "") => this.vault.saveSession({ ...session, status, error: message }, this.nowSeconds());
    if (error !== "") {
      finish("error", "Bad request");
      return { status: 200 };
    }
    try {
      const bareCode = code.split("#")[0] ?? code;
      if (session.provider === "codex") {
        const credential = await codex.exchangeCode(this.fetcher, bareCode, session.verifier, this.nowSeconds());
        this.vault.saveCredentialFile(await codex.codexFileName(credential), "codex", codex.codexFileData(credential), this.nowSeconds());
      } else {
        const credential = await exchangeCode(this.fetcher, bareCode, state, session.verifier, this.nowSeconds());
        this.vault.saveCredentialFile(`claude-${credential.email || randomToken(6)}.json`, "claude", claudeFileData(credential), this.nowSeconds());
      }
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

  private async refresh(file: CredentialFile, current: Login): Promise<TokenResult> {
    const provider = PROVIDER_OF_FILE[file.provider] ?? file.provider;
    const label = Object.hasOwn(LABEL, provider) ? LABEL[provider as LoginProvider] : file.provider;
    try {
      let next: Login;
      if (file.provider === "kimi" || file.provider === "kimi-ai") {
        const login = kimi.kimiLogin(file.data);
        if (login === null || login.refreshToken === "") throw new OAuthError("the login has no refresh token", 401);
        const refreshed = await kimi.refresh(this.fetcher, login.domain, login.deviceId, login.refreshToken, this.nowSeconds());
        this.vault.saveCredentialFile(file.name, file.provider, { ...file.data, ...kimi.kimiFileData(refreshed, login.domain, login.deviceId), type: file.provider }, this.nowSeconds());
        next = { ...current, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken, expiresAt: refreshed.expiresAt };
      } else if (file.provider === "vertex") {
        const login = vertexLogin(file.data);
        if (login === null) throw new OAuthError("the file has no usable service account", 400);
        const minted = await mintToken(this.fetcher, login.account, this.nowSeconds());
        this.vault.saveCredentialFile(file.name, file.provider, { ...file.data, access_token: minted.accessToken, expired: new Date(minted.expiresAt * 1000).toISOString() }, this.nowSeconds());
        next = { ...current, ...minted };
      } else if (file.provider === "codex") {
        const refreshed = await codex.refresh(this.fetcher, codex.codexCredential(file.data) as codex.CodexCredential, this.nowSeconds());
        this.vault.saveCredentialFile(file.name, file.provider, { ...file.data, ...codex.codexFileData(refreshed) }, this.nowSeconds());
        next = refreshed;
      } else {
        const refreshed = await refresh(this.fetcher, claudeCredential(file.data) as NonNullable<ReturnType<typeof claudeCredential>>, this.nowSeconds());
        this.vault.saveCredentialFile(file.name, file.provider, { ...file.data, ...claudeFileData(refreshed) }, this.nowSeconds());
        next = { ...refreshed, accountId: "" };
      }
      this.vault.setCredentialStatus(file.name, false, "", this.nowSeconds());
      return granted(next, file.name);
    } catch (error) {
      if (error instanceof OAuthError && (error.status === 400 || error.status === 401)) {
        this.vault.setCredentialStatus(file.name, false, "token expired", this.nowSeconds());
        const message = file.provider === "vertex" ? `Google refused the Vertex service account ${file.name}: check its key and roles, then import it again.` : `The ${label} login has expired: sign in again under OAuth login in the dashboard.`;
        return { ok: false, status: 503, message };
      }
      // A token that hasn't actually expired yet is still worth using.
      if (current.expiresAt > this.nowSeconds()) return granted(current, file.name);
      const reason = error instanceof OAuthError ? error.message : "the provider couldn't be reached";
      return { ok: false, status: 503, message: `Couldn't refresh the ${label} login. ${reason}` };
    }
  }
}

function granted(login: Login, name: string): TokenResult {
  const result = { ok: true as const, accessToken: login.accessToken, expiresAt: login.expiresAt, name, ...(login.endpoint === undefined ? {} : { endpoint: login.endpoint }), ...(login.headers === undefined ? {} : { headers: login.headers }) };
  return login.accountId === "" ? result : { ...result, accountId: login.accountId };
}
