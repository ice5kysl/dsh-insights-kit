window.__ModuleLoader__.load({
	id: "dsh-insights-kit",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);

// src/client/InsightsView.tsx
var import_react = require("react");

// src/shared/i18n.ts
function localize(locale, zh, en, vars) {
  const template = locale === "zh" ? zh : en;
  if (!vars) return template;
  return template.replace(
    /\{(\w+)\}/g,
    (raw, name2) => vars[name2] !== void 0 ? String(vars[name2]) : raw
  );
}
function normalizeLocale(raw) {
  const tag = (raw ?? "").toLowerCase();
  if (tag.startsWith("zh")) return "zh";
  return "en";
}

// src/client/locale.ts
var LOCALE_STORAGE_KEY = "dsh.insights-kit.locale";
var explicit = null;
function detectLocale() {
  if (explicit) return explicit;
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
  }
  const nav = typeof navigator !== "undefined" ? navigator : void 0;
  const tags = nav?.languages && nav.languages.length > 0 ? [...nav.languages] : nav?.language ? [nav.language] : [];
  for (const tag of tags) {
    const locale = normalizeLocale(tag);
    if (locale === "zh") return locale;
  }
  return "en";
}
function setLocalePreference(locale) {
  explicit = locale;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
  }
}
function getLocale() {
  return detectLocale();
}
function L(zh, en, vars) {
  return localize(detectLocale(), zh, en, vars);
}

// src/client/api.ts
var ApiError = class extends Error {
  code;
  constructor(error) {
    super(error.message);
    this.code = error.code;
  }
};
async function getJson(query) {
  let response;
  try {
    response = await fetch(`/dsh-insights/${query}`, { headers: { accept: "application/json" } });
  } catch {
    throw new ApiError({
      code: "network",
      message: L("\u65E0\u6CD5\u8FDE\u63A5\u672C\u673A dsh web \u670D\u52A1\uFF08/dsh-insights \u4E0D\u53EF\u8FBE\uFF09", "Cannot reach the local dsh web service (/dsh-insights)")
    });
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
  }
  if (!response.ok || body === null || body.ok !== true) {
    const error = body?.error ?? { code: "http", message: `HTTP ${response.status}` };
    throw new ApiError(error);
  }
  return body;
}
async function fetchPlugin(fullName) {
  return getJson(`plugin?full_name=${encodeURIComponent(fullName)}`);
}
async function searchPlugins(q, limit = 20) {
  return getJson(`search?q=${encodeURIComponent(q)}&limit=${limit}`);
}
async function fetchScenarios() {
  return getJson("scenarios");
}
async function fetchDynamics() {
  return getJson("dynamics");
}
async function fetchRuntime() {
  return getJson("runtime");
}
async function fetchAudit(names) {
  return getJson(`audit?npm=${encodeURIComponent(names.join(","))}`);
}
function parseRepoInput(raw) {
  const input = raw.trim();
  if (!input) return null;
  const bare = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(input);
  if (bare) return `${bare[1]}/${bare[2]}`;
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const repo = parts[1].replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
    return `${parts[0]}/${repo}`;
  } catch {
    return null;
  }
}
function classifyCheckInput(raw) {
  const input = raw.trim();
  if (!input) return { kind: "invalid" };
  if (input.includes("/") || /^https?:\/\//i.test(input)) {
    const fullName = parseRepoInput(input);
    return fullName ? { kind: "exact", fullName } : { kind: "invalid" };
  }
  return { kind: "search", query: input };
}

// src/shared/installed.ts
function npmNameOfModule(moduleName) {
  const specifier = moduleName.startsWith("link:") ? moduleName.slice("link:".length) : moduleName;
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  if (/^[./~]/.test(specifier) || specifier.includes("\\") || /^[A-Za-z]:/.test(specifier)) {
    return specifier.split(/[\\/]/).filter(Boolean).pop() ?? specifier;
  }
  const slash = specifier.indexOf("/");
  return slash < 0 ? specifier : specifier.slice(0, slash);
}
var NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
function installedPluginNames(entries) {
  const names = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const name2 = npmNameOfModule(entry.moduleName);
    if (!name2 || name2.includes(":") || !NPM_NAME_RE.test(name2)) continue;
    if (name2.startsWith("@deepseek-ai/")) continue;
    names.add(name2);
  }
  return [...names].sort();
}

// src/client/inventory.ts
function listerOf(remote) {
  let ns;
  try {
    ns = remote.pluginInventory;
  } catch {
    return null;
  }
  if (!ns || typeof ns.list !== "function") return null;
  return async () => {
    const result = await ns.list();
    if (!result.ok || !result.value) {
      throw new Error(result.error?.message ?? "pluginInventory/list failed");
    }
    return result.value.entries;
  };
}
var INVENTORY_WAIT_MS = 3e3;
function mountInventory(ctx) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), INVENTORY_WAIT_MS);
    try {
      ctx.inject(["remote", "remote.pluginInventory"], (child) => {
        clearTimeout(timer);
        resolve(listerOf(child.remote));
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}
var listerPromise = null;
function setInventoryLister(promise) {
  listerPromise = promise;
}
function getInventoryLister() {
  return listerPromise ?? Promise.resolve(null);
}

// src/shared/compat.ts
function baseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
function satisfiesSimpleRange(version, range) {
  const m = /^([~^])\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  const base = baseVersion(version);
  if (!m || !base) return null;
  const min = [Number(m[2]), Number(m[3]), Number(m[4])];
  let max;
  if (m[1] === "~") {
    max = [min[0], min[1] + 1, 0];
  } else if (min[0] > 0) {
    max = [min[0] + 1, 0, 0];
  } else if (min[1] > 0) {
    max = [0, min[1] + 1, 0];
  } else {
    max = [0, 0, min[2] + 1];
  }
  return cmp(base, min) >= 0 && cmp(base, max) < 0;
}
function isOutdated(current, latest) {
  const a = baseVersion(current);
  const b = baseVersion(latest);
  if (!a || !b) return null;
  return cmp(a, b) < 0;
}

// src/client/SidebarAction.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var PANEL_EVENT = "dsh-insights-kit:toggle-panel";
function SidebarAction(props) {
  const wide = Boolean(props.wide);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "button",
    {
      type: "button",
      style: wide ? styles.wide : styles.rail,
      title: L(
        "DSH Insights \u2014\u2014 \u63D2\u4EF6\u4F53\u68C0 / \u67E5\u9A8C\u5065\u5EB7\u5206 / \u573A\u666F\u53D1\u73B0",
        "DSH Insights \u2014 audit installed plugins / check health scores / discover by scenario"
      ),
      onClick: () => window.dispatchEvent(new CustomEvent(PANEL_EVENT)),
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.glyph, children: "\u2726" }),
        wide && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: L("\u751F\u6001", "Insights") })
      ]
    }
  );
}
var styles = {
  wide: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: "6px 10px",
    fontSize: 11,
    border: "none",
    background: "transparent",
    color: "#5a6478",
    cursor: "pointer",
    textAlign: "left"
  },
  rail: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 32,
    fontSize: 14,
    border: "none",
    background: "transparent",
    color: "#5a6478",
    cursor: "pointer"
  },
  glyph: {
    fontSize: 13,
    lineHeight: 1
  }
};

