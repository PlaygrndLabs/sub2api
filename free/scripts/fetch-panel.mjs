// Downloads CPA's official dashboard (Cli-Proxy-API-Management-Center) into public/ before each
// build. PANEL_VERSION pins a release tag; the default is the latest release, as on the paid install.
// PANEL_SHA256, when set, must match the download, so a changed upstream file fails the build.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const version = process.env.PANEL_VERSION || "latest";
const expected = (process.env.PANEL_SHA256 ?? "").trim().toLowerCase();
const base = "https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases";
const url = version === "latest" ? `${base}/latest/download/management.html` : `${base}/download/${version}/management.html`;

const response = await fetch(url);
if (!response.ok) throw new Error(`Downloading the dashboard failed: ${response.status} ${url}`);
const bytes = Buffer.from(await response.arrayBuffer());
const html = bytes.toString("utf8");
if (!html.includes("<html")) throw new Error("The downloaded dashboard is not an HTML page");
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (expected !== "" && sha256 !== expected) throw new Error(`The dashboard's SHA-256 is ${sha256}, not the pinned ${expected}`);
const target = new URL("../public/", import.meta.url);
await mkdir(target, { recursive: true });
await writeFile(new URL("management.html", target), bytes);
console.log(`Dashboard ${version} saved (${html.length} bytes, sha256 ${sha256})`);
