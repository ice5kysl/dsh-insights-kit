# dsh-insights-kit — architecture notes

A standard Cordis **bundle** plugin for dsh (DeepSeek Harness), built to the
same engineering conventions as `dsh-file-explorer-kit` / `dsh-workspace-kit`:
one Loader entry, two faces, one build.

## Two faces, one package

```
src/host/index.ts   ──build──▶ lib/index.js   (ESM, node; runtime deps: node builtins only)
src/client/index.ts ──build──▶ lib/client.js  (CJS body in the window.__ModuleLoader__.load envelope)
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
dsh-insights.com/data/{insights,dynamics}.json  (open dataset, regenerated ~daily)
raw.githubusercontent.com/ice5kysl/dsh-insights/main/data/scenarios.json
        (scenarios.json is tracked in the public repo but not served under the
        site's /data/; DSH_INSIGHTS_UPSTREAM_BASE overrides all docs to one origin)
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
| `/plugin?full_name=owner/repo` | One plugin's health card, trimmed: `full_name/stars/grade/score/dimScores/drops/npm/version/description/url`. Upstream drops are bare code strings; the host enriches them to `{code, sev, label:{zh,en}}` via the health-v5 rule table (`src/host/drops.ts`). 404 `not-in-corpus` when absent. |
| `/search?q=&limit=20` | Case-insensitive substring match over `full_name` + `description`, ranked by stars desc; compact rows without `dimScores`/`drops`. Limit capped at 50. |
| `/audit?npm=a,b,c` | Batch health lookup keyed by npm package name (the 体检 Audit page): each name maps to a trimmed card (matched on the corpus row's `pkgName`, case-insensitive) or null when unlisted. Comma-separated, capped at 100 names. |
| `/scenarios` | `scenarios.json` passthrough. |
| `/dynamics` | `dynamics.json` passthrough. |
| `/health` | Liveness + per-document cache age/staleness. |

Every request passes a host-trust gate mirroring the official `/api` fence
(loopback Host trusted outright; otherwise a same-origin Origin marker is
required). This is not an auth layer — same posture as the official web
server, which binds 127.0.0.1 by default.

Upstream errors surface as `502 { ok:false, error:{code:'upstream'} }`;
malformed input as 400; missing corpus entries as 404. All responses carry an
`ok` envelope (`{ ok:true, ... }` / `{ ok:false, error:{code,message} }`).

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
  `scripts/smoke.mjs` runs the whole surface against a local fixture server
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

Three capability sections, each fetching lazily on first visit:

1. **体检 Audit** — installed-plugin health check (see the enumeration note
   below): per-plugin grade badge + score, an S/A/B/C/D summary bar, npm
   version-drift badges (`npmLatest ≠ version`), "better alternatives ↗"
   links on C/D rows (to the plugin's dsh-insights.com page, which carries
   same-category recommendations), and a BREAKING-release alert card fed by
   `dynamics.json`. Unlisted plugins render as「未收录」rows.
2. **查验 Check** — `owner/repo` or pasted GitHub URL (`parseRepoInput`) →
   `/plugin` → health card: grade badge (S 紫/A 绿/B 蓝/C 橙/D 红), score,
   dimension bars, deduction list (severity-colored), npm-latest drift hint,
   link out to `https://dsh-insights.com/p/<owner>/<repo>/`;「不在权威集」
   notice on `not-in-corpus`. Rows in Audit/Scenarios jump here.
3. **场景 Scenarios** — scenario cards with recommended plugin rows;
   clicking a row jumps to Check with that plugin loaded.

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
(local `dsh plugin add <path>` installs) reduce to their basename; the
official `@deepseek-ai/*` baseline and disabled entries are excluded. The
resulting names are health-checked in one `/dsh-insights/audit` batch.

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

`scripts/smoke.mjs` (run as `npm test`, also in CI) boots a fixture upstream +
a fake `ctx.webServer` and covers: trimming + drop enrichment (+ `npmLatest`),
corpus 404, input validation, search matching/ranking/limits, the audit batch
lookup (hit/null/case/400), the inventory-entry → npm-name mapping and
filtering (imported from `src/shared/installed.ts`, node type-stripping),
both passthroughs, cache health, the trust gate (403/200), upstream-failure →
502, and cache isolation across instances. CI:
`npm install → typecheck → build → smoke → npm pack --dry-run`.
