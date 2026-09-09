#!/usr/bin/env node

// src/host/selfcheck.ts
import { existsSync as existsSync3, readFileSync as readFileSync3, readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { isAbsolute, join as join3, relative, resolve as resolve2 } from "node:path";

// src/host/shell.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join as join2 } from "node:path";

// src/host/installed.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
var INBOX_BUNDLES = /* @__PURE__ */ new Set([
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-headless"
]);
function expandHomePath(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}
function resolveDshHome(configured, env = process.env) {
  const fromEnv = env.DSH_HOME;
  const selected = configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), ".dsh"));
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
  const dir = explicitDir !== void 0 && explicitDir.trim().length > 0 ? resolve(expandHomePath(explicitDir)) : join(resolveDshHome(void 0, env), "profiles", profile);
  return { profile, dir };
}
function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function readInstalledInventory(env = process.env, argv = process.argv) {
  const { profile, dir } = resolveProfileDir(env, argv);
  const empty = { profile, baseline: 0, plugins: [] };
  const manifest = readJson(join(dir, "package.json"));
  if (manifest === null) return empty;
  const dshField = manifest.dsh;
  const bundlesRaw = typeof dshField === "object" && dshField !== null && !Array.isArray(dshField) ? dshField.profile : void 0;
  const bundlesValue = typeof bundlesRaw === "object" && bundlesRaw !== null && !Array.isArray(bundlesRaw) ? bundlesRaw.bundles : void 0;
  const bundles = Array.isArray(bundlesValue) ? new Set(bundlesValue.filter((name) => typeof name === "string")) : null;
  const deps = manifest.dependencies;
  const depEntries = typeof deps === "object" && deps !== null && !Array.isArray(deps) ? Object.entries(deps) : [];
  const plugins = [];
  const seen = /* @__PURE__ */ new Set();
  let baseline = 0;
  for (const name of INBOX_BUNDLES) {
    if (bundles?.has(name) || depEntries.some(([dep]) => dep === name)) baseline += 1;
  }
  const rowFor = (name, spec) => {
    let version = null;
    let plugin = false;
    const pkgPath = join(dir, "node_modules", name, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (pkg !== null) {
        if (typeof pkg.version === "string" && pkg.version) version = pkg.version;
        plugin = pkg.dsh !== void 0 || pkg.cordis !== void 0;
      }
    }
    return { name, spec, version, plugin, enabled: bundles === null || bundles.has(name) };
  };
  for (const [name, spec] of depEntries) {
    if (INBOX_BUNDLES.has(name)) continue;
    seen.add(name);
    plugins.push(rowFor(name, typeof spec === "string" ? spec : ""));
  }
  if (bundles !== null) {
    for (const name of bundles) {
      if (INBOX_BUNDLES.has(name) || seen.has(name)) continue;
      plugins.push(rowFor(name, ""));
    }
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return { profile, baseline, plugins };
}

// src/host/shell.ts
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
      const parsed = JSON.parse(readFileSync2(join2(scopeDir, pkg, "package.json"), "utf8"));
      const version = parsed.version;
      if (typeof version === "string" && version) return version;
    } catch {
    }
  }
  return null;
}
function scopeFromRoot(root) {
  if (existsSync2(join2(root, "dsh-web-frontend", "dist", "assets"))) {
    return { scopeDir: root, version: readVersion(root) };
  }
  const nestedScope = join2(root, "node_modules", "@deepseek-ai");
  if (existsSync2(join2(nestedScope, "dsh-web-frontend", "dist", "assets"))) {
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
    if (existsSync2(join2(scopeDir, "dsh-web-frontend", "dist", "assets"))) {
      return { scopeDir, version: readVersion(scopeDir) };
    }
  } catch {
  }
  const entry = argv[1];
  if (typeof entry === "string" && entry !== "") {
    try {
      let dir = dirname(realpathSync(entry));
      for (let depth = 0; depth < 8; depth += 1) {
        const scopeDir = join2(dir, "node_modules", "@deepseek-ai");
        if (existsSync2(join2(scopeDir, "dsh-web-frontend", "dist", "assets"))) {
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
    const assetsDir = join2(scope.scopeDir, "dsh-web-frontend", "dist", "assets");
    const asset = readdirSync(assetsDir).filter((name) => /^index-.*\.js$/.test(name)).sort()[0];
    if (asset !== void 0) assetPath = join2(assetsDir, asset);
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
    const seedWords = extractSeedWords(readFileSync2(assetPath, "utf8"));
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
function wellKnownRoots(env) {
  const dirs = [
    "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh",
    "/usr/local/lib/node_modules/@deepseek-ai/dsh",
    "/usr/lib/node_modules/@deepseek-ai/dsh"
  ];
  if (typeof env.APPDATA === "string" && env.APPDATA !== "") {
    dirs.push(join2(env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh"));
  }
  return dirs;
}
function readShellSeedLoose(env = process.env, argv = process.argv) {
  const strict = readShellSeed(env, argv);
  if (strict !== null) return strict;
  for (const root of wellKnownRoots(env)) {
    const scope = scopeFromRoot(root);
    if (scope === null) continue;
    const table = seedFromScope(scope);
    if (table !== null) return table;
  }
  return null;
}
function hasClientSurface(pkgDir) {
  try {
    const parsed = JSON.parse(readFileSync2(join2(pkgDir, "package.json"), "utf8"));
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
      entries = readdirSync(baseDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (scoped && entry.startsWith("@")) {
        scan(join2(baseDir, entry), false);
        continue;
      }
      if (hasClientSurface(join2(baseDir, entry))) {
        try {
          const parsed = JSON.parse(readFileSync2(join2(baseDir, entry, "package.json"), "utf8"));
          const name = parsed.name;
          if (typeof name === "string" && name) ids.add(name);
        } catch {
        }
      }
    }
  };
  scan(join2(profileDir, "node_modules"), true);
  if (scopeDir !== null) scan(scopeDir, false);
  return ids;
}
function clientBundlePath(pkgDir) {
  try {
    const parsed = JSON.parse(readFileSync2(join2(pkgDir, "package.json"), "utf8"));
    const pkg = parsed;
    const client = pkg.exports?.["./client"];
    const rel = typeof client === "string" ? client : typeof client === "object" && client !== null ? client.import ?? client.default : null;
    if (typeof rel === "string" && rel !== "") return join2(pkgDir, rel);
  } catch {
  }
  const conventional = join2(pkgDir, "lib", "client.js");
  return existsSync2(conventional) ? conventional : null;
}
function checkClientCompat(env = process.env, argv = process.argv) {
  const shell = readShellSeedLoose(env, argv);
  if (shell === null) return { shell: null, rows: [] };
  const { dir } = resolveProfileDir(env, argv);
  const seed = new Set(shell.seedWords);
  const rowIds = collectRowIds(dir, shell.scopeDir);
  const inventory = readInstalledInventory(env, argv);
  const rows = [];
  for (const plugin of inventory.plugins) {
    if (!plugin.enabled) continue;
    const pkgDir = join2(dir, "node_modules", plugin.name);
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
      requires = extractRequires(readFileSync2(bundlePath, "utf8"));
    } catch {
      rows.push({ name: plugin.name, status: "unknown", requires: [], missing: [] });
      continue;
    }
    const missing = requires.filter((spec) => !seed.has(spec) && !rowIds.has(stripClientSuffix(spec)));
    rows.push({ name: plugin.name, status: missing.length > 0 ? "broken" : "ok", requires, missing });
  }
  return { shell: { version: shell.version, seedWords: shell.seedWords }, rows };
}

// src/host/selfcheck.ts
var DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
var SelfcheckError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var FIX = {
  "docs.no-readme": { zh: "\u8865\u4E00\u4EFD README.md\uFF1A\u63D2\u4EF6\u662F\u4EC0\u4E48 / \u529F\u80FD / \u5B89\u88C5\uFF08npm + \u624B\u52A8\uFF09/ \u622A\u56FE / \u5F00\u53D1\u547D\u4EE4\u3002", en: "Add a README.md: what it is, features, install (npm + manual), screenshots, dev commands." },
  "docs.tiny-readme": { zh: "README \u5C0F\u4E8E 400 \u5B57\u8282\uFF0C\u8865\u9F50\u529F\u80FD\u8BF4\u660E\u4E0E\u5B89\u88C5\u6B65\u9AA4\u3002", en: "README is under 400 bytes \u2014 flesh out features and install steps." },
  "docs.zh-missing": { zh: "\u8865 README.zh-CN.md\uFF08\u751F\u6001\u60EF\u4F8B\u4E2D\u82F1\u53CC\u8BED\uFF09\u3002", en: "Add README.zh-CN.md (the ecosystem convention is bilingual docs)." },
  "docs.no-description": { zh: "\u5728 package.json \u5199\u4E00\u53E5 description\uFF08\u4ED3\u5E93/\u5305\u9875\u9762\u7684\u7B2C\u4E00\u5C55\u793A\u4F4D\uFF09\u3002", en: "Write a one-line description in package.json (the first thing repo/package pages show)." },
  "docs.no-docs-dir": { zh: "\u5EFA docs/ \u653E\u4E00\u4EFD\u7B80\u77ED\u67B6\u6784\u8BF4\u660E\uFF08\u5982 DESIGN.md\uFF09\u3002", en: "Create docs/ with a short architecture note (e.g. DESIGN.md)." },
  "npm.unpublished": { zh: "npm publish \u53D1\u5E03\u5305\uFF08\u65E0\u6CD5\u4E00\u952E\u5B89\u88C5\u662F\u6838\u5FC3\u53EF\u7528\u6027\uFF09\u3002", en: "Run npm publish (one-line install is core usability)." },
  "npm.version-drift": { zh: "\u8BA9\u4ED3\u5E93 version \u4E0E npm latest \u4E00\u81F4\uFF08\u53D1\u7248\u524D\u5148 bump \u518D publish\uFF09\u3002", en: "Align the repo version with npm latest (bump before publish)." },
  "npm.single-release": { zh: "npm \u4EC5 1 \u4E2A\u7248\u672C\uFF1B\u6301\u7EED\u8FED\u4EE3\u53D1\u7248\u5373\u53EF\u6D88\u9664\u3002", en: "Only one npm release; it clears as you keep shipping." },
  "npm.release-stale": { zh: "npm \u6700\u8FD1\u53D1\u5E03\u8D85\u8FC7 90 \u5929\uFF1B\u53D1\u4E00\u4E2A\u7EF4\u62A4\u7248\u672C\uFF08\u54EA\u6015 patch\uFF09\u3002", en: "Latest npm release is over 90 days old; ship a maintenance release (even a patch)." },
  "manifest.no-client-export": { zh: '\u5728 exports \u589E\u52A0 "./client" \u6307\u5411 lib/client.js\uFF08web \u5F62\u6001\u63D2\u4EF6\u5FC5\u9700\uFF1BTUI/CLI \u5F62\u6001\u53EF\u5FFD\u7565\uFF09\u3002', en: 'Add exports["./client"] \u2192 lib/client.js (required for web-form plugins; TUI/CLI forms may ignore).' },
  "manifest.not-lib-main": { zh: "\u628A main \u6539\u4E3A lib/index.js\uFF08\u751F\u6001\u7EA6\u5B9A\uFF09\u3002", en: "Set main to lib/index.js (ecosystem convention)." },
  "manifest.no-files-whitelist": { zh: "\u5728 package.json \u52A0 files \u767D\u540D\u5355\uFF08lib / cordis.patch.yml / README\xD72 / LICENSE\uFF09\u3002", en: "Add a files whitelist to package.json (lib / cordis.patch.yml / README\xD72 / LICENSE)." },
  "eng.no-tests": { zh: "\u8865 tests/ \u6216 scripts/smoke.mjs\uFF08node \u5185\u7F6E runner \u6216 smoke \u98CE\u683C\uFF0C\u53EF\u5728 CI \u8DD1\uFF09\u3002", en: "Add tests/ or scripts/smoke.mjs (node test runner or smoke style, CI-runnable)." },
  "eng.no-ci": { zh: "\u8865 .github/workflows\uFF08build + typecheck + smoke\uFF09\u3002", en: "Add .github/workflows (build + typecheck + smoke)." },
  "repo.no-license": { zh: "\u8865 LICENSE \u6587\u4EF6\uFF08\u751F\u6001\u60EF\u4F8B MIT\uFF09\u5E76\u5728 package.json \u58F0\u660E license\u3002", en: "Add a LICENSE file (MIT is the ecosystem norm) and declare license in package.json." },
  "selfcheck.no-bundle-patch": { zh: "\u5728 package.json \u58F0\u660E dsh.bundle.patch \u5E76\u63D0\u4EA4\u5BF9\u5E94\u7684 cordis.patch.yml\uFF08\u5426\u5219\u65E0\u6CD5\u4EE5 bundle \u5F62\u6001\u5B89\u88C5\uFF09\u3002", en: "Declare dsh.bundle.patch in package.json and commit the cordis.patch.yml it points to (otherwise the bundle cannot install)." },
  "selfcheck.lib-missing": { zh: "\u5148 npm run build \u4EA7\u51FA lib/index.js + lib/client.js\uFF08\u53D1\u5E03\u4EA7\u7269\uFF09\u3002", en: "Run the build first so lib/index.js + lib/client.js exist (publish artifacts)." },
  "selfcheck.no-keywords": { zh: "\u5728 package.json \u52A0 keywords\uFF08\u542B dsh / deepseek-harness / cordis / plugin\uFF09\uFF0C\u4EE3\u7406 GitHub topics \u7684\u53EF\u53D1\u73B0\u6027\u3002", en: "Add keywords to package.json (dsh / deepseek-harness / cordis / plugin) \u2014 the local proxy for GitHub-topic discoverability." },
  "compat.missing-seed": { zh: "\u5220\u6389\u5BF9\u5931\u6548\u6A21\u5757\u7684\u5F15\u7528\u540E\u91CD\u65B0\u6784\u5EFA\u5BA2\u6237\u7AEF bundle\uFF1B\u5916\u90E8 require \u5FC5\u987B\u843D\u5728\u5F53\u524D shell \u7684 seed \u8868\uFF08react\u3001cordis\u3001dsh-client-store\u3001ui-slots\u3001ui-primitives \u7B49\uFF09\u6216\u63D2\u4EF6\u81EA\u8EAB\u5305\u540D\u4E0A\u3002", en: "Drop references to the dead modules and rebuild the client bundle; external requires must land on the current shell seed table (react, cordis, dsh-client-store, ui-slots, ui-primitives, \u2026) or the plugin's own package name." }
};
var UNCOVERED = [
  { code: "repo.no-dsh-topic", reason: { zh: "GitHub topics \u9700\u4ED3\u5E93\u5143\u6570\u636E\uFF0C\u672C\u5730\u76EE\u5F55\u4E0D\u53EF\u5224\u5B9A", en: "GitHub topics need repo metadata; not decidable from a local directory" } },
  { code: "repo.sparse-topics", reason: { zh: "GitHub topics \u9700\u4ED3\u5E93\u5143\u6570\u636E\uFF0C\u672C\u5730\u76EE\u5F55\u4E0D\u53EF\u5224\u5B9A", en: "GitHub topics need repo metadata; not decidable from a local directory" } },
  { code: "activity.too-young", reason: { zh: "\u4ED3\u5E93\u5E74\u9F84\u9700 GitHub \u521B\u5EFA\u65F6\u95F4", en: "Repo age needs the GitHub creation time" } },
  { code: "activity.dormant", reason: { zh: "\u6D3B\u8DC3\u5EA6\u9700\u6700\u8FD1 push \u65F6\u95F4", en: "Activity needs the last push time" } },
  { code: "maint.single-push", reason: { zh: "\u9700 git/GitHub \u7684\u521B\u5EFA\u4E0E push \u65F6\u95F4\u5BF9\u6BD4", en: "Needs git/GitHub created-vs-pushed comparison" } },
  { code: "discover.batch-import", reason: { zh: "\u9700\u540C\u8D26\u53F7\u5168\u91CF\u4ED3\u5E93\u7EDF\u8BA1", en: "Needs account-wide repository statistics" } }
];
function drop(code, sev, zh, en) {
  return { code, sev, label: { zh, en }, fix: FIX[code] ?? { zh: "", en: "" } };
}
var SEV_WEIGHT = { fail: 20, major: 10, warn: 5, minor: 2 };
function gradeOf(score) {
  return score >= 95 ? "S" : score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : "D";
}
async function defaultFetchNpm(registryBase, name) {
  const url = `${registryBase.replace(/\/+$/, "")}/${name.startsWith("@") ? name.replace("/", "%2f") : name}`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(1e4) });
  } catch (error) {
    return { published: false, error: `registry unreachable: ${error.message}` };
  }
  if (res.status === 404) return { published: false };
  if (!res.ok) return { published: false, error: `registry HTTP ${res.status}` };
  try {
    const doc = await res.json();
    const latest = doc["dist-tags"]?.latest ?? null;
    return {
      published: true,
      latest,
      versions: Object.keys(doc.versions ?? {}).length,
      latestTime: latest ? doc.time?.[latest] ?? null : null
    };
  } catch {
    return { published: false, error: "registry returned non-JSON" };
  }
}
var WRITE_PATTERNS = [
  [/fs\.(writeFile|appendFile|rename|unlink|rm|rmSync|copyFile|mkdir|chmod|createWriteStream)/g, "\u6587\u4EF6\u7CFB\u7EDF\u5199 fs-write"],
  [/\b(writeFileSync|appendFileSync|writeFile|appendFile|rmSync|unlinkSync|mkdirSync|createWriteStream)\s*\(/g, "\u6587\u4EF6\u7CFB\u7EDF\u5199 fs-write"],
  // `(?<!.)` keeps regex literals' `.exec(` calls from self-matching.
  [/(?<!\.)\bexec(Sync)?\s*\(|(?<!\.)\bspawn\(|child_process/g, "\u5B50\u8FDB\u7A0B\u6267\u884C child-process"],
  [/(?<!\.)\b(put|post|delete|patch)\s*\(|method:\s*['"](POST|PUT|DELETE|PATCH)['"]/g, "HTTP \u5199\u52A8\u8BCD http-write"]
];
var SANITIZE_RE = /DOMPurify|sanitizeHtml|escape-html|marked\.parse|textContent|setHTML/g;
var DANGER_RE = /dangerouslySetInnerHTML/;
var SCAN_EXTENSIONS = /\.(ts|tsx|js|mjs|jsx)$/;
var SCAN_SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", "lib", "dist", "docs"]);
var SCAN_HIT_CAP = 12;
function scanSurface(dir) {
  const hits = [];
  let totalHits = 0;
  let srcFiles = 0;
  let sanitizedRefs = 0;
  let dangerouslySetInnerHTML = false;
  function walk(path) {
    for (const entry of readdirSync2(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SCAN_SKIP_DIRS.has(entry.name)) continue;
      const full = join3(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SCAN_EXTENSIONS.test(entry.name)) continue;
      let text;
      try {
        text = readFileSync3(full, "utf8");
      } catch {
        continue;
      }
      srcFiles += 1;
      if (SANITIZE_RE.test(text)) sanitizedRefs += 1;
      if (DANGER_RE.test(text)) dangerouslySetInnerHTML = true;
      for (const [pattern, kind] of WRITE_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
          totalHits += 1;
          if (hits.length < SCAN_HIT_CAP) {
            hits.push({ file: relative(dir, full), kind, match: match[0].slice(0, 48) });
          }
        }
      }
    }
  }
  walk(dir);
  return { srcFiles, sanitizedRefs, dangerouslySetInnerHTML, hits, totalHits };
}
function resolvePluginDir(raw) {
  if (!raw) throw new SelfcheckError("invalid-path", "missing ?dir=");
  if (!isAbsolute(raw)) {
    throw new SelfcheckError("invalid-path", "path must be absolute");
  }
  if (raw.split(/[\\/]/).includes("..")) {
    throw new SelfcheckError("invalid-path", "path must not contain .. segments");
  }
  const dir = resolve2(raw);
  let stat;
  try {
    stat = statSync2(dir);
  } catch {
    throw new SelfcheckError("not-a-directory", `no such directory: ${dir}`);
  }
  if (!stat.isDirectory()) throw new SelfcheckError("not-a-directory", `not a directory: ${dir}`);
  return dir;
}
function hasTests(dir) {
  for (const candidate of ["tests", "test", "__tests__"]) {
    if (existsSync3(join3(dir, candidate))) return true;
  }
  if (existsSync3(join3(dir, "scripts", "smoke.mjs"))) return true;
  try {
    return readdirSync2(dir).some((name) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(name));
  } catch {
    return false;
  }
}
function hasCi(dir) {
  const workflows = join3(dir, ".github", "workflows");
  try {
    return readdirSync2(workflows).some((name) => /\.ya?ml$/.test(name));
  } catch {
    return false;
  }
}
function readmeBytes(dir) {
  try {
    return statSync2(join3(dir, "README.md")).size;
  } catch {
    return -1;
  }
}
async function runSelfcheck(rawDir, options = {}) {
  const dir = resolvePluginDir(rawDir);
  const pkgPath = join3(dir, "package.json");
  if (!existsSync3(pkgPath)) {
    throw new SelfcheckError("no-package-json", `no package.json in ${dir} (not a plugin directory?)`);
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync3(pkgPath, "utf8"));
  } catch {
    throw new SelfcheckError("bad-package-json", `package.json in ${dir} is not parseable`);
  }
  const drops = [];
  const hints = [];
  const patchRel = pkg.dsh?.bundle?.patch;
  if (!patchRel || !existsSync3(join3(dir, patchRel))) {
    drops.push(drop("selfcheck.no-bundle-patch", "major", !patchRel ? "\u672A\u58F0\u660E dsh.bundle.patch" : `patch \u6587\u4EF6\u7F3A\u5931\uFF08${patchRel}\uFF09`, !patchRel ? "dsh.bundle.patch not declared" : `patch file missing (${patchRel})`));
  }
  if (pkg.main !== "lib/index.js") {
    drops.push(drop("manifest.not-lib-main", "minor", `main \u4E0D\u662F lib/index.js\uFF08\u5F53\u524D ${String(pkg.main ?? "\uFF08\u65E0\uFF09")}\uFF09`, `main is not lib/index.js (currently ${String(pkg.main ?? "(none)")})`));
  }
  const clientExport = pkg.exports?.["./client"];
  if (typeof clientExport !== "object" && typeof clientExport !== "string") {
    drops.push(drop("manifest.no-client-export", "warn", 'exports["./client"] \u7F3A\u5931', 'exports["./client"] missing'));
  }
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    drops.push(drop("manifest.no-files-whitelist", "minor", "package.json \u65E0 files \u767D\u540D\u5355", "no files whitelist in package.json"));
  }
  if (!existsSync3(join3(dir, "lib", "index.js")) || !existsSync3(join3(dir, "lib", "client.js"))) {
    drops.push(drop("selfcheck.lib-missing", "warn", "lib/index.js \u6216 lib/client.js \u7F3A\u5931\uFF08\u672A\u6784\u5EFA\uFF09", "lib/index.js or lib/client.js missing (not built)"));
  }
  const enginesDsh = pkg.engines?.dsh;
  if (typeof enginesDsh !== "string" || enginesDsh.trim() === "") {
    hints.push({
      code: "manifest.no-engines-dsh",
      zh: '\u672A\u58F0\u660E engines.dsh\u2014\u2014dsh \u7248\u672C\u517C\u5BB9\u65E0\u4ECE\u5224\u5B9A\uFF1B\u5EFA\u8BAE\u52A0 "engines": {"dsh": "^0.1.1"}\uFF08\u63D2\u4EF6\u58F0\u660E\u517C\u5BB9\u7684 dsh \u7248\u672C\u8303\u56F4\uFF1B\u4F53\u68C0\u9762\u677F\u4E0E compat.json \u4F1A\u5C55\u793A\uFF09\u3002',
      en: 'engines.dsh is not declared \u2014 dsh compatibility cannot be determined; consider adding "engines": {"dsh": "^0.1.1"} (the dsh version range this plugin supports; the audit panel and compat.json display it).'
    });
  }
  const clientBundlePath2 = join3(dir, "lib", "client.js");
  if (existsSync3(clientBundlePath2)) {
    const requires = extractRequires(readFileSync3(clientBundlePath2, "utf8"));
    if (requires.length > 0) {
      const seed = readShellSeedLoose();
      if (seed === null) {
        hints.push({
          code: "compat.seed-unchecked",
          zh: `\u5BA2\u6237\u7AEF bundle \u6709 ${requires.length} \u4E2A\u5916\u90E8 require\uFF08${requires.slice(0, 3).join(", ")}${requires.length > 3 ? "\u2026" : ""}\uFF09\uFF0C\u4F46\u672C\u673A\u672A\u627E\u5230 dsh \u5B89\u88C5\u6811\uFF0C\u65E0\u6CD5\u6821\u9A8C shell \u6A21\u5757\u8868\u517C\u5BB9\u6027\uFF1B\u53EF\u5728\u88C5\u6709 dsh \u7684\u673A\u5668\u4E0A\u91CD\u8DD1\uFF0C\u6216\u8BBE DSH_INSIGHTS_DSH_ROOT \u6307\u5411\u5B89\u88C5\u6839\u3002`,
          en: `The client bundle has ${requires.length} external require(s) (${requires.slice(0, 3).join(", ")}${requires.length > 3 ? "\u2026" : ""}), but no dsh install tree was found to check shell module-table compatibility; re-run on a machine with dsh installed, or point DSH_INSIGHTS_DSH_ROOT at the install root.`
        });
      } else {
        const seedWords = new Set(seed.seedWords);
        const ownName = typeof pkg.name === "string" && pkg.name !== "" ? pkg.name : null;
        const missing = requires.filter((spec) => !seedWords.has(spec) && stripClientSuffix(spec) !== ownName);
        if (missing.length > 0) {
          drops.push(drop(
            "compat.missing-seed",
            "major",
            `\u5BA2\u6237\u7AEF bundle \u5F15\u7528\u4E86\u5F53\u524D dsh\uFF08${seed.version ?? "\u672A\u77E5\u7248\u672C"}\uFF09\u6A21\u5757\u8868\u65E0\u6CD5\u89E3\u6790\u7684\u6A21\u5757\uFF1A${missing.join(", ")}\uFF08\u52A0\u8F7D\u5373\u5931\u8D25\uFF0C0.1.2-rc.1 \u4E8B\u6545\u540C\u7C7B\uFF09`,
            `The client bundle requires modules the current dsh (${seed.version ?? "unknown"}) module table cannot resolve: ${missing.join(", ")} (fails at load \u2014 the 0.1.2-rc.1 incident class)`
          ));
        }
      }
    }
  }
  const readme = readmeBytes(dir);
  if (readme < 0) {
    drops.push(drop("docs.no-readme", "fail", "\u65E0 README.md", "no README.md"));
  } else if (readme < 400) {
    drops.push(drop("docs.tiny-readme", "minor", `README \u4EC5 ${readme} \u5B57\u8282\uFF08<400\uFF09`, `README is only ${readme} bytes (<400)`));
  }
  if (!existsSync3(join3(dir, "README.zh-CN.md"))) {
    drops.push(drop("docs.zh-missing", "warn", "\u65E0\u4E2D\u6587/\u53CC\u8BED\u6587\u6863\uFF08README.zh-CN.md\uFF09", "no Chinese/bilingual docs (README.zh-CN.md)"));
  }
  if (typeof pkg.description !== "string" || pkg.description.trim() === "") {
    drops.push(drop("docs.no-description", "warn", "package.json \u65E0 description", "no description in package.json"));
  }
  if (!existsSync3(join3(dir, "docs"))) {
    drops.push(drop("docs.no-docs-dir", "minor", "\u65E0 docs/ \u76EE\u5F55", "no docs/ directory"));
  }
  if (!existsSync3(join3(dir, "LICENSE")) && !existsSync3(join3(dir, "LICENSE.md"))) {
    drops.push(drop("repo.no-license", "warn", "\u65E0 LICENSE \u6587\u4EF6", "no LICENSE file"));
  }
  if (!Array.isArray(pkg.keywords) || pkg.keywords.length === 0) {
    drops.push(drop("selfcheck.no-keywords", "minor", "package.json \u65E0 keywords\uFF08topics \u7684\u672C\u5730\u4EE3\u7406\uFF09", "no keywords in package.json (local proxy for topics)"));
  }
  if (!hasTests(dir)) {
    drops.push(drop("eng.no-tests", "warn", "\u65E0\u6D4B\u8BD5\u76EE\u5F55/\u6D4B\u8BD5\u6587\u4EF6/smoke \u811A\u672C", "no test directory, test files, or smoke script"));
  }
  if (!hasCi(dir)) {
    drops.push(drop("eng.no-ci", "minor", "\u65E0 .github/workflows", "no .github/workflows"));
  }
  let npm = null;
  const name = typeof pkg.name === "string" && pkg.name ? pkg.name : null;
  if (name) {
    npm = options.fetchNpm ? await options.fetchNpm(name) : await defaultFetchNpm(options.npmRegistry ?? process.env.DSH_INSIGHTS_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY, name);
    if (npm.error) {
    } else if (!npm.published) {
      drops.push(drop("npm.unpublished", "major", "\u672A\u53D1\u5E03\u5230 npm\uFF08\u65E0\u6CD5\u4E00\u952E\u5B89\u88C5\uFF09", "not published to npm (no one-line install)"));
    } else {
      if (npm.latest && pkg.version && npm.latest !== pkg.version) {
        drops.push(drop("npm.version-drift", "warn", `npm latest ${npm.latest} \u2260 \u4ED3\u5E93 version ${pkg.version}`, `npm latest ${npm.latest} \u2260 repo version ${pkg.version}`));
      }
      if ((npm.versions ?? 0) < 2) {
        drops.push(drop("npm.single-release", "minor", "npm \u4EC5 1 \u4E2A\u53D1\u5E03\u7248\u672C", "only one npm release"));
      }
      if (npm.latestTime && Date.now() - new Date(npm.latestTime).getTime() > 90 * 864e5) {
        drops.push(drop("npm.release-stale", "warn", `npm \u6700\u8FD1\u53D1\u5E03 ${npm.latestTime.slice(0, 10)} \u8DDD\u4ECA\u8D85\u8FC7 90 \u5929`, `latest npm release ${npm.latestTime.slice(0, 10)} is over 90 days old`));
      }
    }
  }
  const score = Math.max(0, 100 - drops.reduce((acc, d) => acc + SEV_WEIGHT[d.sev], 0));
  return {
    dir,
    pkgName: name,
    version: typeof pkg.version === "string" ? pkg.version : null,
    score,
    grade: gradeOf(score),
    drops,
    hints,
    uncovered: UNCOVERED,
    scan: scanSurface(dir),
    npm
  };
}

// src/host/ops.ts
import { readFileSync as readFileSync4, renameSync, writeFileSync } from "node:fs";
import { join as join4 } from "node:path";
function readBundlesShape(profileDir) {
  try {
    const parsed = JSON.parse(readFileSync4(join4(profileDir, "package.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const dsh = parsed.dsh;
    const profile = typeof dsh === "object" && dsh !== null && !Array.isArray(dsh) ? dsh.profile : void 0;
    const bundles = typeof profile === "object" && profile !== null && !Array.isArray(profile) ? profile.bundles : void 0;
    return Array.isArray(bundles) ? "list" : "all";
  } catch {
    return null;
  }
}
function editBundles(profileDir, name, op) {
  const file = join4(profileDir, "package.json");
  let manifest;
  try {
    const parsed = JSON.parse(readFileSync4(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    manifest = parsed;
  } catch {
    return false;
  }
  const dsh = typeof manifest.dsh === "object" && manifest.dsh !== null && !Array.isArray(manifest.dsh) ? { ...manifest.dsh } : {};
  const profile = typeof dsh.profile === "object" && dsh.profile !== null && !Array.isArray(dsh.profile) ? { ...dsh.profile } : {};
  const current = Array.isArray(profile.bundles) ? profile.bundles.filter((entry) => typeof entry === "string") : [];
  const next = op === "add" ? current.includes(name) ? current : [...current, name] : current.filter((entry) => entry !== name);
  profile.bundles = next;
  dsh.profile = profile;
  manifest.dsh = dsh;
  const tmp = join4(profileDir, `package.json.dsh-insights-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
    renameSync(tmp, file);
  } catch {
    return false;
  }
  return true;
}
function findDependents(profileDir, target) {
  const manifestPath = join4(profileDir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync4(manifestPath, "utf8"));
  } catch {
    return [];
  }
  const deps = manifest.dependencies;
  const names = typeof deps === "object" && deps !== null && !Array.isArray(deps) ? Object.keys(deps) : [];
  const dependents = [];
  for (const name of names) {
    if (name === target) continue;
    try {
      const pkg = JSON.parse(readFileSync4(join4(profileDir, "node_modules", name, "package.json"), "utf8"));
      if (pkg.dependencies !== void 0 && target in pkg.dependencies || pkg.peerDependencies !== void 0 && target in pkg.peerDependencies) {
        dependents.push(name);
      }
    } catch {
    }
  }
  return dependents.sort();
}

// src/cli.ts
var CATEGORY_LABELS = {
  manifest: { zh: "\u6E05\u5355", en: "Manifest" },
  selfcheck: { zh: "\u7ED3\u6784", en: "Structure" },
  docs: { zh: "\u6587\u6863", en: "Docs" },
  repo: { zh: "\u4ED3\u5E93", en: "Repo" },
  eng: { zh: "\u5DE5\u7A0B", en: "Engineering" },
  npm: { zh: "npm", en: "npm" }
};
var CATEGORY_ORDER = ["manifest", "selfcheck", "docs", "repo", "eng", "npm"];
var SEV_WEIGHT2 = { fail: 20, major: 10, warn: 5, minor: 2 };
var USAGE = `dsh-insights-kit \u2014 DSH Insights helper CLI

Usage:
  dsh-insights-kit selfcheck <dir> [--json] [--lang zh|en]
  dsh-insights-kit doctor [--fix] [--profile <name>] [--json] [--lang zh|en]

Commands:
  selfcheck <dir>   Score a local plugin directory with the health-v5
                    rulebook (read-only: nothing is modified).
  doctor            Check the installed plugins' client bundles against the
                    on-disk dsh shell's module table \u2014 works when dsh web
                    itself will not boot. --fix disables the broken ones
                    (load-list only; files kept, re-enable any time).

Options:
  --json            Print the full report as JSON.
  --lang zh|en      Output language (default: $LANG \u2014 zh* \u2192 \u4E2D\u6587, else English).
  --profile <name>  dsh profile to inspect (default: web / $DSH_INSIGHTS_PROFILE).
  -h, --help        Show this help.

Exit codes:
  0  clean (selfcheck: no fail-tier deduction; doctor: nothing broken/fixed)
  1  problems found (selfcheck: fail-tier deduction; doctor: broken plugins)
  2  usage error or invalid directory
`;
function detectLang(flag) {
  if (flag === "zh" || flag === "en") return flag;
  const env = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "").toLowerCase();
  return env.startsWith("zh") ? "zh" : "en";
}
function parseSelfcheckArgs(rest) {
  const args = { dir: "", json: false, lang: null };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--lang") {
      const value = rest[++i];
      if (value !== "zh" && value !== "en") throw new SelfcheckError("usage", `--lang expects zh or en, got ${value ?? "(nothing)"}`);
      args.lang = value;
    } else if (arg.startsWith("--lang=")) {
      const value = arg.slice("--lang=".length);
      if (value !== "zh" && value !== "en") throw new SelfcheckError("usage", `--lang expects zh or en, got ${value}`);
      args.lang = value;
    } else if (arg.startsWith("-")) {
      throw new SelfcheckError("usage", `unknown option: ${arg}`);
    } else if (!args.dir) {
      args.dir = arg;
    } else {
      throw new SelfcheckError("usage", `unexpected extra argument: ${arg}`);
    }
  }
  if (!args.dir) throw new SelfcheckError("usage", "missing <dir> (absolute path of the plugin directory)");
  return args;
}
function printReport(report, lang) {
  const t = (zh, en) => lang === "zh" ? zh : en;
  const out = [];
  out.push(`${report.pkgName ?? t("\uFF08\u672A\u58F0\u660E\u5305\u540D\uFF09", "(no package name)")}${report.version ? `@${report.version}` : ""}`);
  out.push(t(`\u76EE\u5F55\uFF1A${report.dir}`, `dir: ${report.dir}`));
  out.push(t(`\u5F97\u5206\uFF1A${report.score}/100 \xB7 \u7B49\u7EA7 ${report.grade}`, `Score: ${report.score}/100 \xB7 Grade ${report.grade}`));
  if (report.npm) {
    const npm = report.npm;
    out.push(npm.error ? t("npm\uFF1Aregistry \u4E0D\u53EF\u8FBE\uFF08npm \u89C4\u5219\u672A\u8BA1\u5206\uFF09", `npm: registry unreachable (npm rules not scored) \u2014 ${npm.error}`) : npm.published ? t(`npm\uFF1A\u5DF2\u53D1\u5E03 \xB7 latest ${npm.latest ?? "?"} \xB7 ${npm.versions ?? "?"} \u4E2A\u7248\u672C`, `npm: published \xB7 latest ${npm.latest ?? "?"} \xB7 ${npm.versions ?? "?"} releases`) : t("npm\uFF1A\u672A\u53D1\u5E03", "npm: not published"));
  }
  out.push("");
  if (report.drops.length === 0) {
    out.push(t("\u5168\u90E8\u901A\u8FC7\uFF0C\u65E0\u6263\u5206\u9879", "All checks passed \u2014 no deductions"));
  } else {
    const groups = /* @__PURE__ */ new Map();
    for (const d of report.drops) {
      const category = d.code.split(".")[0] ?? "misc";
      const list = groups.get(category) ?? [];
      list.push(d);
      groups.set(category, list);
    }
    const ordered = [...groups.keys()].sort(
      (a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99)
    );
    const total = report.drops.reduce((acc, d) => acc + (SEV_WEIGHT2[d.sev] ?? 0), 0);
    out.push(t(`\u6263\u5206\uFF08\u5171 \u2212${total}\uFF09\uFF1A`, `Deductions (\u2212${total} total):`));
    for (const category of ordered) {
      const list = groups.get(category);
      const weight = list.reduce((acc, d) => acc + (SEV_WEIGHT2[d.sev] ?? 0), 0);
      const label = CATEGORY_LABELS[category];
      out.push(`  [${label ? t(label.zh, label.en) : category}] \u2212${weight}`);
      for (const d of list) {
        out.push(`    ${d.sev.toUpperCase().padEnd(5)}  ${d.code} \u2014 ${t(d.label.zh, d.label.en)}`);
        if (d.fix.zh || d.fix.en) out.push(`           ${t("\u600E\u4E48\u4FEE\uFF1A", "Fix: ")}${t(d.fix.zh, d.fix.en)}`);
      }
    }
  }
  if (report.hints.length > 0) {
    out.push("");
    out.push(t("\u63D0\u793A\uFF08\u4E0D\u8BA1\u5206\uFF09\uFF1A", "Hints (not scored):"));
    for (const hint of report.hints) {
      out.push(`  ${hint.code} \u2014 ${t(hint.zh, hint.en)}`);
    }
  }
  out.push("");
  const scan = report.scan;
  const danger = scan.dangerouslySetInnerHTML ? t(" \xB7 \u26A0 \u5B58\u5728 dangerouslySetInnerHTML", " \xB7 \u26A0 dangerouslySetInnerHTML present") : "";
  out.push(t(
    `\u53EA\u8BFB\u9762\u626B\u63CF\uFF1A\u6E90\u7801 ${scan.srcFiles} \u4E2A \xB7 \u6D88\u6BD2\u5F15\u7528 ${scan.sanitizedRefs} \u4E2A${danger}`,
    `Surface scan: ${scan.srcFiles} source files \xB7 ${scan.sanitizedRefs} with sanitization refs${danger}`
  ));
  if (scan.totalHits === 0) {
    out.push(t("  \u672A\u53D1\u73B0\u5199\u76D8 / \u5B50\u8FDB\u7A0B / HTTP \u5199\u52A8\u8BCD", "  no fs writes / child processes / HTTP write verbs found"));
  } else {
    out.push(t(`  ${scan.totalHits} \u5904\u547D\u4E2D\uFF08\u5BA3\u79F0"\u53EA\u8BFB"\u7684\u63D2\u4EF6\u9700\u9010\u6761\u89E3\u91CA\uFF09\uFF1A`, `  ${scan.totalHits} hit(s) (plugins claiming read-only must justify each):`));
    for (const hit of scan.hits) {
      out.push(`    ${hit.file} \u2192 ${hit.kind} (${hit.match})`);
    }
    if (scan.totalHits > scan.hits.length) out.push(t(`    \u2026\u7B49\u5171 ${scan.totalHits} \u5904`, `    \u2026${scan.totalHits} in total`));
  }
  if (report.uncovered.length > 0) {
    out.push(t(
      `\u672C\u5730\u4E0D\u53EF\u5224\u5B9A\uFF08\u4E0D\u8BA1\u5206\uFF09\uFF1A${report.uncovered.map((u) => u.code).join(" \xB7 ")}`,
      `Not decidable locally (not scored): ${report.uncovered.map((u) => u.code).join(" \xB7 ")}`
    ));
  }
  process.stdout.write(`${out.join("\n")}
`);
}
function parseDoctorArgs(rest) {
  const args = { fix: false, json: false, lang: null, profile: null };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--fix") {
      args.fix = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--lang") {
      const value = rest[++i];
      if (value !== "zh" && value !== "en") throw new SelfcheckError("usage", `--lang expects zh or en, got ${value ?? "(nothing)"}`);
      args.lang = value;
    } else if (arg.startsWith("--lang=")) {
      const value = arg.slice("--lang=".length);
      if (value !== "zh" && value !== "en") throw new SelfcheckError("usage", `--lang expects zh or en, got ${value}`);
      args.lang = value;
    } else if (arg === "--profile") {
      const value = rest[++i];
      if (!value) throw new SelfcheckError("usage", "--profile expects a profile name");
      args.profile = value;
    } else if (arg.startsWith("--profile=")) {
      args.profile = arg.slice("--profile=".length);
    } else {
      throw new SelfcheckError("usage", `unknown option: ${arg}`);
    }
  }
  return args;
}
function runDoctor(args) {
  const lang = detectLang(args.lang);
  const t = (zh, en) => lang === "zh" ? zh : en;
  if (args.profile !== null) process.env.DSH_INSIGHTS_PROFILE = args.profile;
  const { profile, dir } = resolveProfileDir();
  const report = checkClientCompat();
  const broken = report.rows.filter((row) => row.status === "broken");
  const unknown = report.rows.filter((row) => row.status === "unknown");
  const noClient = report.rows.filter((row) => row.status === "no-client").length;
  const fixed = [];
  const fixFailed = [];
  if (args.fix && broken.length > 0) {
    if (readBundlesShape(dir) !== "list") {
      throw new SelfcheckError(
        "unsupported-profile",
        t(
          `profile ${profile} \u6CA1\u6709 dsh.profile.bundles \u88C5\u8F7D\u6E05\u5355\uFF08\u5168\u91CF\u52A0\u8F7D\u5F62\u6001\uFF09\uFF0C\u65E0\u6CD5\u5355\u72EC\u7981\u7528\u63D2\u4EF6\u2014\u2014\u8BF7\u624B\u5DE5\u7F16\u8F91 ${dir}/package.json \u7684 dependencies`,
          `profile ${profile} has no dsh.profile.bundles load list (all-dependencies-load shape); single-plugin disable is not expressible \u2014 edit ${dir}/package.json dependencies by hand`
        )
      );
    }
    for (const row of broken) {
      const dependents = findDependents(dir, row.name).filter((d) => !broken.some((b) => b.name === d));
      if (dependents.length > 0) {
        process.stderr.write(t(
          `\u6CE8\u610F\uFF1A${dependents.join(", ")} \u4F9D\u8D56 ${row.name}\uFF0C\u7981\u7528\u540E\u5B83\u4EEC\u4E5F\u4F1A\u53D7\u5F71\u54CD
`,
          `note: ${dependents.join(", ")} depend on ${row.name}; disabling affects them too
`
        ));
      }
      if (editBundles(dir, row.name, "remove")) fixed.push(row.name);
      else fixFailed.push(row.name);
    }
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      profile,
      profileDir: dir,
      shell: report.shell,
      broken: broken.map((row) => ({ name: row.name, missing: row.missing })),
      unknown: unknown.map((row) => row.name),
      noClient,
      fixed: args.fix ? fixed : void 0,
      fixFailed: args.fix ? fixFailed : void 0
    }, null, 2)}
`);
  } else {
    const out = [];
    if (report.shell === null) {
      out.push(t(
        "\u672A\u627E\u5230\u672C\u673A dsh \u5B89\u88C5\u6811\uFF0C\u65E0\u6CD5\u6821\u9A8C\uFF08\u53EF\u7528 DSH_INSIGHTS_DSH_ROOT \u6307\u5411\u5B89\u88C5\u6839\uFF09\u3002",
        "No local dsh install tree found \u2014 cannot check (point DSH_INSIGHTS_DSH_ROOT at the install root)."
      ));
      process.stdout.write(`${out.join("\n")}
`);
      return 0;
    }
    out.push(t(
      `dsh shell\uFF1A${report.shell.version ?? "\u672A\u77E5\u7248\u672C"}\uFF08seed ${report.shell.seedWords.length} \u4E2A\u6A21\u5757\uFF09\xB7 profile\uFF1A${profile}`,
      `dsh shell: ${report.shell.version ?? "unknown"} (${report.shell.seedWords.length} seed modules) \xB7 profile: ${profile}`
    ));
    if (broken.length === 0) {
      out.push(t(
        `\u5DF2\u68C0\u67E5 ${report.rows.length - noClient} \u4E2A\u6709\u754C\u9762\u7684\u63D2\u4EF6\uFF1A\u5168\u90E8\u517C\u5BB9 \u2713`,
        `${report.rows.length - noClient} UI-carrying plugin(s) checked \u2014 all compatible \u2713`
      ));
    } else {
      out.push(t(
        `${broken.length} \u4E2A\u63D2\u4EF6\u5728\u5F53\u524D dsh \u6784\u5EFA\u4E0B\u65E0\u6CD5\u52A0\u8F7D\uFF08\u4F1A\u5BFC\u81F4 dsh web \u542F\u52A8\u5931\u8D25\uFF09\uFF1A`,
        `${broken.length} plugin(s) cannot load on the current dsh build (they break the dsh web boot):`
      ));
      for (const row of broken) {
        out.push(`  \u2717 ${row.name} \u2014 ${t("\u65E0\u6CD5\u89E3\u6790", "unresolvable")}: ${row.missing.join(", ")}`);
      }
      if (args.fix) {
        for (const name of fixed) out.push(t(`  \u5DF2\u7981\u7528 ${name} \u2713`, `  disabled ${name} \u2713`));
        for (const name of fixFailed) out.push(t(`  \u7981\u7528\u5931\u8D25\uFF1A${name}\uFF08\u8BF7\u624B\u5DE5\u7F16\u8F91\u88C5\u8F7D\u6E05\u5355\uFF09`, `  failed to disable: ${name} (edit the load list by hand)`));
        if (fixed.length > 0) {
          out.push(t(
            "\u5DF2\u628A\u4E0A\u8FF0\u63D2\u4EF6\u79FB\u51FA\u88C5\u8F7D\u6E05\u5355\uFF08\u6587\u4EF6\u4FDD\u7559\uFF09\u3002\u73B0\u5728\u91CD\u542F dsh web \u5373\u53EF\u6B63\u5E38\u542F\u52A8\uFF1B\u6062\u590D\uFF1A\u5728\u300C\u751F\u6001\u300D\u9762\u677F\u91CD\u65B0\u542F\u7528\uFF0C\u6216 dsh plugin add <name>\u3002",
            "The above plugins are out of the load list (files kept). dsh web should boot now; re-enable any time from the\u300C\u751F\u6001\u300Dpanel or with dsh plugin add <name>."
          ));
        }
      } else {
        out.push(t(
          "\u4FEE\u590D\uFF1Adsh-insights-kit doctor --fix\uFF08\u79FB\u51FA\u88C5\u8F7D\u6E05\u5355\u3001\u6587\u4EF6\u4FDD\u7559\u3001\u968F\u65F6\u53EF\u6062\u590D\uFF09",
          "Fix: dsh-insights-kit doctor --fix (drops them from the load list; files kept, reversible)"
        ));
      }
    }
    if (unknown.length > 0) {
      out.push(t(`\u672A\u80FD\u5224\u5B9A\uFF08\u754C\u9762\u5305\u4E0D\u53EF\u8BFB\uFF09\uFF1A${unknown.join(", ")}`, `undecidable (bundle unreadable): ${unknown.join(", ")}`));
    }
    process.stdout.write(`${out.join("\n")}
`);
  }
  if (broken.length === 0) return 0;
  return args.fix && fixFailed.length === 0 ? 0 : 1;
}
async function main(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const [command, ...rest] = argv;
  if (command === "doctor") {
    return runDoctor(parseDoctorArgs(rest));
  }
  if (command !== "selfcheck") {
    process.stderr.write(`unknown command: ${command ?? ""}

${USAGE}`);
    return 2;
  }
  const args = parseSelfcheckArgs(rest);
  const lang = detectLang(args.lang);
  const report = await runSelfcheck(args.dir);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
  } else {
    printReport(report, lang);
  }
  return report.drops.some((d) => d.sev === "fail") ? 1 : 0;
}
main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  if (error instanceof SelfcheckError) {
    process.stderr.write(`dsh-insights-kit: ${error.message} (${error.code})
`);
    if (error.code === "usage") process.stderr.write(`
${USAGE}`);
  } else {
    process.stderr.write(`dsh-insights-kit: ${error?.message ?? String(error)}
`);
  }
  process.exitCode = 2;
});
