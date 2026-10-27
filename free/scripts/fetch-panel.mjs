// Downloads CPA's official dashboard (Cli-Proxy-API-Management-Center) into public/ before each
// build. The release and its SHA-256 are pinned below, as in container/Dockerfile, and bumped by a
// reviewed PR from .github/workflows/bump-upstream.yml; a changed upstream file fails the build.
// PANEL_VERSION (a tag, or "latest") and PANEL_SHA256 override them.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const PINNED_VERSION = "v1.26.7";
const PINNED_SHA256 = "8c9c6b7d3fb311e6aad5d06e1993e53a2d28389e640448a1bc6304ed20b057b5";

const version = process.env.PANEL_VERSION || PINNED_VERSION;
const expected = (process.env.PANEL_SHA256 || (version === PINNED_VERSION ? PINNED_SHA256 : "")).trim().toLowerCase();
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
