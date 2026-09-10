# dsh-insights-kit
[![DSH Insights health](https://dsh-insights.com/badge/ice5kysl/dsh-insights-kit.svg)](https://dsh-insights.com/p/ice5kysl/dsh-insights-kit/)

> GitHub: <https://github.com/ice5kysl/dsh-insights-kit> ｜ MIT License ｜ Target dsh: `@deepseek-ai/dsh` ≥ 0.1.1-rc.2 ｜ English · [简体中文](./README.zh-CN.md)

A **dsh (DeepSeek Harness) plugin** written to official conventions, in "bundle" form — the thin in-dsh client of **[dsh-insights.com](https://dsh-insights.com)**, the observatory of the dsh plugin ecosystem (health grades S–D for the whole corpus, scenario picks, ecosystem dynamics, published as open JSON). It solves one pain point:

> Before installing a plugin you want to know whether it's healthy — but today that means leaving dsh, opening a browser, and hunting the site down by hand.

This plugin brings the answer **inside dsh Web**: an always-visible ✦ button in the sidebar footer opens the「生态」panel (a right-side drawer over the app) with three sections:

- **体检 Audit** — enumerates your **installed plugins** straight from the active profile's manifest (`~/.dsh/profiles/<profile>/package.json`, read host-side — the same seam `dsh plugin add` operates on, so it works on every build) and health-checks them in one batch: grade badge + score per plugin, an S/A/B/C/D summary bar, **npm version-drift hints** (npm latest ≠ repo version), a **per-row dsh-compat signal** (`engines.dsh` or cordis peer range from compat.json, with a conservative ✓/⚠ verdict against your running dsh when decidable), and "better alternatives ↗" links on low-grade (C/D) rows — plus a **running-vs-latest dsh version line** (upgrade hint when behind), a **BREAKING-release alert card** warning when official dsh releases may require plugin adaptation, and a **shell module-table pre-check**: every installed plugin's client-bundle requires are compared against the on-disk shell's resolvable set (what the next `dsh web` boot loads), so a plugin that would crash the loader on the current/next dsh build gets a red「won't load」mark — with a yellow notice up top when the on-disk dsh is already newer than the running one (upgrade pending, check before restarting). The list renders immediately (installed versions included); health cards are **cached per `name@version` for 24h**, so unchanged plugins skip re-auditing. If the local read fails, the page degrades gracefully to a **version & compatibility reminder** form (dist-tags, recent releases with BREAKING flagged, advised actions).
- **查验 Check** — paste `owner/repo` **or a GitHub URL**; get the plugin's health card: a large grade badge (S purple / A green / B blue / C orange / D red), the 0–100 score, four dimension bars (engineering / docs / discovery / maintenance), the full deduction list with severities, an **install/uninstall action row** (**one-click buttons** that run `pnpm add/remove` + edit the profile's bundle load list against your local profile — **hot-mount capable hosts activate immediately (just refresh the page)**, others take effect on the next `dsh web` restart — with an「Installed」marker and the uninstall variant when the plugin is already in your inventory; falls back to a copyable `dsh plugin` command on older host builds or when pnpm is unavailable; unpublished plugins get a "install from source" note + GitHub link instead), a **similar picks** section (top-5 same-category plugins by score), and a "view full page on dsh-insights.com ↗" link. **A bare keyword (no `/`) searches the corpus instead** (debounced, substring match over name + description, ranked by stars; click a hit to load its card). Repos outside the authoritative corpus get a clear **"Not in the authoritative corpus"** notice plus a **similar-plugins** list (auto-searched by repo name) instead of a fake score.
- **场景 Scenarios** — browse scenario-based recommendations (name / grade / one-line reason per plugin, plus an **「Installed」marker** on plugins you already have); clicking any plugin jumps straight to Check with its card loaded.
- **One-click install/uninstall** — scenario and audit rows carry **install/uninstall buttons** that operate on the local profile directly (pnpm + the `dsh.profile.bundles` load list). **Restart-free on capable hosts**: freshly installed plugins hot-mount into the running composition (the vendored include plugin's subtree, dsh-market's recipe) and removals live-disable their loader entry — a page refresh is all it takes; hosts without the hot-mount capability converge on the next `dsh web` restart (the manifest state is always durable). Guarded: POST-only routes behind the host-trust gate, a required custom header, strict npm-name validation, corpus-scoped installs, arg-array pnpm spawn (no shell), and a `DSH_INSIGHTS_NO_MUTATE=1` kill switch. On older host builds or machines without pnpm the buttons degrade to **copyable `dsh plugin` commands**.
- **Bilingual zh/en UI**: auto-detected from the browser language (zh → Chinese, anything else → English); a 「中 / EN」 button in the panel header switches at any time and remembers the preference.

### Author self-check (CLI)

For plugin authors, the health-v5 rulebook also runs as a CLI against a **local plugin directory**:

```bash
npx dsh-insights-kit selfcheck /abs/path/to/your-plugin [--json] [--lang zh|en]
```

It prints the score + grade, deductions grouped by category **with per-item fix guidance**, a **read-only surface scan** summary (fs writes / child processes / HTTP write verbs / sanitization refs), **npm consistency** (published / latest vs local version / release staleness; registry base overridable via `DSH_INSIGHTS_NPM_REGISTRY`), and a **shell seed-drift guard**: the built client bundle's external requires are checked against the current dsh shell's module table when an install tree is locatable (auto-detected global installs, or `DSH_INSIGHTS_DSH_ROOT`; a stale require — the load-crash class — scores as a major deduction `compat.missing-seed`). Exit code is **1 when any fail-tier deduction is present** (e.g. missing README), otherwise 0 — usable as a CI pre-publish gate; 2 on usage/path errors. Read-only — it never modifies the directory.

The report may also carry **zero-weight hints** (never scored, never affecting the exit code) — `manifest.no-engines-dsh` when the plugin does not declare an `"engines": {"dsh": "^x.y.z"}` range (the dsh compatibility signal the audit panel and `compat.json` display), and `compat.seed-unchecked` when the client bundle has external requires but no dsh install tree was locatable for the seed-drift guard.

## Why host-side routes are needed (design notes)

The browser face never talks to dsh-insights.com directly. All data flows through the official **`ctx.webServer.register`** route seam (`dsh-host-webserver`), which keeps the dsh web server's loopback trust posture as the only network boundary:

| Endpoint (GET) | Description |
|---|---|
| `/dsh-insights/plugin?full_name=owner/repo` | One plugin's health card, trimmed (`full_name/stars/grade/score/dimScores/drops/npm/version/description/url`); upstream drop codes enriched to `{code, sev, label}`; plus `similar`: top-5 same-category picks from `enrich.json` (empty when the plugin has no category); 404 `not-in-corpus` when absent |
| `/dsh-insights/search?q=&limit=20` | Case-insensitive substring match over `full_name` + `description`, ranked by stars; compact rows (no `dimScores`/`drops`) |
| `/dsh-insights/audit?npm=a,b,c` | Batch health lookup by npm package name (powers 体检 Audit): each name → trimmed card or null (unlisted); hits carry a `compat` slice (`engines.dsh` + first 3 dsh peers, joined from `compat.json`) |
| `/dsh-insights/scenarios` | `scenarios.json`, with each pick annotated by its npm `pkgName` (joined from the corpus on `full_name`, omitted when unknown) to power the copyable install/uninstall commands |
| `/dsh-insights/dynamics` | `dynamics.json` passthrough, with the dsh npm dist-tags overlaid live from the registry (5-min cache, best-effort — the site regenerates ~daily, so its tags lag a fresh release by up to a day; `distTagsAt` marks the overlay time) |
| `/dsh-insights/runtime` | The running dsh version, resolved host-side from `@deepseek-ai/dsh-web-app` / `dsh-base` package.json (`null` when not resolvable) |
| `/dsh-insights/installed` | The active profile's installed plugins, read from the profile manifest (`~/.dsh/profiles/<profile>`; override via `DSH_INSIGHTS_PROFILE_DIR` / `DSH_INSIGHTS_PROFILE`): `{profile, baseline, plugins: [{name, spec, version, plugin, enabled}]}` — in-box `@deepseek-ai/*` bundles counted as `baseline`, not listed; local filesystem only, no upstream fetch |
| `/dsh-insights/compat` | Client-bundle × shell module-table check: every enabled plugin's external requires vs the on-disk shell's resolvable set (seed words baked into `dsh-web-frontend`'s shell asset + graph-row packages with a client surface; shell located via `DSH_INSIGHTS_DSH_ROOT` → in-process resolution → the dsh CLI's own path). `{shell: {version, seedWords} | null, rows: [{name, status, requires, missing}]}` with `status` ∈ ok / broken / unknown / no-client; local only |
| `POST /dsh-insights/install` | One-click install into the active profile (`pnpm add` + append to `dsh.profile.bundles` + hot-mount into the running composition when the host supports it); body `{name}`; corpus-scoped (the name must be a plugin package in insights.json); requires the `x-dsh-insights-kit: mutate` header; response carries `hot` (live now) / `restartRequired` |
| `POST /dsh-insights/uninstall` | Live-disable the loader entry (or dispose the hot mount) + drop from the bundles list + `pnpm remove`; body `{name}`; restricted to actually-installed names; **409 `has-dependents` (+ `dependents` list) while other installed packages declare the target as a dependency**; same header requirement |
| `/dsh-insights/health` | Liveness + per-document cache age + capability flags: `mutations` (kill switch `DSH_INSIGHTS_NO_MUTATE=1` + pnpm probe) and `hotMount` (vendored include plugin importable) |

- **Upstream**: `https://dsh-insights.com/data/{insights,scenarios,dynamics,compat,enrich}.json` — fetched lazily on first request, cached in memory with a **6-hour TTL**; failed fetches return **502 + JSON error** and never poison the cache. Exception: `/dynamics`'s dsh dist-tags are refreshed straight from the npm registry on a **5-minute TTL** (override with `DSH_INSIGHTS_NPM_REGISTRY`) so the「latest release」line is fresh on announcement day; any registry failure keeps the snapshot's tags.
- **Read-only**, no write endpoints; every request passes a host-trust gate mirroring the official `/api` fence (loopback Host trusted; otherwise a same-origin Origin marker). **Not an auth layer** — same posture as the official web server (binds 127.0.0.1 by default).
- Routes are registered via `ctx.effect(() => ctx.webServer.register(...))` and released automatically when the plugin's fiber unmounts.

See [docs/DESIGN.md](./docs/DESIGN.md) for the full architecture note.

## Quick install (personal dsh on this machine)

From npm (once published):

```bash
dsh plugin --profile web add dsh-insights-kit
```

Manual (from a clone):

```bash
git clone https://github.com/ice5kysl/dsh-insights-kit.git
cd dsh-insights-kit
npm install && npm run build
bash scripts/install-personal.sh   # = dsh plugin --profile web add <this dir>
```

Then restart `dsh web` and refresh the browser (http://127.0.0.1:3080). A ✦ 生态 button appears in the sidebar footer — click it to open the panel.

## Screenshots

| 体检 Audit | 查验 Check | 场景 Scenarios |
|---|---|---|
| _(screenshot placeholder)_ | _(screenshot placeholder)_ | _(screenshot placeholder)_ |

## Data source & license

- **Data**: [dsh-insights.com](https://dsh-insights.com) open dataset (`/data/*.json`). Health scores are **objective heuristic signals, not a security audit**; the scoring rules (health-v5) are documented in the site's `docs/SCHEMA.md`. Data licensing follows the site's DATA-LICENSE.
- **Code**: MIT © ice5kysl.

## Development

```bash
npm install
npm run build        # esbuild three-entry build → lib/{index,client,cli}.js
npm run typecheck    # tsc --noEmit (strict)
npm test             # host-face + CLI smoke test against local fixtures (no network)
```

CI runs install → typecheck → build → smoke → `npm pack --dry-run` on every push (see `.github/workflows/ci.yml`).
