window.__ModuleLoader__.load({
	id: "dsh-insights-plugin",
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
var LOCALE_STORAGE_KEY = "dsh.insights.locale";
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

// src/client/InsightsView.tsx
var import_react = require("react");

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
async function fetchScenarios() {
  return getJson("scenarios");
}
async function fetchDynamics() {
  return getJson("dynamics");
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

// src/client/InsightsView.tsx
var import_jsx_runtime = require("react/jsx-runtime");
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
var pageStyle = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
  fontSize: 13,
  color: "var(--fg, #1f2328)"
};
var headerStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 12px",
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
function GradeBadge({ grade, large }) {
  const g = (grade ?? "?").toUpperCase();
  const color = GRADE_COLORS[g] ?? "#64748b";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
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
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: mutedStyle, children: [
    "\u2605 ",
    n.toLocaleString()
  ] });
}
function ErrorNote({ error }) {
  const code = error instanceof ApiError ? error.code : "internal";
  const text = code === "upstream" ? L("\u4E0A\u6E38\u6570\u636E\u6682\u65F6\u4E0D\u53EF\u7528\uFF08dsh-insights.com \u62C9\u53D6\u5931\u8D25\uFF09\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5", "Upstream data temporarily unavailable (dsh-insights.com fetch failed); please retry later") : code === "network" ? L("\u65E0\u6CD5\u8FDE\u63A5\u672C\u673A dsh web \u670D\u52A1", "Cannot reach the local dsh web service") : error?.message ?? String(error);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...cardStyle, borderColor: "#dc2626", color: "#dc2626" }, children: text });
}
function CheckSection(props) {
  const { query, onQueryChange, result, onCheck } = props;
  const [input, setInput] = (0, import_react.useState)(query);
  const [hint, setHint] = (0, import_react.useState)("");
  (0, import_react.useEffect)(() => {
    if (query) setInput(query);
  }, [query]);
  function submit() {
    const parsed = parseRepoInput(input);
    if (!parsed) {
      setHint(L("\u8BF7\u8F93\u5165 owner/repo \u6216 GitHub \u4ED3\u5E93 URL", "Enter owner/repo or a GitHub repository URL"));
      return;
    }
    setHint("");
    onQueryChange(parsed);
    onCheck(parsed);
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, marginBottom: 4 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          style: inputStyle,
          value: input,
          placeholder: L("owner/repo \u6216 https://github.com/owner/repo", "owner/repo or https://github.com/owner/repo"),
          onChange: (event) => setInput(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") submit();
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: buttonStyle, onClick: submit, disabled: result.state === "loading", children: result.state === "loading" ? L("\u67E5\u8BE2\u4E2D\u2026", "Checking\u2026") : L("\u67E5\u9A8C", "Check") })
    ] }),
    hint && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...mutedStyle, color: "#ea580c", marginBottom: 8 }, children: hint }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...mutedStyle, marginBottom: 12 }, children: L(
      "\u88C5\u63D2\u4EF6\u524D\u67E5\u4E00\u67E5\uFF1A\u5065\u5EB7\u5206\u6765\u81EA dsh-insights.com \u7684\u5168\u91CF\u6743\u5A01\u96C6\uFF08\u5BA2\u89C2\u542F\u53D1\u5F0F\u4FE1\u53F7\uFF0C\u975E\u5B89\u5168\u5BA1\u8BA1\uFF09\u3002",
      "Check before you install: health scores come from the dsh-insights.com authoritative corpus (objective heuristic signals, not a security audit)."
    ) }),
    result.state === "error" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ErrorNote, { error: result.error }),
    result.notInCorpus && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: cardStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 600, marginBottom: 4 }, children: L("\u4E0D\u5728\u6743\u5A01\u96C6", "Not in the authoritative corpus") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: mutedStyle, children: L(
        "dsh-insights.com \u7684\u6743\u5A01\u96C6\u4E2D\u6CA1\u6709\u6536\u5F55\u8BE5\u4ED3\u5E93\u2014\u2014\u5B83\u53EF\u80FD\u4E0D\u662F dsh \u63D2\u4EF6\u3001\u592A\u65B0\u5C1A\u672A\u88AB\u589E\u91CF\u53D1\u73B0\u6536\u5F55\uFF0C\u6216\u672A\u6EE1\u8DB3\u6536\u5F55\u95E8\u69DB\u3002",
        "This repository is not in the dsh-insights.com corpus \u2014 it may not be a dsh plugin, may be too new for incremental discovery, or may not meet the listing bar."
      ) })
    ] }),
    result.card && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(HealthCard, { card: result.card, generatedAt: result.generatedAt })
  ] });
}
function HealthCard({ card, generatedAt }) {
  const [owner, repo] = card.full_name.split("/");
  const pageUrl = `${SITE}/p/${owner}/${repo}/`;
  const dims = Object.entries(card.dimScores);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: cardStyle, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(GradeBadge, { grade: card.grade, large: true }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { minWidth: 0 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 700, fontSize: 15, wordBreak: "break-all" }, children: card.full_name }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: mutedStyle, children: [
          card.score !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { marginRight: 10 }, children: [
            L("\u5065\u5EB7\u5206", "Score"),
            " ",
            card.score,
            "/100"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stars, { n: card.stars }),
          card.npm && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { marginLeft: 10 }, children: [
            card.npm,
            card.version ? `@${card.version}` : ""
          ] })
        ] })
      ] })
    ] }),
    card.description && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginBottom: 10 }, children: card.description }),
    dims.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 10 }, children: dims.map(([dim, value]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", ...mutedStyle }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: DIM_LABELS[dim] ? L(DIM_LABELS[dim].zh, DIM_LABELS[dim].en) : dim }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: value })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { height: 6, borderRadius: 3, background: "var(--border, #e2e5e9)", overflow: "hidden" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { width: `${Math.max(0, Math.min(100, value))}%`, height: "100%", background: value >= 90 ? "#16a34a" : value >= 60 ? "#2563eb" : "#ea580c" } }) })
    ] }, dim)) }),
    card.drops.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginBottom: 10 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 600, marginBottom: 4 }, children: L("\u6263\u5206\u660E\u7EC6", "Deductions") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: { margin: 0, paddingLeft: 0, listStyle: "none" }, children: card.drops.map((drop) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: { display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: SEV_COLORS[drop.sev] ?? "#64748b", fontSize: 11, fontWeight: 700, minWidth: 44, textTransform: "uppercase" }, children: drop.sev }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: L(drop.label.zh, drop.label.en) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { style: { ...mutedStyle, fontSize: 11 }, children: drop.code })
      ] }, drop.code)) })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...mutedStyle, marginBottom: 10 }, children: L("\u65E0\u6263\u5206\u9879", "No deductions") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 12 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", { href: pageUrl, target: "_blank", rel: "noreferrer", style: { color: "#2563eb" }, children: L("\u5728 dsh-insights.com \u67E5\u770B\u5B8C\u6574\u9875 \u2197", "View full page on dsh-insights.com \u2197") }),
      generatedAt && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: mutedStyle, children: L("\u6570\u636E\u751F\u6210\u4E8E {at}", "Data generated at {at}", { at: generatedAt.slice(0, 10) }) })
    ] })
  ] });
}
function ScenariosSection(props) {
  const { doc, state, error, onPick } = props;
  if (state === "loading" || state === "idle") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: mutedStyle, children: L("\u52A0\u8F7D\u573A\u666F\u63A8\u8350\u2026", "Loading scenario picks\u2026") });
  if (state === "error") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ErrorNote, { error });
  const scenarios = doc?.scenarios ?? [];
  if (scenarios.length === 0) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: mutedStyle, children: L("\u6682\u65E0\u573A\u666F\u6570\u636E", "No scenario data yet") });
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...mutedStyle, marginBottom: 12 }, children: L("\u6309\u4F7F\u7528\u573A\u666F\u53D1\u73B0\u63D2\u4EF6\uFF08{n} \u4E2A\u573A\u666F\uFF09\uFF1B\u70B9\u4EFB\u610F\u63D2\u4EF6\u8DF3\u5230\u300C\u67E5\u9A8C\u300D\u3002", "Discover plugins by use case ({n} scenarios); click any plugin to jump to Check.", { n: scenarios.length }) }),
    scenarios.map((scenario) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: cardStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontWeight: 700, marginBottom: 6 }, children: [
        L(scenario.zh ?? scenario.id, scenario.en ?? scenario.id),
        typeof scenario.candidates === "number" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...mutedStyle, fontWeight: 400, marginLeft: 8 }, children: L("{n} \u4E2A\u5019\u9009", "{n} candidates", { n: scenario.candidates }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: { margin: 0, paddingLeft: 0, listStyle: "none" }, children: (scenario.plugins ?? []).map((plugin) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "button",
        {
          onClick: () => onPick(plugin.full_name),
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
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(GradeBadge, { grade: plugin.grade }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontWeight: 600, wordBreak: "break-all" }, children: plugin.full_name }),
            typeof plugin.stars === "number" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stars, { n: plugin.stars }),
            plugin.reasons && plugin.reasons.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...mutedStyle, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: plugin.reasons[0] })
          ]
        }
      ) }, plugin.full_name)) })
    ] }, scenario.id))
  ] });
}
function DynamicsSection(props) {
  const { doc, state, error } = props;
  if (state === "loading" || state === "idle") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: mutedStyle, children: L("\u52A0\u8F7D\u751F\u6001\u52A8\u6001\u2026", "Loading ecosystem dynamics\u2026") });
  if (state === "error") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ErrorNote, { error });
  if (!doc) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: mutedStyle, children: L("\u6682\u65E0\u52A8\u6001\u6570\u636E", "No dynamics data yet") });
  const releases = doc.dsh?.releases ?? [];
  const platform = doc.platform ?? [];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: cardStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontWeight: 700, marginBottom: 6 }, children: [
        L("dsh \u5B98\u65B9 Release", "Official dsh releases"),
        doc.dsh?.repo && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { ...mutedStyle, fontWeight: 400, marginLeft: 8 }, children: [
          doc.dsh.repo,
          " ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stars, { n: doc.dsh.stars ?? 0 })
        ] })
      ] }),
      releases.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: mutedStyle, children: L("\u6682\u65E0 release \u8BB0\u5F55", "No releases recorded") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: { margin: 0, paddingLeft: 0, listStyle: "none" }, children: releases.map((rel) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: { padding: "6px 0", borderTop: "1px solid var(--border, #eef1f4)" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { style: { fontWeight: 700 }, children: rel.name ?? rel.tag }),
          rel.breaking && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { background: "#dc2626", color: "#fff", borderRadius: 4, fontSize: 11, fontWeight: 700, padding: "1px 6px" }, children: "BREAKING" }),
          rel.prerelease && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...mutedStyle, border: "1px solid var(--border, #e2e5e9)", borderRadius: 4, padding: "0 6px" }, children: "pre" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: mutedStyle, children: (rel.published_at ?? "").slice(0, 10) }),
          (typeof rel.added === "number" || typeof rel.fixed === "number") && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: mutedStyle, children: [
            "+",
            rel.added ?? 0,
            " / fix ",
            rel.fixed ?? 0
          ] })
        ] }),
        rel.summary && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...mutedStyle, marginTop: 2 }, children: rel.summary })
      ] }, rel.tag)) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: cardStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 700, marginBottom: 6 }, children: L("\u5E73\u53F0\u4ED3\u5E93\u52A8\u6001", "Platform repository activity") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: { margin: 0, paddingLeft: 0, listStyle: "none" }, children: platform.map((repo) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 0", flexWrap: "wrap" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontWeight: 600 }, children: repo.repo }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stars, { n: repo.stars ?? 0 }),
        repo.latestRelease ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("code", { style: mutedStyle, children: [
          repo.latestRelease.name ?? repo.latestRelease.tag,
          " (",
          (repo.latestRelease.published_at ?? "").slice(0, 10),
          ")"
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: mutedStyle, children: L("\u65E0 release", "no release") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: mutedStyle, children: L("push \u4E8E {at}", "pushed {at}", { at: (repo.pushed_at ?? "").slice(0, 10) }) })
      ] }, repo.repo)) })
    ] }),
    doc.fetchedAt && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: mutedStyle, children: L("\u52A8\u6001\u6293\u53D6\u4E8E {at}", "Dynamics fetched at {at}", { at: doc.fetchedAt.slice(0, 16).replace("T", " ") }) })
  ] });
}
function InsightsView(_props) {
  const [section, setSection] = (0, import_react.useState)("check");
  const [checkQuery, setCheckQuery] = (0, import_react.useState)("");
  const [check, setCheck] = (0, import_react.useState)({ state: "idle" });
  const [scenariosDoc, setScenariosDoc] = (0, import_react.useState)(void 0);
  const [scenariosState, setScenariosState] = (0, import_react.useState)("idle");
  const [scenariosError, setScenariosError] = (0, import_react.useState)(void 0);
  const [dynamicsDoc, setDynamicsDoc] = (0, import_react.useState)(void 0);
  const [dynamicsState, setDynamicsState] = (0, import_react.useState)("idle");
  const [dynamicsError, setDynamicsError] = (0, import_react.useState)(void 0);
  const [, setLocaleTick] = (0, import_react.useState)(0);
  function runCheck(fullName) {
    setCheck({ state: "loading" });
    fetchPlugin(fullName).then((res) => setCheck({ state: "ready", card: res.plugin, generatedAt: res.generatedAt })).catch((error) => {
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
    if (section === "dynamics" && dynamicsState === "idle") {
      setDynamicsState("loading");
      fetchDynamics().then((res) => {
        setDynamicsDoc(res.dynamics);
        setDynamicsState("ready");
      }).catch((error) => {
        setDynamicsError(error);
        setDynamicsState("error");
      });
    }
  }, [section, scenariosState, dynamicsState]);
  function pickFromScenario(fullName) {
    setCheckQuery(fullName);
    setSection("check");
    runCheck(fullName);
  }
  const tabs = [
    { id: "check", label: L("\u67E5\u9A8C", "Check") },
    { id: "scenarios", label: L("\u573A\u666F", "Scenarios") },
    { id: "dynamics", label: L("\u52A8\u6001", "Dynamics") }
  ];
  let body;
  if (section === "check") {
    body = /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CheckSection, { query: checkQuery, onQueryChange: setCheckQuery, result: check, onCheck: runCheck });
  } else if (section === "scenarios") {
    body = /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ScenariosSection, { doc: scenariosDoc, state: scenariosState, error: scenariosError, onPick: pickFromScenario });
  } else {
    body = /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DynamicsSection, { doc: dynamicsDoc, state: dynamicsState, error: dynamicsError });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: pageStyle, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: headerStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontWeight: 700 }, children: "DSH Insights" }),
      tabs.map((tab) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: subTabStyle(section === tab.id), onClick: () => setSection(tab.id), children: tab.label }, tab.id)),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", { href: SITE, target: "_blank", rel: "noreferrer", style: { ...mutedStyle, color: "#2563eb" }, children: "dsh-insights.com \u2197" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
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
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: bodyStyle, children: body })
  ] });
}

// src/client/index.ts
var name = "insights";
var inject = ["slots"];
function apply(raw) {
  const ctx = raw;
  const log = ctx.logger("insights:client");
  ctx.slots.inject(
    "conversation.view",
    () => ctx.slots.register(
      {
        name: "conversation.view",
        id: "insights",
        order: 30,
        label: () => L("\u751F\u6001", "Ecosystem")
      },
      InsightsView
    )
  );
  log.info("DSH Insights registered as session view tab (\u5BF9\u8BDD | \u8F68\u8FF9 | \u751F\u6001)");
}

		return module.exports;
	}
});

