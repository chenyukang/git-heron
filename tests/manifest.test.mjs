import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("manifest versions match package version", () => {
  const packageJson = readJson("package.json");
  const chromeManifest = readJson("manifest.json");
  const firefoxManifest = readJson("manifest.firefox.json");

  assert.equal(chromeManifest.version, packageJson.version);
  assert.equal(firefoxManifest.version, packageJson.version);
});

test("Chrome manifest keeps Chrome side panel wiring", () => {
  const manifest = readJson("manifest.json");

  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.equal(manifest.side_panel.default_path, "sidepanel/sidepanel.html");
  assert.equal(manifest.background.service_worker, "background/service-worker.js");
});

test("Firefox manifest uses sidebar action and background scripts", () => {
  const manifest = readJson("manifest.firefox.json");
  const scripts = manifest.background.scripts;
  const contentScripts = manifest.content_scripts[0].js;

  assert.ok(!manifest.permissions.includes("sidePanel"));
  assert.ok(!("side_panel" in manifest));
  assert.equal(manifest.sidebar_action.default_panel, "sidepanel/sidepanel.html");
  assert.equal(manifest.browser_specific_settings.gecko.id, "githeron@chenyukang.github.io");
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "142.0");
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, [
    "authenticationInfo",
    "websiteActivity",
    "websiteContent"
  ]);
  assert.deepEqual(scripts, ["browser-polyfill.js", "background/service-worker.js"]);
  assert.equal(contentScripts[0], "browser-polyfill.js");
  assert.equal(contentScripts.at(-1), "content/content-script.js");
});

test("extension pages load the browser polyfill before app code", () => {
  const html = readFileSync(path.join(repoRoot, "sidepanel", "sidepanel.html"), "utf8");

  assert.ok(html.indexOf("../browser-polyfill.js") < html.indexOf("sidepanel.js"));
});

function readJson(file) {
  return JSON.parse(readFileSync(path.join(repoRoot, file), "utf8"));
}
