# dsh-insights-kit — architecture notes

A standard Cordis **bundle** plugin for dsh (DeepSeek Harness), built to the
same engineering conventions as `dsh-file-explorer-kit` / `dsh-workspace-kit`:
one Loader entry, two faces, one build.

## Two faces, one package

```
src/host/index.ts   ──build──▶ lib/index.js   (ESM, node; runtime deps: node builtins only)
src/client/index.ts ──build──▶ lib/client.js  (CJS body in the window.__ModuleLoader__.load envelope)
src/cli.ts          ──build──▶ lib/cli.js     (ESM, node + shebang; the `dsh-insights-kit` bin)
```

- `package.json` `main`/`exports["."]` → host face; `exports["./client"]` +
  `dsh.client` metadata → the browser face served over `/plugins`.
- `cordis.patch.yml` carries a single `insert` entry (`id: insights`,
  `name: dsh-insights-kit`) — the dsh client module system rejects
  multiple active sources resolving to one package name, so one entry carries
  both faces.
- The client bundle externalizes only `react` / `react/jsx-runtime`
  (satisfied by the shell-seeded platform baseline); `@deepseek-ai/*` imports
  are type-only everywhere, so the host artifact needs nothing beyond the
  loader's own runtime.

## Data flow

```
dsh-insights.com/data/{insights,scenarios,dynamics,compat,enrich}.json  (open dataset, regenerated ~daily)
        (DSH_INSIGHTS_UPSTREAM_BASE overrides all docs to one origin)
        ▲  lazy fetch on first request, in-memory cache, TTL 6h
        │  (failed fetches never poison the cache; concurrent firsts share one in-flight promise)
host face: GET /dsh-insights/* on ctx.webServer (read-only, JSON)
        ▲  same-origin fetch
client face: ✦ button in the official sidebar.footer.action slot opens the
        「生态」drawer registered in the shell.overlay slot
```

