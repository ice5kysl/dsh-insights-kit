// src/host/index.ts
import { createRequire as createRequire2 } from "node:module";
import { existsSync as existsSync3 } from "node:fs";
import { join as join5 } from "node:path";

// src/host/hot.ts
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
var HOT_DIR = ".dsh-insights";
var ID_PREFIX = "dshi-";
var HOT_MOUNT_TIMEOUT_MS = 1e4;
var hotTreeClass;
var shimNames = /* @__PURE__ */ new Set();
async function loadHotTreeClass() {
  if (hotTreeClass !== void 0) return hotTreeClass;
  try {
    const specifier = process.env.DSH_INSIGHTS_INCLUDE_MODULE ?? "@deepseek-ai/cordis-plugin-include";
    const mod = await import(specifier);
    if (mod.Include === void 0) throw new Error("no Include export");
    const Base = mod.Include;
    class InsightsHotTree extends Base {
      /** Runtime-only mount list; the bundle layer owns persistence. */
      write() {
      }
      import(name2) {
        if (shimNames.has(name2)) return { name: name2, apply: () => {
        } };
        return super.import(name2);
      }
    }
    hotTreeClass = InsightsHotTree;
  } catch {
    hotTreeClass = null;
  }
  return hotTreeClass;
}
function parseSimplePatch(patchText) {
  const rows = [];
  let pending = null;
  for (const raw of patchText.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (line.trim() === "") continue;
    if (/^-\s+insert:\s*$/.test(line)) continue;
    const id = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line);
    if (id !== null) {
      if (pending !== null) return null;
      pending = id[1];
      continue;
    }
    const name2 = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (name2 !== null && pending !== null) {
      rows.push({ id: pending, name: name2[1] });
      pending = null;
      continue;
    }
    return null;
  }
  if (pending !== null || rows.length === 0) return null;
  return rows;
}
function cleanHotDir(profileDir) {
  let entries;
  try {
    entries = readdirSync(join(profileDir, HOT_DIR));
  } catch {
    return;
  }
  for (const name2 of entries) {
    if (/^hot-\d+\.yml$/.test(name2)) rmSync(join(profileDir, HOT_DIR, name2), { force: true });
  }
}
var hotSequence = 0;
var hotHandles = /* @__PURE__ */ new Map();
var ActivationTimeout = class extends Error {
};
function raceActivationTimeout(awaitable) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new ActivationTimeout(`activation did not settle within ${HOT_MOUNT_TIMEOUT_MS / 1e3}s`));
    }, HOT_MOUNT_TIMEOUT_MS);
    Promise.resolve(awaitable).then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
function readPkgDsh(profileDir, packageName) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir, "node_modules", packageName, "package.json"), "utf8")
    );
    return manifest.dsh ?? {};
  } catch {
    return null;
  }
}
async function hotMount(ctx, profileDir, packageName) {
  try {
    const HotTree = await loadHotTreeClass();
    if (HotTree === null) {
      return { ok: false, reason: "host cannot hot-mount (include plugin unavailable); restart required" };
    }
    let patchText;
    try {
      patchText = readFileSync(join(profileDir, "node_modules", packageName, "cordis.patch.yml"), "utf8");
    } catch {
      patchText = null;
    }
    let rows;
    if (patchText !== null) {
      rows = parseSimplePatch(patchText);
      if (rows === null) {
        return { ok: false, reason: "bundle patch carries config/expression rows; hot-mount supports plain inserts only \u2014 activates on restart" };
      }
    } else {
      const dsh = readPkgDsh(profileDir, packageName);
      if (dsh === null || dsh.client === void 0 || dsh.bundle !== void 0) {
        return { ok: false, reason: "no bundle patch and no dsh.client surface \u2014 nothing to hot-mount" };
      }
      shimNames.add(packageName);
      rows = [{ id: `client-${packageName.replace(/[^A-Za-z0-9_.-]/g, "-")}`, name: packageName }];
    }
    const dir = join(profileDir, HOT_DIR);
    mkdirSync(dir, { recursive: true });
    hotSequence += 1;
    const file = join(dir, `hot-${String(hotSequence)}.yml`);
    writeFileSync(file, rows.map((row) => `- id: '${ID_PREFIX}${row.id}'
  name: '${row.name}'
`).join(""));
    const handle = ctx.plugin(HotTree, { path: pathToFileURL(file).href });
    try {
      await raceActivationTimeout(handle.await());
    } catch (error) {
      hotHandles.delete(packageName);
      shimNames.delete(packageName);
      try {
        await handle.dispose();
      } catch {
      }
      const reason = error instanceof ActivationTimeout ? "activation timed out (plugin may be waiting on a missing service); activates on restart" : `activation failed: ${error.message}`;
      return { ok: false, reason };
    }
    hotHandles.set(packageName, handle);
    return { ok: true, reason: null };
  } catch (error) {
    return { ok: false, reason: `hot-mount failed: ${error.message}` };
  }
}
async function hotMountAvailable() {
  return await loadHotTreeClass() !== null;
}
async function hotUnmount(packageName) {
  const handle = hotHandles.get(packageName);
  if (handle === void 0) return false;
  hotHandles.delete(packageName);
  shimNames.delete(packageName);
  try {
    await handle.dispose();
    return true;
  } catch {
    return false;
  }
}
async function disableEntry(loader, packageName) {
  if (loader === null) return false;
  let found = false;
  for (const entry of loader.entries()) {
    if (entry.options.name !== packageName) continue;
    try {
      await entry.update({ disabled: true }, false, true);
      found = true;
    } catch {
    }
  }
  return found;
}