// src/client/InsightsView.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var SITE = "https://dsh-insights.com";
var GRADE_COLORS = {
  S: "#7c3aed",
  A: "#16a34a",
  B: "#2563eb",
  C: "#ea580c",
  D: "#dc2626"
};
var SEV_COLORS = {
  fail: "#dc2626",
  major: "#ea580c",
  warn: "#ca8a04",
  minor: "#64748b"
};
var DIM_LABELS = {
  eng: { zh: "\u5DE5\u7A0B", en: "Engineering" },
  docs: { zh: "\u6587\u6863", en: "Docs" },
  discover: { zh: "\u53EF\u53D1\u73B0", en: "Discovery" },
  maint: { zh: "\u7EF4\u62A4", en: "Maintenance" }
};
var GRADE_ORDER = ["S", "A", "B", "C", "D"];
var headerStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 14px",
  borderBottom: "1px solid var(--border, #e2e5e9)",
  flexShrink: 0
};
var bodyStyle = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "12px 16px 24px"
};
var subTabStyle = (active) => ({
  border: "1px solid var(--border, #e2e5e9)",
  borderRadius: 6,
  padding: "3px 12px",
  fontSize: 12,
  cursor: "pointer",
  background: active ? "var(--fg, #1f2328)" : "transparent",
  color: active ? "var(--bg, #ffffff)" : "inherit"
});
var buttonStyle = {
  border: "1px solid var(--border, #d0d7de)",
  borderRadius: 6,
  padding: "5px 14px",
  fontSize: 13,
  cursor: "pointer",
  background: "var(--fg, #1f2328)",
  color: "var(--bg, #ffffff)"
};
var inputStyle = {
  flex: 1,
  minWidth: 0,
  border: "1px solid var(--border, #d0d7de)",
  borderRadius: 6,
  padding: "5px 10px",
  fontSize: 13,
  background: "var(--bg, #ffffff)",
  color: "inherit"
};
var cardStyle = {
  border: "1px solid var(--border, #e2e5e9)",
  borderRadius: 8,
  padding: "12px 14px",
  marginBottom: 12
};
var mutedStyle = { color: "var(--fg-muted, #6a737d)", fontSize: 12 };
var installedPillStyle = {
  ...mutedStyle,
  border: "1px solid var(--border, #e2e5e9)",
  borderRadius: 6,
  padding: "0 6px",
  fontSize: 11,
  flexShrink: 0
};
var copyButtonStyle = {
  border: "1px solid var(--border, #d0d7de)",
  borderRadius: 6,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
  background: "transparent",
  color: "var(--fg-muted, #6a737d)",
  flexShrink: 0
};
function CopyCommandButton(props) {
  const { command, label } = props;
  const [copied, setCopied] = (0, import_react.useState)(false);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    "button",
    {
      style: copyButtonStyle,
      title: command,
      onClick: (event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2e3);
        }).catch(() => {
        });
      },
      children: copied ? L("\u5DF2\u590D\u5236 \u2713", "Copied \u2713") : label
    }
  );
}
function GradeBadge({ grade, large }) {
  const g = (grade ?? "?").toUpperCase();
  const color = GRADE_COLORS[g] ?? "#64748b";
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    "span",
    {
      style: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: large ? 44 : 22,
        height: large ? 44 : 22,
        borderRadius: large ? 10 : 6,
        background: color,
        color: "#fff",
        fontWeight: 700,
        fontSize: large ? 22 : 12,
        flexShrink: 0
      },
      title: L("\u5065\u5EB7\u7B49\u7EA7", "Health grade"),
      children: g
    }
  );
}
function Stars({ n }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: mutedStyle, children: [
    "\u2605 ",
    n.toLocaleString()
  ] });
}
function ErrorNote({ error }) {
  const code = error instanceof ApiError ? error.code : "internal";
  const text = code === "upstream" ? L("\u4E0A\u6E38\u6570\u636E\u6682\u65F6\u4E0D\u53EF\u7528\uFF08dsh-insights.com \u62C9\u53D6\u5931\u8D25\uFF09\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5", "Upstream data temporarily unavailable (dsh-insights.com fetch failed); please retry later") : code === "network" ? L("\u65E0\u6CD5\u8FDE\u63A5\u672C\u673A dsh web \u670D\u52A1", "Cannot reach the local dsh web service") : error?.message ?? String(error);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...cardStyle, borderColor: "#dc2626", color: "#dc2626" }, children: text });
}
function BreakingCard({ releases }) {
  const breaking = releases.filter((rel) => rel.breaking).slice(0, 3);
  if (breaking.length === 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { ...cardStyle, borderColor: "#dc2626" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { fontWeight: 700, color: "#dc2626", marginBottom: 6 }, children: L("dsh \u5B98\u65B9 BREAKING \u53D8\u66F4\u9884\u8B66", "Official dsh BREAKING-change alert") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { style: { margin: "0 0 6px", paddingLeft: 0, listStyle: "none" }, children: breaking.map((rel) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { style: { padding: "2px 0" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { background: "#dc2626", color: "#fff", borderRadius: 4, fontSize: 11, fontWeight: 700, padding: "1px 6px", marginRight: 6 }, children: "BREAKING" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { style: { fontWeight: 700 }, children: rel.name ?? rel.tag }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { ...mutedStyle, marginLeft: 6 }, children: (rel.published_at ?? "").slice(0, 10) }),
      rel.summary && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...mutedStyle, marginTop: 2 }, children: rel.summary })
    ] }, rel.tag)) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: mutedStyle, children: L(
      "\u5347\u7EA7 dsh \u524D\uFF0C\u5DF2\u88C5\u63D2\u4EF6\u53EF\u80FD\u9700\u8981\u9002\u914D\u8FD9\u4E9B\u53D8\u66F4\u2014\u2014\u5EFA\u8BAE\u5148\u9010\u4E2A\u67E5\u9A8C\u5065\u5EB7\u5206\u4E0E\u7EF4\u62A4\u72B6\u6001\u3002",
      "Installed plugins may need to adapt to these changes before you upgrade dsh \u2014 check each plugin's health and maintenance state first."
    ) })
  ] });
}
function DistTags({ tags }) {
  if (!tags || Object.keys(tags).length === 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }, children: Object.entries(tags).map(([tag, version]) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { ...mutedStyle, border: "1px solid var(--border, #e2e5e9)", borderRadius: 6, padding: "2px 8px" }, children: [
    tag,
    ": ",
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: version })
  ] }, tag)) });
}
function DshVersionLine({ version, latest }) {
  if (!version) return null;
  const outdated = latest ? isOutdated(version, latest) : null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { ...mutedStyle, marginBottom: 12 }, children: [
    latest ? L("\u5F53\u524D dsh \u7248\u672C {cur} \xB7 \u6700\u65B0 release {lat}", "Current dsh {cur} \xB7 latest release {lat}", { cur: version, lat: latest }) : L("\u5F53\u524D dsh \u7248\u672C {cur}", "Current dsh {cur}", { cur: version }),
    outdated === true && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { color: "#ca8a04" }, children: [
      " \xB7 ",
      L("\u6709\u65B0\u7248\u672C\uFF0C\u5EFA\u8BAE\u5347\u7EA7 dsh", "newer dsh available \u2014 consider upgrading")
    ] }),
    outdated === false && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { color: "#16a34a" }, children: [
      " \xB7 ",
      L("\u5DF2\u662F\u6700\u65B0", "up to date"),
      " \u2713"
    ] })
  ] });
}
function CompatLine({ compat, dshVersion }) {
  if (!compat) return null;
  let text;
  let verdictRange = null;
  if (compat.enginesDsh) {
    text = L("dsh \u517C\u5BB9\uFF1Aengines.dsh {range}", "dsh compat: engines.dsh {range}", { range: compat.enginesDsh });
    verdictRange = compat.enginesDsh;
  } else {
    const peer = compat.dshPeers.find((p) => p.name === "@deepseek-ai/cordis") ?? compat.dshPeers[0];
    if (!peer) return null;
    text = L("dsh \u517C\u5BB9\uFF1Apeer {name} {range}", "dsh compat: peer {name} {range}", { name: peer.name, range: peer.range });
  }
  const verdict = dshVersion && verdictRange ? satisfiesSimpleRange(dshVersion, verdictRange) : null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { ...mutedStyle, marginTop: 2, marginLeft: 30 }, children: [
    text,
    verdict === true && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { color: "#16a34a", marginLeft: 6 }, title: L("\u5F53\u524D dsh \u7248\u672C\u6EE1\u8DB3\u8BE5\u8303\u56F4\uFF08\u6309\u57FA\u7840\u7248\u672C\u4FDD\u5B88\u5224\u65AD\uFF09", "Current dsh satisfies this range (conservative base-version check)"), children: "\u2713" }),
    verdict === false && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { color: "#ea580c", marginLeft: 6 }, title: L("\u5F53\u524D dsh \u7248\u672C\u4E0D\u6EE1\u8DB3\u8BE5\u8303\u56F4\uFF08\u6309\u57FA\u7840\u7248\u672C\u4FDD\u5B88\u5224\u65AD\uFF09", "Current dsh does not satisfy this range (conservative base-version check)"), children: "\u26A0" })
  ] });
}
function AuditSection(props) {
  const { onPick } = props;
  const [audit, setAudit] = (0, import_react.useState)({ form: "loading" });
  (0, import_react.useEffect)(() => {
    let cancelled = false;
    void (async () => {
      const [dynamics, dshVersion] = await Promise.all([
        fetchDynamics().then((res) => res.dynamics).catch(() => void 0),
        fetchRuntime().then((res) => res.dsh?.version ?? null).catch(() => null)
      ]);
      const lister = await getInventoryLister();
      if (!lister) {
        if (!cancelled) setAudit({ form: "degraded", dynamics, dshVersion });
        return;
      }
      try {
        const entries = await lister();
        const names = installedPluginNames(entries);
        const baseline = entries.filter((e) => e.enabled && npmNameOfModule(e.moduleName).startsWith("@deepseek-ai/")).length;
        if (names.length === 0) {
          if (!cancelled) setAudit({ form: "full", rows: [], baseline, dynamics, dshVersion });
          return;
        }
        const res = await fetchAudit(names);
        const rows2 = names.map((name2) => ({ name: name2, card: res.results[name2] ?? null }));
        if (!cancelled) setAudit({ form: "full", rows: rows2, baseline, dynamics, dshVersion });
      } catch (error) {
        if (!cancelled) setAudit({ form: "degraded", dynamics, dshVersion, error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (audit.form === "loading") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: mutedStyle, children: L("\u6B63\u5728\u679A\u4E3E\u5DF2\u88C5\u63D2\u4EF6\u5E76\u4F53\u68C0\u2026", "Enumerating installed plugins and auditing\u2026") });
  const releases = audit.dynamics?.dsh?.releases ?? [];
  const distTags = audit.dynamics?.dsh?.npm?.distTags;
  const latestRelease = distTags?.latest;
  if (audit.form === "degraded") {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(DshVersionLine, { version: audit.dshVersion, latest: latestRelease }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: cardStyle, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { fontWeight: 600, marginBottom: 4 }, children: L("\u6B64 dsh \u6784\u5EFA\u65E0\u6CD5\u679A\u4E3E\u5DF2\u88C5\u63D2\u4EF6", "This dsh build cannot enumerate installed plugins") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: mutedStyle, children: L(
          "\u5F53\u524D\u6784\u5EFA\u672A\u5F00\u653E pluginInventory Remote\uFF08\u6216\u6302\u8F7D\u5931\u8D25\uFF09\uFF0C\u300C\u4F53\u68C0\u300D\u964D\u7EA7\u4E3A\u7248\u672C\u4E0E\u517C\u5BB9\u6027\u63D0\u9192\u3002\u4EE5\u4E0B\u4E3A dsh \u5B98\u65B9\u53D1\u5E03\u52A8\u6001\u2014\u2014\u5347\u7EA7\u524D\u5EFA\u8BAE\u5728\u300C\u67E5\u9A8C\u300D\u9875\u9010\u4E2A\u68C0\u67E5\u5DF2\u88C5\u63D2\u4EF6\u7684\u5065\u5EB7\u5206\u4E0E\u7EF4\u62A4\u72B6\u6001\u3002",
          "The running build does not expose the pluginInventory Remote (or the mount failed), so Audit falls back to version & compatibility reminders. Below are the official dsh release dynamics \u2014 before upgrading, check each installed plugin's health and maintenance state on the Check tab."
        ) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(DistTags, { tags: distTags }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(BreakingCard, { releases }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: cardStyle, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { fontWeight: 700, marginBottom: 6 }, children: L("\u6700\u8FD1 releases", "Recent releases") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { style: { margin: 0, paddingLeft: 0, listStyle: "none" }, children: releases.slice(0, 5).map((rel) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { style: { padding: "4px 0", borderTop: "1px solid var(--border, #eef1f4)" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { style: { fontWeight: 700 }, children: rel.name ?? rel.tag }),
          rel.breaking && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { background: "#dc2626", color: "#fff", borderRadius: 4, fontSize: 11, fontWeight: 700, padding: "1px 6px", marginLeft: 6 }, children: "BREAKING" }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { ...mutedStyle, marginLeft: 6 }, children: (rel.published_at ?? "").slice(0, 10) }),
          rel.summary && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...mutedStyle, marginTop: 2 }, children: rel.summary })
        ] }, rel.tag)) })
      ] })
    ] });
  }
  if (audit.form === "error") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ErrorNote, { error: audit.error });
  const rows = audit.rows ?? [];
  const listed = rows.filter((row) => row.card !== null);
  const counts = {};
  for (const row of listed) {
    const grade = (row.card?.grade ?? "?").toUpperCase();
    counts[grade] = (counts[grade] ?? 0) + 1;
  }
  const unlisted = rows.length - listed.length;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(DshVersionLine, { version: audit.dshVersion, latest: latestRelease }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }, children: [
      GRADE_ORDER.map((grade) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(GradeBadge, { grade }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: mutedStyle, children: [
          "\xD7 ",
          counts[grade] ?? 0
        ] })
      ] }, grade)),
      unlisted > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(GradeBadge, { grade: null }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: mutedStyle, children: L("\u672A\u6536\u5F55 \xD7 {n}", "unlisted \xD7 {n}", { n: unlisted }) })
      ] })
    ] }),
    rows.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: cardStyle, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: mutedStyle, children: L(
      "\u672A\u53D1\u73B0\u7B2C\u4E09\u65B9\u5DF2\u88C5\u63D2\u4EF6\uFF08\u5B98\u65B9 @deepseek-ai/* \u57FA\u7EBF\u4E0D\u8BA1\u5165\u4F53\u68C0\uFF09\u3002",
      "No third-party installed plugins found (the official @deepseek-ai/* baseline is not audited)."
    ) }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: cardStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { fontWeight: 700, marginBottom: 6 }, children: [
        L("\u5DF2\u88C5\u63D2\u4EF6\uFF08{n}\uFF09", "Installed plugins ({n})", { n: rows.length }),
        typeof audit.baseline === "number" && audit.baseline > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { ...mutedStyle, fontWeight: 400, marginLeft: 8 }, children: L("\u53E6\u6709 {m} \u4E2A\u5B98\u65B9\u57FA\u7EBF\u6A21\u5757\uFF08\u8BBE\u7F6E \u2192 \u63D2\u4EF6\u91CC\u80FD\u770B\u5230\uFF09\u4E0D\u53C2\u4E0E\u4F53\u68C0", "plus {m} official baseline modules (visible under Settings \u2192 Plugins), not audited", { m: audit.baseline }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { style: { margin: 0, paddingLeft: 0, listStyle: "none" }, children: rows.map((row) => {
        const card = row.card;
        if (!card) {
          return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 0", flexWrap: "wrap" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(GradeBadge, { grade: null }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { style: { fontWeight: 600 }, children: row.name }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: mutedStyle, children: L("\u672A\u6536\u5F55\uFF08\u4E0D\u5728\u6743\u5A01\u96C6\uFF09", "unlisted (not in the corpus)") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              CopyCommandButton,
              {
                command: `dsh plugin --profile web remove ${row.name}`,
                label: L("\u590D\u5236\u5378\u8F7D\u547D\u4EE4", "Copy uninstall command")
              }
            )
          ] }, row.name);
        }
        const [owner, repo] = card.full_name.split("/");
        const drift = card.npmLatest && card.version && card.npmLatest !== card.version;
        const low = card.grade === "C" || card.grade === "D";
        return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { style: { padding: "4px 0" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(GradeBadge, { grade: card.grade }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              "button",
              {
                onClick: () => onPick(card.full_name),
                style: { border: "none", background: "none", padding: 0, cursor: "pointer", color: "inherit", fontWeight: 600, fontSize: 13, wordBreak: "break-all", textAlign: "left" },
                title: L("\u5728\u300C\u67E5\u9A8C\u300D\u9875\u6253\u5F00\u5065\u5EB7\u5361", "Open the health card on the Check tab"),
                children: card.full_name
              }
            ),
            card.score !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: mutedStyle, children: card.score }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Stars, { n: card.stars }),
            drift && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
              "span",
              {
                style: { background: "#ca8a04", color: "#fff", borderRadius: 4, fontSize: 11, fontWeight: 700, padding: "1px 6px" },
                title: L("npm latest \u4E0E\u4ED3\u5E93\u7248\u672C\u4E0D\u4E00\u81F4\uFF0C\u53EF\u80FD\u6709\u65B0\u7248\u672C", "npm latest differs from the repo version \u2014 an update may be available"),
                children: [
                  "npm ",
                  card.npmLatest
                ]
              }
            ),
            low && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("a", { href: `${SITE}/p/${owner}/${repo}/`, target: "_blank", rel: "noreferrer", style: { color: "#2563eb", fontSize: 12 }, children: L("\u540C\u7C7B\u66F4\u4F18\u66FF\u4EE3 \u2197", "better alternatives \u2197") }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              CopyCommandButton,
              {
                command: `dsh plugin --profile web remove ${row.name}`,
                label: L("\u590D\u5236\u5378\u8F7D\u547D\u4EE4", "Copy uninstall command")
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CompatLine, { compat: card.compat, dshVersion: audit.dshVersion })
        ] }, row.name);
      }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(DistTags, { tags: distTags }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(BreakingCard, { releases }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: mutedStyle, children: L(
      "\u300C\u590D\u5236\u5378\u8F7D\u547D\u4EE4\u300D\u53EA\u590D\u5236\u5230\u526A\u8D34\u677F\uFF1A\u5728\u7EC8\u7AEF\u6267\u884C\uFF0C\u5B8C\u6210\u540E\u91CD\u542F dsh web \u751F\u6548\u3002",
      "The copy-uninstall button only copies to the clipboard: run it in a terminal; restart `dsh web` to take effect."
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...mutedStyle, marginTop: 4 }, children: L(
      "\u679A\u4E3E\u6765\u6E90\uFF1A\u5B98\u65B9 pluginInventory Remote\uFF08Cordis Loader \u5B9E\u65F6\u72B6\u6001\uFF09\uFF1B\u5065\u5EB7\u5206\u6765\u81EA dsh-insights.com \u6743\u5A01\u96C6\uFF08\u5BA2\u89C2\u542F\u53D1\u5F0F\u4FE1\u53F7\uFF0C\u975E\u5B89\u5168\u5BA1\u8BA1\uFF09\u3002",
      "Enumeration source: the official pluginInventory Remote (live Cordis Loader state); health scores from the dsh-insights.com corpus (objective heuristic signals, not a security audit)."
    ) })
  ] });
}
function SearchHitRow({ hit, onPick }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
    "button",
    {
      onClick: () => onPick(hit.full_name),
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        textAlign: "left",
        border: "none",
        background: "none",
        padding: "4px 0",
        cursor: "pointer",
        color: "inherit",
        fontSize: 13
      },
      title: L("\u6253\u5F00\u5065\u5EB7\u5361", "Open the health card"),
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(GradeBadge, { grade: hit.grade }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontWeight: 600, wordBreak: "break-all" }, children: hit.full_name }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Stars, { n: hit.stars }),
        hit.description && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { ...mutedStyle, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: hit.description })
      ]
    }
  ) });
}
function CheckSection(props) {
  const { query, onQueryChange, result, onCheck } = props;
  const [input, setInput] = (0, import_react.useState)(query);
  const [hint, setHint] = (0, import_react.useState)("");
  const [search, setSearch] = (0, import_react.useState)({ state: "idle", query: "", results: [], total: 0 });
  const [similar, setSimilar] = (0, import_react.useState)([]);
  const searchGen = (0, import_react.useRef)(0);
  const lastSearched = (0, import_react.useRef)("");
  (0, import_react.useEffect)(() => {
    if (query) setInput(query);
  }, [query]);
  function runSearch(q) {
    if (lastSearched.current === q) return;
    lastSearched.current = q;
    const gen = ++searchGen.current;
    setSearch({ state: "loading", query: q, results: [], total: 0 });
    searchPlugins(q).then((res) => {
      if (searchGen.current === gen) setSearch({ state: "ready", query: q, results: res.results, total: res.total });
    }).catch((error) => {
      if (lastSearched.current === q) lastSearched.current = "";
      if (searchGen.current === gen) setSearch({ state: "error", query: q, results: [], total: 0, error });
    });
  }
  (0, import_react.useEffect)(() => {
    const classified2 = classifyCheckInput(input);
    if (classified2.kind !== "search") return;
    const timer = setTimeout(() => runSearch(classified2.query), 300);
    return () => clearTimeout(timer);
  }, [input]);
  (0, import_react.useEffect)(() => {
    if (!result.notInCorpus || !query.includes("/")) {
      setSimilar([]);
      return;
    }
    const repo = query.split("/").pop() ?? "";
    if (!repo) {
      setSimilar([]);
      return;
    }
    let cancelled = false;
    searchPlugins(repo).then((res) => {
      if (!cancelled) setSimilar(res.results);
    }).catch(() => {
      if (!cancelled) setSimilar([]);
    });
    return () => {
      cancelled = true;
    };
  }, [result.notInCorpus, query]);
  function submit() {
    const classified2 = classifyCheckInput(input);
    if (classified2.kind === "exact") {
      setHint("");
      onQueryChange(classified2.fullName);
      onCheck(classified2.fullName);
    } else if (classified2.kind === "search") {
      setHint("");
      runSearch(classified2.query);
    } else {
      setHint(L("\u8BF7\u8F93\u5165 owner/repo\u3001GitHub \u4ED3\u5E93 URL \u6216\u641C\u7D22\u5173\u952E\u8BCD", "Enter owner/repo, a GitHub repository URL, or search keywords"));
    }
  }
  function pickPlugin(fullName) {
    onQueryChange(fullName);
    onCheck(fullName);
  }
  const classified = classifyCheckInput(input);
  const searchQuery = classified.kind === "search" ? classified.query : null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", gap: 8, marginBottom: 4 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "input",
        {
          style: inputStyle,
          value: input,
          placeholder: L("owner/repo\u3001GitHub URL \u6216\u5173\u952E\u8BCD\uFF08\u5982 market\uFF09", "owner/repo, a GitHub URL, or keywords (e.g. market)"),
          onChange: (event) => setInput(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") submit();
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { style: buttonStyle, onClick: submit, disabled: result.state === "loading", children: result.state === "loading" ? L("\u67E5\u8BE2\u4E2D\u2026", "Checking\u2026") : L("\u67E5\u9A8C", "Check") })
    ] }),
    hint && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...mutedStyle, color: "#ea580c", marginBottom: 8 }, children: hint }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...mutedStyle, marginBottom: 12 }, children: L(
      "\u88C5\u63D2\u4EF6\u524D\u67E5\u4E00\u67E5\uFF1A\u5065\u5EB7\u5206\u6765\u81EA dsh-insights.com \u7684\u5168\u91CF\u6743\u5A01\u96C6\uFF08\u5BA2\u89C2\u542F\u53D1\u5F0F\u4FE1\u53F7\uFF0C\u975E\u5B89\u5168\u5BA1\u8BA1\uFF09\u3002",
      "Check before you install: health scores come from the dsh-insights.com authoritative corpus (objective heuristic signals, not a security audit)."
    ) }),
    searchQuery !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
      search.state === "loading" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: mutedStyle, children: L("\u641C\u7D22\u4E2D\u2026", "Searching\u2026") }),
      search.state === "error" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ErrorNote, { error: search.error }),
      search.state === "ready" && search.query === searchQuery && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...mutedStyle, marginBottom: 8 }, children: L("\u641C\u7D22\u201C{q}\u201D\xB7 \u547D\u4E2D {n} \u4E2A", 'Search "{q}" \xB7 {n} hit(s)', { q: search.query, n: search.total }) }),
        search.results.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: cardStyle, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: mutedStyle, children: L("\u65E0\u5339\u914D\u63D2\u4EF6", "No matching plugins") }) }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: cardStyle, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { style: { margin: 0, paddingLeft: 0, listStyle: "none" }, children: search.results.map((hit) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SearchHitRow, { hit, onPick: pickPlugin }, hit.full_name)) }) })
      ] })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      result.state === "error" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ErrorNote, { error: result.error }),
      result.notInCorpus && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: cardStyle, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { fontWeight: 600, marginBottom: 4 }, children: L("\u4E0D\u5728\u6743\u5A01\u96C6", "Not in the authoritative corpus") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: mutedStyle, children: L(
          "dsh-insights.com \u7684\u6743\u5A01\u96C6\u4E2D\u6CA1\u6709\u6536\u5F55\u8BE5\u4ED3\u5E93\u2014\u2014\u5B83\u53EF\u80FD\u4E0D\u662F dsh \u63D2\u4EF6\u3001\u592A\u65B0\u5C1A\u672A\u88AB\u589E\u91CF\u53D1\u73B0\u6536\u5F55\uFF0C\u6216\u672A\u6EE1\u8DB3\u6536\u5F55\u95E8\u69DB\u3002",
          "This repository is not in the dsh-insights.com corpus \u2014 it may not be a dsh plugin, may be too new for incremental discovery, or may not meet the listing bar."
        ) }),
        similar.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { marginTop: 10 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { fontWeight: 600, marginBottom: 4, fontSize: 12 }, children: L("\u76F8\u4F3C\u63D2\u4EF6", "Similar plugins") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { style: { margin: 0, paddingLeft: 0, listStyle: "none" }, children: similar.map((hit) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SearchHitRow, { hit, onPick: pickPlugin }, hit.full_name)) })
        ] })
      ] }),
      result.card && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(HealthCard, { card: result.card, generatedAt: result.generatedAt, similar: result.similar, onPick: pickPlugin })
    ] })
  ] });
}
function HealthCard(props) {
  const { card, generatedAt, similar, onPick } = props;
  const [owner, repo] = card.full_name.split("/");
  const pageUrl = `${SITE}/p/${owner}/${repo}/`;
  const dims = Object.entries(card.dimScores);
  const drift = card.npmLatest && card.version && card.npmLatest !== card.version;
  const [installedNames, setInstalledNames] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    let cancelled = false;
    void (async () => {
      try {
        const lister = await getInventoryLister();
        if (!lister) return;
        const entries = await lister();
        if (!cancelled) setInstalledNames(new Set(installedPluginNames(entries)));
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const installed = card.npm !== null && installedNames?.has(card.npm) === true;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: cardStyle, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(GradeBadge, { grade: card.grade, large: true }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { minWidth: 0 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { fontWeight: 700, fontSize: 15, wordBreak: "break-all" }, children: card.full_name }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: mutedStyle, children: [
          card.score !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { marginRight: 10 }, children: [
            L("\u5065\u5EB7\u5206", "Score"),
            " ",
            card.score,
            "/100"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Stars, { n: card.stars }),
          card.npm && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { marginLeft: 10 }, children: [
            card.npm,
            card.version ? `@${card.version}` : ""
          ] }),
          drift && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { marginLeft: 10, color: "#ca8a04" }, children: [
            "npm latest ",
            card.npmLatest
          ] })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }, children: card.npm ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
      installed && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: installedPillStyle, children: L("\u5DF2\u5B89\u88C5", "Installed") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        CopyCommandButton,
        {
          command: installed ? `dsh plugin --profile web remove ${card.npm}` : `dsh plugin --profile web add ${card.npm}`,
          label: installed ? L("\u590D\u5236\u5378\u8F7D\u547D\u4EE4", "Copy uninstall command") : L("\u590D\u5236\u5B89\u88C5\u547D\u4EE4", "Copy install command")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: mutedStyle, children: L("\u590D\u5236\u540E\u5728\u7EC8\u7AEF\u6267\u884C\uFF0C\u91CD\u542F dsh web \u751F\u6548", "Copied to the clipboard \u2014 run in a terminal, then restart `dsh web`") })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: mutedStyle, children: [
      L("\u672A\u53D1\u5E03 npm\uFF0C\u9700\u4ECE\u6E90\u7801\u5B89\u88C5", "Not published to npm \u2014 install from source"),
      card.url && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        " \xB7 ",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("a", { href: card.url, target: "_blank", rel: "noreferrer", style: { color: "#2563eb" }, children: "GitHub \u2197" })
      ] })
    ] }) }),
    card.description && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { marginBottom: 10 }, children: card.description }),
    dims.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 10 }, children: dims.map(([dim, value]) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", ...mutedStyle }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: DIM_LABELS[dim] ? L(DIM_LABELS[dim].zh, DIM_LABELS[dim].en) : dim }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: value })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { height: 6, borderRadius: 3, background: "var(--border, #e2e5e9)", overflow: "hidden" }, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { width: `${Math.max(0, Math.min(100, value))}%`, height: "100%", background: value >= 90 ? "#16a34a" : value >= 60 ? "#2563eb" : "#ea580c" } }) })
    ] }, dim)) }),
    card.drops.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { marginBottom: 10 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { fontWeight: 600, marginBottom: 4 }, children: L("\u6263\u5206\u660E\u7EC6", "Deductions") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { style: { margin: 0, paddingLeft: 0, listStyle: "none" }, children: card.drops.map((drop) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { style: { display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { color: SEV_COLORS[drop.sev] ?? "#64748b", fontSize: 11, fontWeight: 700, minWidth: 44, textTransform: "uppercase" }, children: drop.sev }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: L(drop.label.zh, drop.label.en) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { style: { ...mutedStyle, fontSize: 11 }, children: drop.code })
      ] }, drop.code)) })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...mutedStyle, marginBottom: 10 }, children: L("\u65E0\u6263\u5206\u9879", "No deductions") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 12 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("a", { href: pageUrl, target: "_blank", rel: "noreferrer", style: { color: "#2563eb" }, children: L("\u5728 dsh-insights.com \u67E5\u770B\u5B8C\u6574\u9875 \u2197", "View full page on dsh-insights.com \u2197") }),
      generatedAt && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: mutedStyle, children: L("\u6570\u636E\u751F\u6210\u4E8E {at}", "Data generated at {at}", { at: generatedAt.slice(0, 10) }) })
    ] }),
    similar && similar.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { marginTop: 12, borderTop: "1px solid var(--border, #eef1f4)", paddingTop: 10 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { fontWeight: 600, marginBottom: 4, fontSize: 12 }, children: L("\u76F8\u4F3C\u63A8\u8350", "Similar picks") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { style: { margin: 0, paddingLeft: 0, listStyle: "none" }, children: similar.map((pick) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
        "button",
        {
          onClick: () => onPick(pick.full_name),
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            textAlign: "left",
            border: "none",
            background: "none",
            padding: "4px 0",
            cursor: "pointer",
            color: "inherit",
            fontSize: 13
          },
          title: L("\u52A0\u8F7D\u8BE5\u63D2\u4EF6\u7684\u5065\u5EB7\u5361", "Load this plugin's health card"),
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(GradeBadge, { grade: pick.grade }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontWeight: 600, wordBreak: "break-all" }, children: pick.full_name }),
            pick.score !== null && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: mutedStyle, children: pick.score }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Stars, { n: pick.stars })
          ]
        }
      ) }, pick.full_name)) })
    ] })
  ] });
}
var EMPTY_SET = /* @__PURE__ */ new Set();
function ScenariosSection(props) {
  const { doc, state, error, onPick } = props;
  const [installed, setInstalled] = (0, import_react.useState)(EMPTY_SET);
  (0, import_react.useEffect)(() => {
    let cancelled = false;
    void (async () => {
      try {
        const lister = await getInventoryLister();
        if (!lister) return;
        const entries = await lister();
        const names = installedPluginNames(entries);
        if (names.length === 0) return;
        const res = await fetchAudit(names);
        if (cancelled) return;
        const found = /* @__PURE__ */ new Set();
        for (const name2 of names) {
          const card = res.results[name2];
          if (card) found.add(card.full_name);
        }
        setInstalled(found);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (state === "loading" || state === "idle") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: mutedStyle, children: L("\u52A0\u8F7D\u573A\u666F\u63A8\u8350\u2026", "Loading scenario picks\u2026") });
  if (state === "error") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ErrorNote, { error });
  const scenarios = doc?.scenarios ?? [];
  if (scenarios.length === 0) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: mutedStyle, children: L("\u6682\u65E0\u573A\u666F\u6570\u636E", "No scenario data yet") });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...mutedStyle, marginBottom: 4 }, children: L("\u6309\u4F7F\u7528\u573A\u666F\u53D1\u73B0\u63D2\u4EF6\uFF08{n} \u4E2A\u573A\u666F\uFF09\uFF1B\u70B9\u4EFB\u610F\u63D2\u4EF6\u8DF3\u5230\u300C\u67E5\u9A8C\u300D\u3002", "Discover plugins by use case ({n} scenarios); click any plugin to jump to Check.", { n: scenarios.length }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { ...mutedStyle, marginBottom: 12 }, children: L(
      "\u300C\u590D\u5236\u5B89\u88C5/\u5378\u8F7D\u547D\u4EE4\u300D\u53EA\u590D\u5236\u5230\u526A\u8D34\u677F\uFF1A\u5728\u7EC8\u7AEF\u6267\u884C\uFF0C\u5B8C\u6210\u540E\u91CD\u542F dsh web \u751F\u6548\u3002",
      "The copy install/uninstall buttons only copy to the clipboard: run in a terminal; restart `dsh web` to take effect."
    ) }),
    scenarios.map((scenario) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: cardStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { fontWeight: 700, marginBottom: 6 }, children: [
        L(scenario.zh ?? scenario.id, scenario.en ?? scenario.id),
        typeof scenario.candidates === "number" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { ...mutedStyle, fontWeight: 400, marginLeft: 8 }, children: L("{n} \u4E2A\u5019\u9009", "{n} candidates", { n: scenario.candidates }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { style: { margin: 0, paddingLeft: 0, listStyle: "none" }, children: (scenario.plugins ?? []).map((plugin) => {
        const isInstalled = installed.has(plugin.full_name);
        return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
            "button",
            {
              onClick: () => onPick(plugin.full_name),
              style: {
                display: "flex",
                alignItems: "center",
                gap: 8,
                flex: 1,
                minWidth: 0,
                flexWrap: "wrap",
                textAlign: "left",
                border: "none",
                background: "none",
                padding: "4px 0",
                cursor: "pointer",
                color: "inherit",
                fontSize: 13
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(GradeBadge, { grade: plugin.grade }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontWeight: 600, wordBreak: "break-all" }, children: plugin.full_name }),
                isInstalled && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: installedPillStyle, children: L("\u5DF2\u5B89\u88C5", "Installed") }),
                typeof plugin.stars === "number" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Stars, { n: plugin.stars }),
                plugin.reasons && plugin.reasons.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { ...mutedStyle, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: plugin.reasons[0] })
              ]
            }
          ),
          plugin.pkgName && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            CopyCommandButton,
            {
              command: isInstalled ? `dsh plugin --profile web remove ${plugin.pkgName}` : `dsh plugin --profile web add ${plugin.pkgName}`,
              label: isInstalled ? L("\u590D\u5236\u5378\u8F7D\u547D\u4EE4", "Copy uninstall command") : L("\u590D\u5236\u5B89\u88C5\u547D\u4EE4", "Copy install command")
            }
          )
        ] }) }, plugin.full_name);
      }) })
    ] }, scenario.id))
  ] });
}
var backdropStyle = {
  position: "fixed",
  inset: 0,
  zIndex: 9999,
  display: "flex",
  justifyContent: "flex-end",
  background: "rgba(15, 18, 26, 0.42)"
};
var drawerStyle = {
  width: 640,
  maxWidth: "100vw",
  height: "100%",
  background: "var(--bg, #ffffff)",
  color: "var(--fg, #1f2328)",
  boxShadow: "-24px 0 64px rgba(15, 18, 26, 0.35)",
  display: "flex",
  flexDirection: "column",
  fontSize: 13
};
function InsightsPanel() {
  const [open, setOpen] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    const onToggle = () => setOpen((prev) => !prev);
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener(PANEL_EVENT, onToggle);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener(PANEL_EVENT, onToggle);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  if (!open) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: backdropStyle, onClick: () => setOpen(false), children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: drawerStyle, onClick: (event) => event.stopPropagation(), children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(PanelContent, { onClose: () => setOpen(false) }) }) });
}
function PanelContent(props) {
  const { onClose } = props;
  const [section, setSection] = (0, import_react.useState)("audit");
  const [checkQuery, setCheckQuery] = (0, import_react.useState)("");
  const [check, setCheck] = (0, import_react.useState)({ state: "idle" });
  const [scenariosDoc, setScenariosDoc] = (0, import_react.useState)(void 0);
  const [scenariosState, setScenariosState] = (0, import_react.useState)("idle");
  const [scenariosError, setScenariosError] = (0, import_react.useState)(void 0);
  const [, setLocaleTick] = (0, import_react.useState)(0);
  function runCheck(fullName) {
    setCheck({ state: "loading" });
    fetchPlugin(fullName).then((res) => setCheck({ state: "ready", card: res.plugin, generatedAt: res.generatedAt, similar: res.similar ?? [] })).catch((error) => {
      if (error instanceof ApiError && error.code === "not-in-corpus") {
        setCheck({ state: "ready", notInCorpus: true });
      } else {
        setCheck({ state: "error", error });
      }
    });
  }
  (0, import_react.useEffect)(() => {
    if (section === "scenarios" && scenariosState === "idle") {
      setScenariosState("loading");
      fetchScenarios().then((res) => {
        setScenariosDoc(res.scenarios);
        setScenariosState("ready");
      }).catch((error) => {
        setScenariosError(error);
        setScenariosState("error");
      });
    }
  }, [section, scenariosState]);
  function jumpToCheck(fullName) {
    setCheckQuery(fullName);
    setSection("check");
    runCheck(fullName);
  }
  const tabs = [
    { id: "audit", label: L("\u4F53\u68C0", "Audit") },
    { id: "scenarios", label: L("\u573A\u666F", "Scenarios") },
    { id: "check", label: L("\u67E5\u9A8C", "Check") }
  ];
  let body;
  if (section === "audit") {
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AuditSection, { onPick: jumpToCheck });
  } else if (section === "scenarios") {
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ScenariosSection, { doc: scenariosDoc, state: scenariosState, error: scenariosError, onPick: jumpToCheck });
  } else {
    body = /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CheckSection, { query: checkQuery, onQueryChange: setCheckQuery, result: check, onCheck: runCheck });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: headerStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { fontWeight: 700 }, children: "DSH Insights" }),
      tabs.map((tab) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { style: subTabStyle(section === tab.id), onClick: () => setSection(tab.id), children: tab.label }, tab.id)),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { flex: 1 } }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("a", { href: SITE, target: "_blank", rel: "noreferrer", style: { ...mutedStyle, color: "#2563eb" }, children: "dsh-insights.com \u2197" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          style: { ...subTabStyle(false), fontSize: 11 },
          onClick: () => {
            setLocalePreference(getLocale() === "zh" ? "en" : "zh");
            setLocaleTick((tick) => tick + 1);
          },
          title: L("Switch to English", "\u5207\u6362\u5230\u4E2D\u6587"),
          children: getLocale() === "zh" ? "EN" : "\u4E2D"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { style: { ...subTabStyle(false), fontSize: 11 }, onClick: onClose, title: L("\u5173\u95ED (Esc)", "Close (Esc)"), children: "\u2715" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: bodyStyle, children: body })
  ] });
}

// src/client/index.ts
var name = "insights";
var inject = ["slots", "remote"];
function apply(raw) {
  const ctx = raw;
  const log = ctx.logger("insights:client");
  setInventoryLister(mountInventory(ctx));
  ctx.slots.inject(
    "sidebar.footer.action",
    () => ctx.slots.register(
      { name: "sidebar.footer.action", id: "insights-kit.action", order: 10 },
      SidebarAction
    )
  );
  ctx.slots.inject(
    "shell.overlay",
    () => ctx.slots.register(
      { name: "shell.overlay", id: "insights-kit.panel", order: 100 },
      InsightsPanel
    )
  );
  log.info("DSH Insights client ready (sidebar footer action + overlay panel)");
}

		return module.exports;
	}
});

