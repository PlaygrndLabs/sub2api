import { Document, isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";

// The gateway's settings, kept as CPA's v8 YAML document so CPA's dashboard can read and edit
// them through the same /v8/management/config endpoints, with the same path and merge rules.

export const DEFAULT_CONFIG = `config-version: 8
access:
  api-keys: []
routing:
  strategy: "round-robin"
  retry:
    request-retry: 1
observability:
  logs:
    debug: false
    logging-to-file: false
    request-log: false
  usage:
    usage-statistics-enabled: true
`;

export class ConfigError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export async function configTag(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
}

// RFC 9110 strong comparison, as CPA does: no header passes, "*" passes, otherwise one listed
// tag must equal the current one.
export function ifMatchSatisfied(header: string | null, currentTag: string): boolean {
  if (header === null) return true;
  const field = header.trim();
  if (field === "*") return true;
  return field.split(",").some((tag) => tag.trim() === currentTag);
}

function parse(text: string): Document {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new ConfigError(400, "invalid_config", doc.errors[0]?.message);
  if (doc.contents === null) return new Document({});
  if (!isMap(doc.contents)) throw new ConfigError(400, "config_must_be_object");
  return doc;
}

function validate(doc: Document): void {
  const keys = doc.getIn(["access", "api-keys"]);
  if (keys !== undefined && keys !== null && !(isSeq(keys) && keys.items.every((item) => isScalar(item) && typeof item.value === "string"))) {
    throw new ConfigError(400, "invalid_config", "access.api-keys must be a list of strings");
  }
}

export class Config {
  private doc: Document;

  constructor(text: string) {
    this.doc = parse(text);
  }

  get text(): string {
    return this.doc.toString();
  }

  // The client keys the gateway accepts: access.api-keys.
  apiKeys(): string[] {
    const keys = this.doc.getIn(["access", "api-keys"]);
    if (!isSeq(keys)) return [];
    return keys.items.flatMap((item) => (isScalar(item) && typeof item.value === "string" && item.value.trim() !== "" ? [item.value.trim()] : []));
  }

  read(path: string[]): unknown {
    if (path.length === 0) return this.doc.toJS();
    const node = this.doc.getIn(path, true) as Node | undefined;
    if (node === undefined) throw new ConfigError(404, "not_found");
    return isScalar(node) ? node.value : (node as Node & { toJSON(): unknown }).toJSON();
  }

  // PUT: replace the target (the whole document when the path is empty).
  replace(path: string[], value: unknown): void {
    const next = this.doc.clone();
    if (path.length === 0) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(400, "config_must_be_object");
      next.contents = next.createNode(value);
    } else {
      next.setIn(path, next.createNode(value));
    }
    this.commit(next);
  }

  // PATCH: merge objects key by key; lists and scalars are replaced. A null stays a null, as in CPA.
  merge(path: string[], value: unknown): void {
    const next = this.doc.clone();
    const target = path.length === 0 ? next.contents : next.getIn(path, true);
    if (isMap(target) && typeof value === "object" && value !== null && !Array.isArray(value)) {
      mergeInto(next, path, value as Record<string, unknown>);
    } else if (path.length === 0) {
      throw new ConfigError(400, "config_must_be_object");
    } else {
      next.setIn(path, next.createNode(value));
    }
    this.commit(next);
  }

  remove(path: string[]): void {
    if (path.length === 0) throw new ConfigError(400, "cannot_delete_config");
    const next = this.doc.clone();
    if (!next.hasIn(path)) throw new ConfigError(404, "not_found");
    next.deleteIn(path);
    // Prune parents the removal left empty, but no others: an empty map can carry meaning.
    for (let depth = path.length - 1; depth > 0; depth -= 1) {
      const parent = next.getIn(path.slice(0, depth), true);
      if (!isMap(parent) || parent.items.length > 0) break;
      next.deleteIn(path.slice(0, depth));
    }
    this.commit(next);
  }

  replaceText(text: string): void {
    this.commit(parse(text));
  }

  private commit(next: Document): void {
    validate(next);
    this.doc = next;
  }
}

function mergeInto(doc: Document, path: string[], value: Record<string, unknown>): void {
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const existing = doc.getIn(childPath, true);
    if (isMap(existing) && typeof child === "object" && child !== null && !Array.isArray(child)) {
      mergeInto(doc, childPath, child as Record<string, unknown>);
    } else {
      doc.setIn(childPath, doc.createNode(child));
    }
  }
}