// src/host/installed.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { join as join2, resolve } from "node:path";
var INBOX_BUNDLES = /* @__PURE__ */ new Set([
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-headless"
]);
function expandHomePath(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join2(homedir(), path.slice(2));
  return path;
}
function resolveDshHome(configured, env = process.env) {
  const fromEnv = env.DSH_HOME;
  const selected = configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : join2(homedir(), ".dsh"));
  return resolve(expandHomePath(selected));
}
function isDshProfileName(profile) {
  return profile !== "" && profile !== "." && profile !== ".." && profile !== "node_modules" && !profile.includes("/") && !profile.includes("\\") && !profile.includes("\0");
}
function activeProfile(env, argv) {
  const fromEnv = env.DSH_INSIGHTS_PROFILE;
  if (fromEnv !== void 0 && isDshProfileName(fromEnv)) return fromEnv;
  const flag = argv.indexOf("--profile");
  if (flag >= 0) {
    const value = argv[flag + 1];
    if (value !== void 0 && isDshProfileName(value)) return value;
  }
  return "web";
}
function resolveProfileDir(env = process.env, argv = process.argv) {
  const profile = activeProfile(env, argv);
  const explicitDir = env.DSH_INSIGHTS_PROFILE_DIR;
  const dir = explicitDir !== void 0 && explicitDir.trim().length > 0 ? resolve(expandHomePath(explicitDir)) : join2(resolveDshHome(void 0, env), "profiles", profile);
  return { profile, dir };
}
function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function readInstalledInventory(env = process.env, argv = process.argv) {
  const { profile, dir } = resolveProfileDir(env, argv);
  const empty = { profile, baseline: 0, plugins: [] };
  const manifest = readJson(join2(dir, "package.json"));
  if (manifest === null) return empty;
  const dshField = manifest.dsh;
  const bundlesRaw = typeof dshField === "object" && dshField !== null && !Array.isArray(dshField) ? dshField.profile : void 0;
  const bundlesValue = typeof bundlesRaw === "object" && bundlesRaw !== null && !Array.isArray(bundlesRaw) ? bundlesRaw.bundles : void 0;
  const bundles = Array.isArray(bundlesValue) ? new Set(bundlesValue.filter((name2) => typeof name2 === "string")) : null;
  const deps = manifest.dependencies;
  const depEntries = typeof deps === "object" && deps !== null && !Array.isArray(deps) ? Object.entries(deps) : [];
  const plugins = [];
  const seen = /* @__PURE__ */ new Set();
  let baseline = 0;
  for (const name2 of INBOX_BUNDLES) {
    if (bundles?.has(name2) || depEntries.some(([dep]) => dep === name2)) baseline += 1;
  }
  const rowFor = (name2, spec) => {
    let version = null;
    let plugin = false;
    const pkgPath = join2(dir, "node_modules", name2, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (pkg !== null) {
        if (typeof pkg.version === "string" && pkg.version) version = pkg.version;
        plugin = pkg.dsh !== void 0 || pkg.cordis !== void 0;
      }
    }
    return { name: name2, spec, version, plugin, enabled: bundles === null || bundles.has(name2) };
  };
  for (const [name2, spec] of depEntries) {
    if (INBOX_BUNDLES.has(name2)) continue;
    seen.add(name2);
    plugins.push(rowFor(name2, typeof spec === "string" ? spec : ""));
  }
  if (bundles !== null) {
    for (const name2 of bundles) {
      if (INBOX_BUNDLES.has(name2) || seen.has(name2)) continue;
      plugins.push(rowFor(name2, ""));
    }
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return { profile, baseline, plugins };
}

// src/host/ops.ts
import { spawn } from "node:child_process";
import { homedir as homedir2 } from "node:os";
import { readFileSync as readFileSync3, renameSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
var NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
function isValidPackageName(name2) {
  return name2.length > 0 && name2.length <= 214 && NPM_NAME_RE.test(name2) && !name2.startsWith("-");
}
var INBOX_BUNDLES2 = /* @__PURE__ */ new Set([
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-headless"
]);
function isMutablePackage(name2) {
  return isValidPackageName(name2) && !INBOX_BUNDLES2.has(name2) && !name2.startsWith("@deepseek-ai/");
}
function editBundles(profileDir, name2, op) {
  const file = join3(profileDir, "package.json");
  let manifest;
  try {
    const parsed = JSON.parse(readFileSync3(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    manifest = parsed;
  } catch {
    return false;
  }
  const dsh = typeof manifest.dsh === "object" && manifest.dsh !== null && !Array.isArray(manifest.dsh) ? { ...manifest.dsh } : {};
  const profile = typeof dsh.profile === "object" && dsh.profile !== null && !Array.isArray(dsh.profile) ? { ...dsh.profile } : {};
  const current = Array.isArray(profile.bundles) ? profile.bundles.filter((entry) => typeof entry === "string") : [];
  const next = op === "add" ? current.includes(name2) ? current : [...current, name2] : current.filter((entry) => entry !== name2);
  profile.bundles = next;
  dsh.profile = profile;
  manifest.dsh = dsh;
  const tmp = join3(profileDir, `package.json.dsh-insights-${process.pid}.tmp`);
  try {
    writeFileSync2(tmp, JSON.stringify(manifest, null, 2) + "\n");
    renameSync(tmp, file);
  } catch {
    return false;
  }
  return true;
}
var PNPM_PROBE_TIMEOUT_MS = 1e4;
var pnpmProbe = null;
function pnpmAvailable(env = process.env) {
  pnpmProbe ??= new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(env.DSH_INSIGHTS_PNPM ?? "pnpm", ["--version"], {
        cwd: homedir2(),
        env,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: PNPM_PROBE_TIMEOUT_MS
      });
    } catch {
      resolvePromise(false);
      return;
    }
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0));
  });
  return pnpmProbe;
}
var PNPM_TIMEOUT_MS = 18e4;
var TAIL_LIMIT = 2e3;
function runPnpm(profileDir, args, env = process.env) {
  const bin = env.DSH_INSIGHTS_PNPM ?? "pnpm";
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: profileDir, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolvePromise({ ok: false, status: "failed", detail: `spawn failed: ${error.message}` });
      return;
    }
    let out = "";
    const append = (chunk) => {
      out = (out + chunk.toString()).slice(-TAIL_LIMIT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise({ ok: false, status: "failed", detail: `pnpm timed out after ${PNPM_TIMEOUT_MS / 1e3}s
${out}` });
    }, PNPM_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, status: "failed", detail: `pnpm not runnable: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ ok: true, status: "done" });
      else resolvePromise({ ok: false, status: "failed", detail: out || `pnpm exited ${code}` });
    });
  });
}
async function installPackage(profileDir, name2, env) {
  const add = await runPnpm(profileDir, ["add", name2], env);
  if (!add.ok) return add;
  if (!editBundles(profileDir, name2, "add")) {
    await runPnpm(profileDir, ["remove", name2], env);
    return { ok: false, status: "failed", detail: "installed by pnpm but failed to append dsh.profile.bundles (rolled back)" };
  }
  return { ok: true, status: "done" };
}
async function uninstallPackage(profileDir, name2, env) {
  if (!editBundles(profileDir, name2, "remove")) {
    return { ok: false, status: "failed", detail: "failed to edit dsh.profile.bundles" };
  }
  const remove = await runPnpm(profileDir, ["remove", name2], env);
  if (!remove.ok) return { ok: false, status: "partial", detail: `disabled (removed from bundles) but pnpm remove failed: ${remove.detail}` };
  return { ok: true, status: "done" };
}
function findDependents(profileDir, target) {
  const manifestPath = join3(profileDir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync3(manifestPath, "utf8"));
  } catch {
    return [];
  }
  const deps = manifest.dependencies;
  const names = typeof deps === "object" && deps !== null && !Array.isArray(deps) ? Object.keys(deps) : [];
  const dependents = [];
  for (const name2 of names) {
    if (name2 === target) continue;
    try {
      const pkg = JSON.parse(readFileSync3(join3(profileDir, "node_modules", name2, "package.json"), "utf8"));
      if (pkg.dependencies !== void 0 && target in pkg.dependencies || pkg.peerDependencies !== void 0 && target in pkg.peerDependencies) {
        dependents.push(name2);
      }
    } catch {
    }
  }
  return dependents.sort();
}

// src/host/shell.ts
import { existsSync as existsSync2, readFileSync as readFileSync4, readdirSync as readdirSync2, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join as join4 } from "node:path";
function extractSeedWords(source) {
  const call = /staticModules:([A-Za-z_$][\w$]*)\(\)/.exec(source);
  if (!call) return null;
  const fn = call[1].replace(/[$]/g, "\\$&");
  const def = new RegExp(`function ${fn}\\(\\)\\{return\\{`).exec(source);
  if (!def) return null;
  const keys = [];
  let i = def.index + def[0].length;
  for (; ; ) {
    const entry = /^[\s,]*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*([A-Za-z_$][\w$]*)/.exec(source.slice(i, i + 240));
    if (!entry) return null;
    keys.push(entry[1] ?? entry[2] ?? entry[3]);
    i += entry[0].length;
    if (source[i] === "}") break;
    if (source[i] !== ",") return null;
  }
  return keys.length > 0 ? keys : null;
}
function extractRequires(bundleText) {
  const seen = /* @__PURE__ */ new Set();
  const pattern = /\b__require\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = pattern.exec(bundleText)) !== null) {
    const spec = match[1] ?? match[2];
    if (!spec.includes("${")) seen.add(spec);
  }
  return [...seen];
}
function stripClientSuffix(spec) {
  return spec.endsWith("/client") ? spec.slice(0, -"/client".length) : spec;
}
function readVersion(scopeDir) {
  for (const pkg of ["dsh-web-app", "dsh-base"]) {
    try {
      const parsed = JSON.parse(readFileSync4(join4(scopeDir, pkg, "package.json"), "utf8"));
      const version = parsed.version;
      if (typeof version === "string" && version) return version;
    } catch {
    }
  }
  return null;
}
function scopeFromRoot(root) {
  if (existsSync2(join4(root, "dsh-web-frontend", "dist", "assets"))) {
    return { scopeDir: root, version: readVersion(root) };
  }
  const nestedScope = join4(root, "node_modules", "@deepseek-ai");
  if (existsSync2(join4(nestedScope, "dsh-web-frontend", "dist", "assets"))) {
    return { scopeDir: nestedScope, version: readVersion(nestedScope) };
  }
  return null;
}
function resolveShellScope(env, argv) {
  const override = env.DSH_INSIGHTS_DSH_ROOT;
  if (override !== void 0 && override.trim() !== "") {
    return scopeFromRoot(override);
  }
  try {
    const require2 = createRequire(import.meta.url);
    const webAppPkg = require2.resolve("@deepseek-ai/dsh-web-app/package.json");
    const scopeDir = dirname(dirname(webAppPkg));
    if (existsSync2(join4(scopeDir, "dsh-web-frontend", "dist", "assets"))) {
      return { scopeDir, version: readVersion(scopeDir) };
    }
  } catch {
  }
  const entry = argv[1];
  if (typeof entry === "string" && entry !== "") {
    try {
      let dir = dirname(realpathSync(entry));
      for (let depth = 0; depth < 8; depth += 1) {
        const scopeDir = join4(dir, "node_modules", "@deepseek-ai");
        if (existsSync2(join4(scopeDir, "dsh-web-frontend", "dist", "assets"))) {
          return { scopeDir, version: readVersion(scopeDir) };
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
    }
  }
  return null;
}
var shellCache = null;
function seedFromScope(scope) {
  let assetPath = null;
  try {
    const assetsDir = join4(scope.scopeDir, "dsh-web-frontend", "dist", "assets");
    const asset = readdirSync2(assetsDir).filter((name2) => /^index-.*\.js$/.test(name2)).sort()[0];
    if (asset !== void 0) assetPath = join4(assetsDir, asset);
  } catch {
    return null;
  }
  if (assetPath === null) return null;
  let mtime = 0;
  try {
    mtime = statSync(assetPath).mtimeMs;
  } catch {
    return null;
  }
  const key = `${assetPath}:${mtime}`;
  if (shellCache !== null && shellCache.key === key) return shellCache.table;
  let table = null;
  try {
    const seedWords = extractSeedWords(readFileSync4(assetPath, "utf8"));
    if (seedWords !== null) table = { version: scope.version, seedWords, scopeDir: scope.scopeDir };
  } catch {
    table = null;
  }
  shellCache = { key, table };
  return table;
}
function readShellSeed(env = process.env, argv = process.argv) {
  const scope = resolveShellScope(env, argv);
  return scope === null ? null : seedFromScope(scope);
}
function hasClientSurface(pkgDir) {
  try {
    const parsed = JSON.parse(readFileSync4(join4(pkgDir, "package.json"), "utf8"));
    const dsh = parsed.dsh;
    return typeof dsh === "object" && dsh !== null && dsh.client !== void 0;
  } catch {
    return false;
  }
}
function collectRowIds(profileDir, scopeDir) {
  const ids = /* @__PURE__ */ new Set();
  const scan = (baseDir, scoped) => {
    let entries;
    try {
      entries = readdirSync2(baseDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (scoped && entry.startsWith("@")) {
        scan(join4(baseDir, entry), false);
        continue;
      }
      if (hasClientSurface(join4(baseDir, entry))) {
        try {
          const parsed = JSON.parse(readFileSync4(join4(baseDir, entry, "package.json"), "utf8"));
          const name2 = parsed.name;
          if (typeof name2 === "string" && name2) ids.add(name2);
        } catch {
        }
      }
    }
  };
  scan(join4(profileDir, "node_modules"), true);
  if (scopeDir !== null) scan(scopeDir, false);
  return ids;
}
function clientBundlePath(pkgDir) {
  try {
    const parsed = JSON.parse(readFileSync4(join4(pkgDir, "package.json"), "utf8"));
    const pkg = parsed;
    const client = pkg.exports?.["./client"];
    const rel = typeof client === "string" ? client : typeof client === "object" && client !== null ? client.import ?? client.default : null;
    if (typeof rel === "string" && rel !== "") return join4(pkgDir, rel);
  } catch {
  }
  const conventional = join4(pkgDir, "lib", "client.js");
  return existsSync2(conventional) ? conventional : null;
}
function checkClientCompat(env = process.env, argv = process.argv) {
  const shell = readShellSeed(env, argv);
  if (shell === null) return { shell: null, rows: [] };
  const { dir } = resolveProfileDir(env, argv);
  const seed = new Set(shell.seedWords);
  const rowIds = collectRowIds(dir, shell.scopeDir);
  const inventory = readInstalledInventory(env, argv);
  const rows = [];
  for (const plugin of inventory.plugins) {
    if (!plugin.enabled) continue;
    const pkgDir = join4(dir, "node_modules", plugin.name);
    if (!hasClientSurface(pkgDir)) {
      rows.push({ name: plugin.name, status: "no-client", requires: [], missing: [] });
      continue;
    }
    const bundlePath = clientBundlePath(pkgDir);
    if (bundlePath === null) {
      rows.push({ name: plugin.name, status: "unknown", requires: [], missing: [] });
      continue;
    }
    let requires;
    try {
      requires = extractRequires(readFileSync4(bundlePath, "utf8"));
    } catch {
      rows.push({ name: plugin.name, status: "unknown", requires: [], missing: [] });
      continue;
    }
    const missing = requires.filter((spec) => !seed.has(spec) && !rowIds.has(stripClientSuffix(spec)));
    rows.push({ name: plugin.name, status: missing.length > 0 ? "broken" : "ok", requires, missing });
  }
  return { shell: { version: shell.version, seedWords: shell.seedWords }, rows };
}

// src/host/drops.ts
var TABLE = [
  ["docs.no-readme", "fail", "\u65E0 README", "no README"],
  ["npm.unpublished", "major", "\u672A\u53D1\u5E03\u5230 npm\uFF08\u65E0\u6CD5\u4E00\u952E\u5B89\u88C5\uFF09", "not published to npm (no one-line install)"],
  ["maint.single-push", "major", "\u4E00\u6B21\u6027\u5BFC\u5165\u540E\u518D\u65E0\u7EF4\u62A4\uFF08\u521B\u5EFA\u2248\u6700\u540E push\uFF09", "imported once, never maintained (created \u2248 last push)"],
  ["discover.batch-import", "warn", "\u7591\u4F3C\u6279\u91CF\u6A21\u677F\u5BFC\u5165\uFF08\u540C\u8D26\u53F7\u5927\u91CF\u4E00\u6B21\u6027\u4ED3\u5E93\uFF09", "suspected batch template import"],
  ["manifest.no-client-export", "warn", 'package.json \u7F3A\u5931 exports["./client"]', 'package.json misses exports["./client"]'],
  ["npm.version-drift", "warn", "npm latest \u2260 \u4ED3\u5E93 version\uFF08\u7248\u672C\u9519\u914D\uFF09", "npm latest \u2260 repo version (drift)"],
  ["npm.release-stale", "warn", "npm \u6700\u8FD1\u53D1\u5E03\u8DDD\u4ECA\u8D85\u8FC7 90 \u5929", "latest npm release older than 90 days"],
  ["docs.zh-missing", "warn", "\u65E0\u4E2D\u6587/\u53CC\u8BED\u6587\u6863", "no Chinese/bilingual docs"],
  ["docs.no-description", "warn", "\u4ED3\u5E93\u65E0 description", "repository has no description"],
  ["repo.no-license", "warn", "\u65E0 LICENSE", "no LICENSE"],
  ["repo.no-dsh-topic", "warn", "topics \u975E\u7A7A\u4F46\u65E0 dsh-plugin\uFF08\u53EF\u53D1\u73B0\u6027\uFF09", "topics set but missing dsh-plugin (discoverability)"],
  ["activity.too-young", "warn", "\u4ED3\u5E93\u521B\u5EFA\u4E0D\u8DB3 1 \u5929", "repository younger than 1 day"],
  ["activity.dormant", "warn", "\u95F2\u7F6E\u8D85\u8FC7 30 \u5929", "dormant for over 30 days"],
  ["eng.no-tests", "warn", "\u65E0\u6D4B\u8BD5\u76EE\u5F55/\u6D4B\u8BD5\u6587\u4EF6", "no test directory or test files"],
  ["manifest.not-lib-main", "minor", "main \u4E0D\u662F lib/index.js", "main is not lib/index.js"],
  ["manifest.no-files-whitelist", "minor", "package.json \u65E0 files \u767D\u540D\u5355", "package.json has no files whitelist"],
  ["repo.sparse-topics", "minor", "topics \u4EC5 1 \u4E2A\uFF08\u53EF\u53D1\u73B0\u9762\u7A84\uFF09", "only one topic (narrow discoverability)"],
  ["npm.single-release", "minor", "npm \u4EC5 1 \u4E2A\u53D1\u5E03\u7248\u672C", "only one npm release"],
  ["eng.no-ci", "minor", "\u65E0 .github/workflows\uFF08\u65E0 CI\uFF09", "no .github/workflows (no CI)"],
  ["docs.no-docs-dir", "minor", "\u65E0 docs/ \u76EE\u5F55", "no docs/ directory"],
  ["docs.tiny-readme", "minor", "README \u5C0F\u4E8E 400 \u5B57\u8282", "README smaller than 400 bytes"]
];
var BY_CODE = new Map(
  TABLE.map(([code, sev, zh, en]) => [code, { code, sev, label: { zh, en } }])
);
function enrichDrop(code) {
  return BY_CODE.get(code) ?? { code, sev: "warn", label: { zh: code, en: code } };
}
function enrichDrops(codes) {
  return codes.map(enrichDrop);
}

// src/host/upstream.ts
var DEFAULT_BASE_URL = "https://dsh-insights.com/data";
var DEFAULT_TTL_MS = 6 * 60 * 60 * 1e3;
var DEFAULT_DOC_URLS = {
  insights: `${DEFAULT_BASE_URL}/insights.json`,
  scenarios: `${DEFAULT_BASE_URL}/scenarios.json`,
  dynamics: `${DEFAULT_BASE_URL}/dynamics.json`,
  compat: `${DEFAULT_BASE_URL}/compat.json`,
  enrich: `${DEFAULT_BASE_URL}/enrich.json`
};
function compatByNpm(doc) {
  const map = /* @__PURE__ */ new Map();
  const plugins = doc?.plugins;
  if (!Array.isArray(plugins)) return map;
  for (const row of plugins) {
    if (!row || typeof row.pkgName !== "string" || !row.pkgName) continue;
    map.set(row.pkgName.toLowerCase(), {
      enginesDsh: typeof row.enginesDsh === "string" && row.enginesDsh ? row.enginesDsh : null,
      dshPeers: (Array.isArray(row.dshPeers) ? row.dshPeers : []).filter((p) => p && typeof p.name === "string" && typeof p.range === "string").slice(0, 3)
    });
  }
  return map;
}
function similarByCategory(doc, fullName, limit = 5) {
  const rows = Array.isArray(doc) ? doc : Array.isArray(doc?.plugins) ? doc.plugins : [];
  const target = fullName.toLowerCase();
  const self = rows.find((r) => r.full_name?.toLowerCase() === target);
  if (!self || typeof self.category !== "string" || !self.category) return [];
  return rows.filter((r) => r.category === self.category && r.full_name && r.full_name.toLowerCase() !== target).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.stars ?? 0) - (a.stars ?? 0)).slice(0, limit).map((r) => ({
    full_name: r.full_name,
    grade: typeof r.grade === "string" ? r.grade : null,
    score: typeof r.score === "number" ? r.score : null,
    stars: typeof r.stars === "number" ? r.stars : 0
  }));
}
function trimPlugin(p) {
  return {
    full_name: p.full_name,
    url: p.url ?? null,
    stars: p.stars ?? 0,
    grade: p.health?.grade ?? null,
    score: p.health?.score ?? null,
    dimScores: p.health?.dimScores ?? {},
    drops: enrichDrops(p.health?.drops ?? []),
    npm: p.pkgName ?? null,
    version: p.version ?? p.npm?.latest ?? null,
    npmLatest: p.npm?.latest ?? null,
    description: p.description ?? null
  };
}
function trimSearchHit(p) {
  return {
    full_name: p.full_name,
    url: p.url ?? null,
    stars: p.stars ?? 0,
    grade: p.health?.grade ?? null,
    score: p.health?.score ?? null,
    npm: p.pkgName ?? null,
    version: p.version ?? p.npm?.latest ?? null,
    description: p.description ?? null
  };
}
function searchPlugins(plugins, query, limit) {
  const q = query.trim().toLowerCase();
  if (!q) return { total: 0, results: [] };
  const matched = plugins.filter(
    (p) => p.full_name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q)
  );
  matched.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || a.full_name.localeCompare(b.full_name));
  return { total: matched.length, results: matched.slice(0, limit).map(trimSearchHit) };
}
function auditByNpm(plugins, names) {
  const byNpm = /* @__PURE__ */ new Map();
  for (const p of plugins) {
    if (p.pkgName) byNpm.set(p.pkgName.toLowerCase(), p);
  }
  const out = {};
  for (const raw of names) {
    const name2 = raw.trim().toLowerCase();
    if (!name2) continue;
    const hit = byNpm.get(name2);
    out[raw.trim()] = hit ? trimPlugin(hit) : null;
  }
  return out;
}
var UpstreamError = class extends Error {
  url;
  constructor(url, message) {
    super(message);
    this.url = url;
  }
};
async function defaultFetchJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new UpstreamError(url, `fetch failed: ${error.message}`);
  }
  if (!res.ok) throw new UpstreamError(url, `upstream responded HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new UpstreamError(url, "upstream returned non-JSON body");
  }
}
function createStore(options = {}) {
  const baseUrl = options.baseUrl?.replace(/\/+$/, "");
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const now = options.now ?? Date.now;
  const cache = /* @__PURE__ */ new Map();
  const inflight = /* @__PURE__ */ new Map();
  function docUrl(name2) {
    return baseUrl ? `${baseUrl}/${name2}.json` : DEFAULT_DOC_URLS[name2] ?? `${DEFAULT_BASE_URL}/${name2}.json`;
  }
  async function load(name2) {
    const hit = cache.get(name2);
    if (hit && now() - hit.fetchedAt < ttlMs) return hit.data;
    const pending = inflight.get(name2);
    if (pending) return pending;
    const task = fetchJson(docUrl(name2)).then((data) => {
      cache.set(name2, { data, fetchedAt: now() });
      return data;
    }).finally(() => inflight.delete(name2));
    inflight.set(name2, task);
    return task;
  }
  async function insights() {
    const data = await load("insights");
    return { generatedAt: data.generatedAt, plugins: Array.isArray(data.plugins) ? data.plugins : [] };
  }
  return {
    insights,
    scenarios: () => load("scenarios"),
    dynamics: () => load("dynamics"),
    compat: () => load("compat"),
    enrich: () => load("enrich"),
    status() {
      const names = ["insights", "scenarios", "dynamics", "compat", "enrich"];
      const out = {};
      for (const name2 of names) {
        const hit = cache.get(name2);
        const ageMs = hit ? now() - hit.fetchedAt : null;
        out[name2] = { cached: hit !== void 0, ageMs, stale: ageMs !== null && ageMs >= ttlMs };
      }
      return out;
    }
  };
}

// src/host/index.ts
var name = "insights";
var inject = ["webServer"];
var PREFIX = "/dsh-insights";
var MAX_SEARCH_LIMIT = 50;
var MAX_AUDIT_NAMES = 100;
var startedAt = Date.now();
function wireError(code, message) {
  return { code, message };
}
var dshVersionCache;
function dshVersion() {
  if (dshVersionCache !== void 0) return dshVersionCache;
  const require2 = createRequire2(import.meta.url);
  for (const pkg of ["@deepseek-ai/dsh-web-app/package.json", "@deepseek-ai/dsh-base/package.json"]) {
    try {
      const { version } = require2(pkg);
      if (typeof version === "string" && version) {
        dshVersionCache = version;
        return version;
      }
    } catch {
    }
  }
  dshVersionCache = null;
  return null;
}
function apply(raw) {
  const ctx = raw;
  const log = ctx.logger("insights");
  log.info("dsh-insights-kit loaded (host /dsh-insights routes)");
  const store = createStore({
    baseUrl: process.env.DSH_INSIGHTS_UPSTREAM_BASE || void 0
  });
  try {
    cleanHotDir(resolveProfileDir().dir);
  } catch {
  }
  let loaderRef = null;
  try {
    ctx.inject(["loader"], (child) => {
      loaderRef = child.loader ?? null;
    });
  } catch {
  }
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: PREFIX,
    handler: (req, res) => void handleRequest(req, res, store, log, () => loaderRef, ctx)
  }));
  log.info("registered GET /dsh-insights/{plugin,search,audit,scenarios,dynamics,runtime,installed,compat,health} + POST install/uninstall (hot-mount capable)");
}
async function handleRequest(req, res, store, log, getLoader, hotCtx) {
  if (!trusted(req)) {
    sendJson(res, 403, { ok: false, error: wireError("forbidden", "untrusted host/origin") });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const mutationOp = pathname === `${PREFIX}/install` ? "install" : pathname === `${PREFIX}/uninstall` ? "uninstall" : null;
  if (mutationOp !== null ? req.method !== "POST" : req.method !== "GET") {
    sendJson(res, 405, {
      ok: false,
      error: wireError("method-not-allowed", mutationOp !== null ? "POST only for install/uninstall" : "only GET is served here")
    });
    return;
  }
  try {
    if (mutationOp !== null) {
      await handleMutation(req, res, store, mutationOp, getLoader, hotCtx);
      return;
    }
    if (pathname === `${PREFIX}/plugin`) {
      const fullName = (url.searchParams.get("full_name") ?? "").trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
        sendJson(res, 400, { ok: false, error: wireError("invalid-query", "missing or malformed ?full_name=owner/repo") });
        return;
      }
      const data = await store.insights();
      const plugin = data.plugins.find((p) => p.full_name.toLowerCase() === fullName.toLowerCase());
      if (!plugin) {
        sendJson(res, 404, {
          ok: false,
          error: wireError("not-in-corpus", `${fullName} is not in the DSH Insights authoritative corpus`)
        });
        return;
      }
      const enrichDoc = await store.enrich().catch(() => null);
      sendJson(res, 200, {
        ok: true,
        generatedAt: data.generatedAt ?? null,
        plugin: trimPlugin(plugin),
        similar: similarByCategory(enrichDoc, plugin.full_name)
      });
      return;
    }
    if (pathname === `${PREFIX}/search`) {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) {
        sendJson(res, 400, { ok: false, error: wireError("invalid-query", "missing ?q=") });
        return;
      }
      const rawLimit = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_SEARCH_LIMIT) : 20;
      const data = await store.insights();
      const { total, results } = searchPlugins(data.plugins, q, limit);
      sendJson(res, 200, { ok: true, q, total, limit, results });
      return;
    }
    if (pathname === `${PREFIX}/audit`) {
      const names = (url.searchParams.get("npm") ?? "").split(",").map((name2) => name2.trim()).filter((name2) => name2.length > 0).slice(0, MAX_AUDIT_NAMES);
      if (names.length === 0) {
        sendJson(res, 400, { ok: false, error: wireError("invalid-query", "missing ?npm=name1,name2,\u2026") });
        return;
      }
      const data = await store.insights();
      const results = auditByNpm(data.plugins, names);
      const compatDoc = await store.compat().catch(() => null);
      const compat = compatByNpm(compatDoc);
      const annotated = {};
      for (const name2 of names) {
        const card = results[name2];
        annotated[name2] = card ? { ...card, compat: compat.get(name2.toLowerCase()) ?? null } : null;
      }
      sendJson(res, 200, {
        ok: true,
        generatedAt: data.generatedAt ?? null,
        results: annotated
      });
      return;
    }
    if (pathname === `${PREFIX}/scenarios`) {
      const doc = await store.scenarios();
      const data = await store.insights();
      const pkgByRepo = /* @__PURE__ */ new Map();
      for (const p of data.plugins) {
        if (p.pkgName) pkgByRepo.set(p.full_name.toLowerCase(), p.pkgName);
      }
      const scenarios = (doc.scenarios ?? []).map((scenario) => ({
        ...scenario,
        plugins: (scenario.plugins ?? []).map((plugin) => {
          const pkgName = pkgByRepo.get((plugin.full_name ?? "").toLowerCase());
          return pkgName ? { ...plugin, pkgName } : plugin;
        })
      }));
      sendJson(res, 200, { ok: true, scenarios: { ...doc, scenarios } });
      return;
    }
    if (pathname === `${PREFIX}/dynamics`) {
      sendJson(res, 200, { ok: true, dynamics: await store.dynamics() });
      return;
    }
    if (pathname === `${PREFIX}/runtime`) {
      sendJson(res, 200, { ok: true, dsh: { version: dshVersion() } });
      return;
    }
    if (pathname === `${PREFIX}/installed`) {
      sendJson(res, 200, { ok: true, ...readInstalledInventory() });
      return;
    }
    if (pathname === `${PREFIX}/compat`) {
      sendJson(res, 200, { ok: true, compat: checkClientCompat() });
      return;
    }
    if (pathname === `${PREFIX}/health`) {
      sendJson(res, 200, {
        ok: true,
        plugin: "dsh-insights-kit",
        uptimeMs: Date.now() - startedAt,
        caches: store.status(),
        // The client renders one-click install/uninstall buttons only when
        // this is true (kill switch off AND pnpm runnable); older builds lack
        // the routes entirely and the client falls back to copy-commands.
        mutations: !mutationsDisabled() && await pnpmAvailable(),
        // Whether this host build can activate mutations without a restart
        // (the vendored include plugin importable). False → install/uninstall
        // still work, they just need a `dsh web` restart.
        hotMount: await hotMountAvailable()
      });
      return;
    }
    if (pathname === PREFIX) {
      sendJson(res, 200, {
        ok: true,
        plugin: "dsh-insights-kit",
        endpoints: [
          "/dsh-insights/plugin?full_name=owner/repo",
          "/dsh-insights/search?q=&limit=",
          "/dsh-insights/audit?npm=a,b,c",
          "/dsh-insights/scenarios",
          "/dsh-insights/dynamics",
          "/dsh-insights/runtime",
          "/dsh-insights/installed",
          "/dsh-insights/compat",
          "/dsh-insights/health",
          "POST /dsh-insights/install",
          "POST /dsh-insights/uninstall"
        ]
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: wireError("not-found", `unknown endpoint ${url.pathname}`) });
  } catch (error) {
    if (error instanceof UpstreamError) {
      log.info("upstream fetch failed", error.url, error.message);
      sendJson(res, 502, { ok: false, error: wireError("upstream", error.message) });
      return;
    }
    log.info("request failed", url.pathname, error.message);
    sendJson(res, 500, { ok: false, error: wireError("internal", error.message) });
  }
}
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function mutationsDisabled(env = process.env) {
  const value = env.DSH_INSIGHTS_NO_MUTATE;
  return value !== void 0 && value !== "" && value !== "0";
}
var MUTATION_HEADER = "x-dsh-insights-kit";
var MAX_BODY_BYTES = 4096;
function readJsonBody(req) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolvePromise(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolvePromise(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null);
      } catch {
        resolvePromise(null);
      }
    });
    req.on("error", () => resolvePromise(null));
  });
}
async function handleMutation(req, res, store, op, getLoader, hotCtx) {
  if (mutationsDisabled()) {
    sendJson(res, 403, { ok: false, error: wireError("mutations-disabled", "mutations disabled (DSH_INSIGHTS_NO_MUTATE)") });
    return;
  }
  if (req.headers[MUTATION_HEADER] !== "mutate") {
    sendJson(res, 403, { ok: false, error: wireError("mutation-header-required", `missing ${MUTATION_HEADER}: mutate`) });
    return;
  }
  const body = await readJsonBody(req);
  const name2 = typeof body?.name === "string" ? body.name.trim() : "";
  if (!isMutablePackage(name2)) {
    sendJson(res, 400, { ok: false, error: wireError("invalid-name", "name must be a non-official npm package name") });
    return;
  }
  const { profile, dir } = resolveProfileDir();
  if (!existsSync3(join5(dir, "package.json"))) {
    sendJson(res, 500, { ok: false, error: wireError("profile-missing", `profile ${profile} has no manifest at ${dir}`) });
    return;
  }
  const inventory = readInstalledInventory();
  const installed = inventory.plugins.some((plugin) => plugin.name.toLowerCase() === name2.toLowerCase());
  if (op === "install") {
    if (installed) {
      sendJson(res, 200, { ok: true, name: name2, op, status: "done", note: "already-installed", restartRequired: false });
      return;
    }
    const data = await store.insights();
    const known = data.plugins.some((plugin) => plugin.pkgName?.toLowerCase() === name2.toLowerCase());
    if (!known) {
      sendJson(res, 400, { ok: false, error: wireError("not-in-corpus", `${name2} is not a plugin package in the dsh-insights corpus`) });
      return;
    }
    const result2 = await installPackage(dir, name2);
    if (!result2.ok) {
      sendJson(res, 500, { ok: result2.ok, name: name2, op, status: result2.status, detail: result2.detail, restartRequired: false });
      return;
    }
    const hot = await hotMount(hotCtx, dir, name2);
    sendJson(res, 200, {
      ok: true,
      name: name2,
      op,
      status: "done",
      hot: hot.ok,
      detail: hot.reason ?? void 0,
      restartRequired: !hot.ok
    });
    return;
  }
  if (!installed) {
    sendJson(res, 404, { ok: false, error: wireError("not-installed", `${name2} is not installed in profile ${profile}`) });
    return;
  }
  const dependents = findDependents(dir, name2);
  if (dependents.length > 0) {
    sendJson(res, 409, {
      ok: false,
      error: wireError("has-dependents", `${name2} is a dependency of: ${dependents.join(", ")}`),
      dependents
    });
    return;
  }
  const liveOff = await hotUnmount(name2) || await disableEntry(getLoader(), name2);
  const result = await uninstallPackage(dir, name2);
  const code = result.ok ? 200 : result.status === "partial" ? 200 : 500;
  sendJson(res, code, {
    ok: result.ok,
    name: name2,
    op,
    status: result.status,
    hot: liveOff,
    detail: result.detail,
    restartRequired: result.status === "failed" ? false : !liveOff
  });
}
function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  const trimmed = hostHeader.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end < 0 ? null : trimmed.slice(1, end).toLowerCase();
  }
  const colon = trimmed.lastIndexOf(":");
  const host = colon < 0 ? trimmed : trimmed.slice(0, colon);
  return host.toLowerCase() || null;
}
function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1" || /^127(\.\d{1,3}){3}$/.test(hostname);
}
function trusted(req) {
  const host = hostnameOf(req.headers.host);
  if (host && isLoopbackHostname(host)) return true;
  const origin = req.headers.origin;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.hostname.toLowerCase() !== host) return false;
    const hostHeader = req.headers.host ?? "";
    if (hostHeader.includes(":")) {
      const portOfHost = hostnameOf(hostHeader) ? parsed.port || (parsed.protocol === "https:" ? "443" : "80") : "";
      const expected = hostHeader.slice(hostHeader.lastIndexOf(":") + 1);
      return portOfHost === expected || !expected && parsed.port === "";
    }
    return parsed.port === "";
  } catch {
    return false;
  }
}
export {
  apply,
  inject,
  name
};
