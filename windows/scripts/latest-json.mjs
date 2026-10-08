// Writes release/latest.json, the feed updater.rs reads from the rolling
// windows-latest release. Run after a build made with tauri.updater.conf.json
// (`npm run pack:update`), which leaves the installer's .sig next to it, with
// COUCOU_UPDATE_REPO set to "owner/repo".

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = process.env.COUCOU_UPDATE_REPO;
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('Set COUCOU_UPDATE_REPO to "owner/repo".');
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));

const nsis = join(root, "target", "release", "bundle", "nsis");
const sig = readdirSync(nsis)
  .filter((f) => f.endsWith("-setup.exe.sig") && f.includes(`_${version}_`))
  .map((f) => join(nsis, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!sig) {
  console.error(`No signed installer for ${version} in ${nsis}: build with npm run pack:update.`);
  process.exit(1);
}

// The versioned asset the windows-v<version> release publishes (see pack.mjs).
const url = `https://github.com/${repo}/releases/download/windows-v${version}/Coucou-Windows-${version}-setup.exe`;
const feed = {
  version,
  pub_date: new Date().toISOString(),
  platforms: { "windows-x86_64": { signature: readFileSync(sig, "utf8").trim(), url } },
};
mkdirSync(join(root, "release"), { recursive: true });
writeFileSync(join(root, "release", "latest.json"), JSON.stringify(feed, null, 2) + "\n");
console.log(`release/latest.json → ${version}, ${url}`);
