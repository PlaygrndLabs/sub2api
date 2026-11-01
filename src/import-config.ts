import { isMap, parseDocument } from "yaml";

// A config moved over from the Workers-only install (scripts/move-to-container.sh) waits at
// IMPORT_KEY until CPA's first start. CPA keeps its own config at CONFIG_KEY once it has started.
export const IMPORT_KEY = "import/config.yaml";
export const CONFIG_KEY = "config/config.yaml";

// The entrypoint writes these itself, so an imported file never sets the port or the management key.
const OWNED_BY_ENTRYPOINT = ["config-version", "server", "management", "remote-management"];

export interface ImportStore {
  head(key: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(key: string): Promise<void>;
}

// The imported config body for CPA's first start, without the sections the entrypoint owns.
// Null when there is nothing to import or the file is not a YAML map.
export function importBody(text: string): string | null {
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  for (const key of OWNED_BY_ENTRYPOINT) doc.delete(key);
  if (doc.contents.items.length === 0) return null;
  return doc.toString();
}

// Returns the config to import on CPA's first start. Once CPA has its own config the waiting
// file is removed, so its keys don't stay in the bucket twice.
export async function takeImport(store: ImportStore): Promise<string | null> {
  if ((await store.head(CONFIG_KEY)) !== null) {
    if ((await store.head(IMPORT_KEY)) !== null) await store.delete(IMPORT_KEY);
    return null;
  }
  const waiting = await store.get(IMPORT_KEY);
  if (waiting === null) return null;
  const body = importBody(await waiting.text());
  if (body === null) console.error(`${IMPORT_KEY} is not a YAML map; CPA starts with the default config`);
  return body;
}
