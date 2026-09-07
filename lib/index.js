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
  dynamics: `${DEFAULT_BASE_URL}/dynamics.json`
};
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
    status() {
      const names = ["insights", "scenarios", "dynamics"];
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

// src/host/selfcheck.ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
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
  "selfcheck.no-keywords": { zh: "\u5728 package.json \u52A0 keywords\uFF08\u542B dsh / deepseek-harness / cordis / plugin\uFF09\uFF0C\u4EE3\u7406 GitHub topics \u7684\u53EF\u53D1\u73B0\u6027\u3002", en: "Add keywords to package.json (dsh / deepseek-harness / cordis / plugin) \u2014 the local proxy for GitHub-topic discoverability." }
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
async function defaultFetchNpm(registryBase, name2) {
  const url = `${registryBase.replace(/\/+$/, "")}/${name2.startsWith("@") ? name2.replace("/", "%2f") : name2}`;
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
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SCAN_SKIP_DIRS.has(entry.name)) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SCAN_EXTENSIONS.test(entry.name)) continue;
      let text;
      try {
        text = readFileSync(full, "utf8");
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
  const dir = resolve(raw);
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new SelfcheckError("not-a-directory", `no such directory: ${dir}`);
  }
  if (!stat.isDirectory()) throw new SelfcheckError("not-a-directory", `not a directory: ${dir}`);
  return dir;
}
function hasTests(dir) {
  for (const candidate of ["tests", "test", "__tests__"]) {
    if (existsSync(join(dir, candidate))) return true;
  }
  if (existsSync(join(dir, "scripts", "smoke.mjs"))) return true;
  try {
    return readdirSync(dir).some((name2) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(name2));
  } catch {
    return false;
  }
}
function hasCi(dir) {
  const workflows = join(dir, ".github", "workflows");
  try {
    return readdirSync(workflows).some((name2) => /\.ya?ml$/.test(name2));
  } catch {
    return false;
  }
}
function readmeBytes(dir) {
  try {
    return statSync(join(dir, "README.md")).size;
  } catch {
    return -1;
  }
}
async function runSelfcheck(rawDir, options = {}) {
  const dir = resolvePluginDir(rawDir);
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    throw new SelfcheckError("no-package-json", `no package.json in ${dir} (not a plugin directory?)`);
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    throw new SelfcheckError("bad-package-json", `package.json in ${dir} is not parseable`);
  }
  const drops = [];
  const patchRel = pkg.dsh?.bundle?.patch;
  if (!patchRel || !existsSync(join(dir, patchRel))) {
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
  if (!existsSync(join(dir, "lib", "index.js")) || !existsSync(join(dir, "lib", "client.js"))) {
    drops.push(drop("selfcheck.lib-missing", "warn", "lib/index.js \u6216 lib/client.js \u7F3A\u5931\uFF08\u672A\u6784\u5EFA\uFF09", "lib/index.js or lib/client.js missing (not built)"));
  }
  const readme = readmeBytes(dir);
  if (readme < 0) {
    drops.push(drop("docs.no-readme", "fail", "\u65E0 README.md", "no README.md"));
  } else if (readme < 400) {
    drops.push(drop("docs.tiny-readme", "minor", `README \u4EC5 ${readme} \u5B57\u8282\uFF08<400\uFF09`, `README is only ${readme} bytes (<400)`));
  }
  if (!existsSync(join(dir, "README.zh-CN.md"))) {
    drops.push(drop("docs.zh-missing", "warn", "\u65E0\u4E2D\u6587/\u53CC\u8BED\u6587\u6863\uFF08README.zh-CN.md\uFF09", "no Chinese/bilingual docs (README.zh-CN.md)"));
  }
  if (typeof pkg.description !== "string" || pkg.description.trim() === "") {
    drops.push(drop("docs.no-description", "warn", "package.json \u65E0 description", "no description in package.json"));
  }
  if (!existsSync(join(dir, "docs"))) {
    drops.push(drop("docs.no-docs-dir", "minor", "\u65E0 docs/ \u76EE\u5F55", "no docs/ directory"));
  }
  if (!existsSync(join(dir, "LICENSE")) && !existsSync(join(dir, "LICENSE.md"))) {
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
  const name2 = typeof pkg.name === "string" && pkg.name ? pkg.name : null;
  if (name2) {
    npm = options.fetchNpm ? await options.fetchNpm(name2) : await defaultFetchNpm(options.npmRegistry ?? process.env.DSH_INSIGHTS_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY, name2);
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
    pkgName: name2,
    version: typeof pkg.version === "string" ? pkg.version : null,
    score,
    grade: gradeOf(score),
    drops,
    uncovered: UNCOVERED,
    scan: scanSurface(dir),
    npm
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
function apply(raw) {
  const ctx = raw;
  const log = ctx.logger("insights");
  log.info("dsh-insights-kit loaded (host /dsh-insights routes)");
  const store = createStore({
    baseUrl: process.env.DSH_INSIGHTS_UPSTREAM_BASE || void 0
  });
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: PREFIX,
    handler: (req, res) => void handleRequest(req, res, store, log)
  }));
  log.info("registered GET /dsh-insights/{plugin,search,audit,scenarios,dynamics,selfcheck,health} (read-only)");
}
async function handleRequest(req, res, store, log) {
  if (!trusted(req)) {
    sendJson(res, 403, { ok: false, error: wireError("forbidden", "untrusted host/origin") });
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: wireError("method-not-allowed", "only GET is served") });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  try {
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
      sendJson(res, 200, { ok: true, generatedAt: data.generatedAt ?? null, plugin: trimPlugin(plugin) });
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
      sendJson(res, 200, {
        ok: true,
        generatedAt: data.generatedAt ?? null,
        results: auditByNpm(data.plugins, names)
      });
      return;
    }
    if (pathname === `${PREFIX}/selfcheck`) {
      const report = await runSelfcheck((url.searchParams.get("dir") ?? "").trim());
      sendJson(res, 200, { ok: true, report });
      return;
    }
    if (pathname === `${PREFIX}/scenarios`) {
      sendJson(res, 200, { ok: true, scenarios: await store.scenarios() });
      return;
    }
    if (pathname === `${PREFIX}/dynamics`) {
      sendJson(res, 200, { ok: true, dynamics: await store.dynamics() });
      return;
    }
    if (pathname === `${PREFIX}/health`) {
      sendJson(res, 200, {
        ok: true,
        plugin: "dsh-insights-kit",
        uptimeMs: Date.now() - startedAt,
        caches: store.status()
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
          "/dsh-insights/selfcheck?dir=/abs/path",
          "/dsh-insights/scenarios",
          "/dsh-insights/dynamics",
          "/dsh-insights/health"
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
    if (error instanceof SelfcheckError) {
      const status = error.code === "not-a-directory" ? 404 : 400;
      sendJson(res, status, { ok: false, error: wireError(error.code, error.message) });
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
