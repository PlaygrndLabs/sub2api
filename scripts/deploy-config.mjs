// Runs before `wrangler deploy` in `npm run deploy`. Cloudflare container app names are unique per
// account, so a fixed name lets only one Container install exist per account. This names the
// container app after the Worker, which is unique already: the Worker sub2api keeps its app sub2api,
// and a second install deployed as sub2api-test gets the app sub2api-test.
// It writes wrangler.deploy.json next to wrangler.jsonc, so relative paths in it stay valid, and
// leaves wrangler.jsonc as it is.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Removes comments and trailing commas, which wrangler.jsonc may hold and JSON.parse rejects.
export function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== "}" && text[j] !== "]") out += c;
    } else {
      out += c;
    }
  }
  return out;
}

// Workers Builds sets WRANGLER_CI_OVERRIDE_NAME to the Worker it builds, and wrangler deploys under
// that name even when the config says otherwise, so the container app follows it too.
export function deployConfig(text, overrideName) {
  const config = JSON.parse(stripJsonc(text));
  const name = overrideName || config.name;
  if (typeof name !== "string" || name === "") throw new Error("wrangler.jsonc has no Worker name");
  config.name = name;
  for (const container of config.containers ?? []) container.name = name;
  return config;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  const target = fileURLToPath(new URL("../wrangler.deploy.json", import.meta.url));
  const config = deployConfig(readFileSync(source, "utf8"), process.env.WRANGLER_CI_OVERRIDE_NAME);
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Worker ${config.name}, container app ${config.name}`);
}
