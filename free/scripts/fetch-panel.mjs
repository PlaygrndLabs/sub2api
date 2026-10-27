// Downloads CPA's official dashboard (Cli-Proxy-API-Management-Center) into public/ before each
// build. PANEL_VERSION pins a release tag; the default is the latest release, as on the paid install.
import { mkdir, writeFile } from "node:fs/promises";

const version = process.env.PANEL_VERSION ?? "latest";
const base = "https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases";
const url = version === "latest" ? `${base}/latest/download/management.html` : `${base}/download/${version}/management.html`;

const response = await fetch(url);
if (!response.ok) throw new Error(`Downloading the dashboard failed: ${response.status} ${url}`);
const html = await response.text();
if (!html.includes("<html")) throw new Error("The downloaded dashboard is not an HTML page");
const target = new URL("../public/", import.meta.url);
await mkdir(target, { recursive: true });
await writeFile(new URL("management.html", target), html);
console.log(`Dashboard ${version} saved (${html.length} bytes)`);
