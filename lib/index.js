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
  log.info("registered GET /dsh-insights/{plugin,search,audit,scenarios,dynamics,health} (read-only)");
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
