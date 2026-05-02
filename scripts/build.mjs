import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(repoRoot, "dist");
const packageJson = JSON.parse(await readJson("package.json"));
const version = packageJson.version;
const target = process.argv[2] || "all";

const targets = target === "all" ? ["chrome", "firefox"] : [target];
const validTargets = new Set(["chrome", "firefox"]);

for (const item of targets) {
  if (!validTargets.has(item)) {
    throw new Error(`Unknown build target: ${item}`);
  }
}

await mkdir(distDir, { recursive: true });

for (const item of targets) {
  await buildExtension(item);
}

async function buildExtension(browserName) {
  const packageDir = join(distDir, browserName);
  const zipPath = join(distDir, `githeron-${browserName}-v${version}.zip`);

  await rm(packageDir, { recursive: true, force: true });
  await rm(zipPath, { force: true });
  await mkdir(packageDir, { recursive: true });

  for (const file of packageFiles()) {
    await copyFileToPackage(file, packageDir);
  }

  const manifestFile = browserName === "firefox" ? "manifest.firefox.json" : "manifest.json";
  const manifest = JSON.parse(await readJson(manifestFile));
  manifest.version = version;
  await writeFile(join(packageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  execFileSync("zip", ["-qr", zipPath, "."], { cwd: packageDir, stdio: "inherit" });
  console.log(`Built ${zipPath}`);
}

function packageFiles() {
  return [
    "browser-polyfill.js",
    "README.md",
    "background/service-worker.js",
    "content/content-script.js",
    "content/content-style.css",
    "sidepanel/sidepanel.css",
    "sidepanel/sidepanel.html",
    "sidepanel/sidepanel.js",
    "vendor/defuddle/defuddle.full.js"
  ];
}

async function copyFileToPackage(file, packageDir) {
  const source = join(repoRoot, file);
  if (!existsSync(source)) {
    throw new Error(`Package file does not exist: ${file}`);
  }

  const destination = join(packageDir, file);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function readJson(file) {
  return readFile(join(repoRoot, file), "utf8");
}