The browser never talks to dsh-insights.com directly — everything rides the
host routes, so the loopback trust posture of the dsh web server is the only
network boundary. (Installed-plugin enumeration is the one exception that
isn't data traffic: a local Typert Remote call, see below.)

## Host routes (`src/host/index.ts`, prefix `/dsh-insights`)

| Endpoint (GET) | Description |
|---|---|
| `/plugin?full_name=owner/repo` | One plugin's health card, trimmed: `full_name/stars/grade/score/dimScores/drops/npm/version/description/url`. Upstream drops are bare code strings; the host enriches them to `{code, sev, label:{zh,en}}` via the health-v5 rule table (`src/host/drops.ts`). The response also carries `similar`: top-5 same-category picks from `enrich.json` (score desc, stars tiebreak, self excluded; empty when no category; a failed enrich fetch degrades to `[]`). 404 `not-in-corpus` when absent. |
| `/search?q=&limit=20` | Case-insensitive substring match over `full_name` + `description`, ranked by stars desc; compact rows without `dimScores`/`drops`. Limit capped at 50. |
| `/audit?npm=a,b,c` | Batch health lookup keyed by npm package name (the 体检 Audit page): each name maps to a trimmed card (matched on the corpus row's `pkgName`, case-insensitive) or null when unlisted, with a `compat` slice attached to hits (`enginesDsh` + the first 3 `dshPeers`, joined from `compat.json` on npm name; a failed compat fetch degrades to no annotation). Comma-separated, capped at 100 names. |
| `/scenarios` | `scenarios.json`, with each pick annotated by its npm `pkgName` (joined from the corpus on `full_name`, omitted when unknown) so the client can offer copyable install/uninstall commands. |
| `/dynamics` | `dynamics.json` passthrough. |
| `/runtime` | The running dsh version, resolved host-side via `createRequire(import.meta.url)` from `@deepseek-ai/dsh-web-app/package.json` (fallback `@deepseek-ai/dsh-base/package.json`); `null` when neither resolves. Local-only — no upstream fetch. |
| `/health` | Liveness + per-document cache age/staleness. |

Every request passes a host-trust gate mirroring the official `/api` fence
(loopback Host trusted outright; otherwise a same-origin Origin marker is
required). This is not an auth layer — same posture as the official web
server, which binds 127.0.0.1 by default.

Upstream errors surface as `502 { ok:false, error:{code:'upstream'} }`;
malformed input as 400; missing corpus entries as 404. All responses carry an
`ok` envelope (`{ ok:true, ... }` / `{ ok:false, error:{code,message} }`).

## Author self-check (`src/host/selfcheck.ts` + `src/cli.ts`)

The author self-check is a **CLI**, not a panel section:
`dsh-insights-kit selfcheck <dir> [--json] [--lang zh|en]` (the package's
`bin` entry → `lib/cli.js`) wraps `runSelfcheck()` — the
[dsh-plugin-health](https://github.com/ice5kysl/dsh-plugin-health) CLI's
`--dir` capability as a plain library function:

- **Input validation**: the path must be absolute, contain no `..` segments,
  and resolve to an existing directory with a parseable `package.json`
  (`invalid-path` / `no-package-json` / `bad-package-json` /
  `not-a-directory` — CLI exit code 2). Everything it reads stays under that
  directory.
- **Scoring**: the health-v5 rulebook applied to the on-disk layout —
  manifest (`dsh.bundle.patch` declared + patch file present, `main =
  lib/index.js`, `exports["./client"]`, `files` whitelist, built `lib/`
  artifacts), docs (README presence + 400-byte floor, zh README, description,
  `docs/`), repo (LICENSE, keywords as the local topics proxy), engineering
  (tests, CI), and npm consistency (unpublished / version drift / single
  release / >90-day-stale, from the registry with a 10s timeout; registry
  base overridable via `DSH_INSIGHTS_NPM_REGISTRY`, and an unreachable
  registry skips npm rules instead of guessing). Weights and grade
  thresholds mirror the site: fail −20 / major −10 / warn −5 / minor −2 from
  100, S≥95/A≥90/B≥75/C≥60/D. Every deduction carries per-code fix guidance
  (`fix: {zh, en}`). Rules needing GitHub/git metadata (topics, activity,
  single-push, batch-import) are returned in `uncovered` with reasons and
  never scored.
- **Read-only surface scan**: ported from the CLI — fs writes (incl. bare
  `writeFileSync(` imports, which the CLI missed), child processes (`.exec(`
  regex calls excluded via lookbehind), HTTP write verbs (`Map.delete` etc.
  excluded the same way), sanitization references and
  `dangerouslySetInnerHTML`. Informational only — never affects the score.
- **CLI output**: text mode prints score + grade, deductions grouped by
  category with fix text (language from `--lang`, default `$LANG` zh* → 中文),
  zero-weight advisory **hints** (`hints: [{code, zh, en}]` — currently
  `manifest.no-engines-dsh` when no `engines.dsh` range is declared; never
  scored, never affecting the exit code), the scan summary, and the
  uncovered-rule codes; `--json` prints the full report. Exit code is **1
  when any fail-tier deduction exists**, else 0 — usable as a CI pre-publish
  gate.

## Caching (`src/host/upstream.ts`)

- One cache entry per upstream document (`insights` ≈ 6 MB, `scenarios`,
  `dynamics`), keyed by name, storing `{ data, fetchedAt }`.
- TTL 6 hours: the site regenerates roughly daily, so 6h keeps data fresh
  without hammering a static host; staleness is reported by `/health`.
- Lazy: nothing is fetched until the first request that needs the document.
- Failure-safe: a rejected fetch deletes only the in-flight marker, so the
  next request retries; a previously cached (now stale) document is *not*
  served in place of an error — callers get a clean 502 instead of
  silently-old data.
- Injectable (`baseUrl` / `fetchJson` / `ttlMs` / `now`) so
  `tests/smoke.test.mjs` runs the whole surface against a local fixture server
  with zero network access; `DSH_INSIGHTS_UPSTREAM_BASE` overrides the origin
  for the same purpose at runtime.

## Client face (`src/client`)

Entry-point seams (both official, additive — the same ones `dsh-workspace-kit`
uses, whose usage we verified in its source):

- `sidebar.footer.action` (list/root): an always-visible ✦ button
  (`SidebarAction.tsx`, `id: 'insights-kit.action'`). Slot components share no
  ctx, so the click reaches the panel via a `dsh-insights-kit:toggle-panel`
  window event — the same idiom as the workspace-kit sidebar toggle.
- `shell.overlay` (list/root): the panel (`InsightsPanel` in
  `InsightsView.tsx`, `id: 'insights-kit.panel'`). The slot is additive and
  click-through until an entry opts into pointer events, so the component
  stays mounted, renders `null` while closed, and draws a fixed backdrop +
  right-side drawer while open (Escape / backdrop click closes). This is why
  the entry moved off `conversation.view`: the toolkit is session-independent,
  and the drawer is reachable from every screen, not only inside a session.

Three capability sections, each fetching lazily on first visit (tab order:
体检 / 场景 / 查验):

1. **体检 Audit** — installed-plugin health check (see the enumeration note
   below): a「当前 dsh 版本 · 最新 release」line (running version from
   `/runtime`, latest from `dynamics.json` dist-tags, with an upgrade hint
   when behind on base versions), per-plugin grade badge + score, an
   S/A/B/C/D summary bar, npm version-drift badges (`npmLatest ≠ version`),
   a per-row dsh-compat line (`engines.dsh`, else the cordis peer range;
   ✓/⚠ verdict when the running version is known and the range is a simple
   ^/~ range — conservative base-version check, prerelease tags dropped, see
   `src/shared/compat.ts`), "better alternatives ↗" links on C/D rows (to
   the plugin's dsh-insights.com page, which carries same-category
   recommendations), a BREAKING-release alert card fed by `dynamics.json`,
   and a copyable uninstall command per row. Unlisted plugins render as
   「未收录」rows.
2. **场景 Scenarios** — scenario cards with recommended plugin rows; each
   row carries an「已安装」marker when the plugin is already installed (same
   inventory → audit chain as Audit) and a copyable install/uninstall
   command built from the host-annotated `pkgName`. Clicking a row jumps to
   Check with that plugin loaded.
3. **查验 Check** — input routed by `classifyCheckInput`: `owner/repo` or a
   pasted GitHub URL (`parseRepoInput`) → `/plugin` → health card (grade
   badge S 紫/A 绿/B 蓝/C 橙/D 红, score, dimension bars, severity-colored
   deduction list, npm-latest drift hint, link out to
   `https://dsh-insights.com/p/<owner>/<repo>/`, an install/uninstall action
   row — copyable `dsh plugin add/remove` command with an「已安装」marker
   when the plugin is in the inventory, a source-install note + GitHub link
   when unpublished — and a「相似推荐」section fed by the response's `similar`
   list, each pick loading its own card on click). A bare keyword (no `/`) →
   `/search`, a debounced (300 ms) corpus search list (grade badge + stars +
   truncated description per row, stale in-flight responses discarded via a
   generation counter), each hit loading its card on click. A
   「不在权威集」miss auto-searches the repo name once and lists similar
   plugins under the notice. Rows in Audit/Scenarios jump here.

The panel stays strictly read-only: install/uninstall is never performed
in-app — the buttons only copy the `dsh plugin --profile web add/remove`
command to the clipboard (run it in a terminal, then restart `dsh web`).

### Installed-plugin enumeration (research conclusion)

The seam exists and is official: `@deepseek-ai/dsh-host-plugin-inventory`
ships a read-only Typert Remote (`pluginInventory/list`) projecting the live
Cordis Loader entries `{ moduleName, enabled, fiberPhase }`, and the
client-side gateway (`ctx.remote`, provided by dsh-api-gateway — a core
service, so injecting `remote` is safe) exposes
`TypertClientRemote.$mount(contribution)` to mount any generated Remote
contribution at runtime from a dynamic plugin. We mount an inlined copy of
the generated descriptor with a `src-json` result codec instead of importing
the official artifact, because the artifact's only import is `zod`, which is
not guaranteed to resolve through the dsh client module system for a dynamic
plugin; the wire shape is identical, only client-side validation strictness
differs (`src/client/inventory.ts`).

Loader `moduleName`s reduce to npm name guesses (`src/shared/installed.ts`):
scoped/plain names pass through (subpaths trimmed), path-like specifiers
(local `dsh plugin add <path>` installs, including `link:`-prefixed ones)
reduce to their basename; the official `@deepseek-ai/*` baseline and disabled
entries are excluded, as is anything that is not npm-name-shaped after the
reduction (Loader-internal pseudo entries like `cordis:include` never reach
the audit batch). The resulting names are health-checked in one
`/dsh-insights/audit` batch.

Graceful degradation is first-class: if the running dsh build does not serve
the inventory gateway (mount throws, namespace absent, or `list()` errors),
the Audit section renders the **version & compatibility reminder** form —
npm dist-tags, recent releases with BREAKING flagged, and advised actions —
instead of failing. Verified locally against `0.1.1-rc.2` type artifacts;
the live mount can only be confirmed inside a running dsh web (see the repo
README's verification note).

- Bilingual zh/en: `src/shared/i18n.ts` is pure (importable from both faces);
  `src/client/locale.ts` resolves persisted preference → `navigator.language`
  → English, and the header 中/EN toggle re-renders in place.
- Styling is inline `CSSProperties` on the shell's CSS variables
  (`--fg`/`--bg`/`--border`), no UI dependency beyond React.

## Testing / CI

`tests/smoke.test.mjs` (run as `npm test`, also in CI) boots a fixture upstream,
a fake npm registry, four fixture plugin directories, and a fake
`ctx.webServer`; it covers: trimming + drop enrichment (+ `npmLatest`),
corpus 404, input validation, search matching/ranking/limits, the audit batch
lookup (hit/null/case/400) with its compat slice (engines.dsh + ≤3 peers),
the runtime-version probe shape, the inventory-entry → npm-name mapping and
filtering incl. pseudo-entry/link: handling (imported from
`src/shared/installed.ts`, node type-stripping), the conservative ^/~ range
check (`src/shared/compat.ts`), the scenarios `pkgName` annotation, the
查验 input router (`classifyCheckInput` from `src/client/api.ts`), the
plugin route's `similar` annotation (same-category top 5, self excluded,
empty without a category) and pkgName passthrough,
self-check as a library (`runSelfcheck()`: well-built S/100, skeletal
plugin's full deduction set, write-surface scan kinds, npm
drift/single/stale, path validation errors) and as a CLI subprocess
(`lib/cli.js` exit codes 0/1/2, `--json`, `--help`), both passthroughs,
cache health, the trust gate (403/200), upstream-failure → 502, and cache
isolation across instances. CI:
`npm install → typecheck → build → smoke → npm pack --dry-run`.
