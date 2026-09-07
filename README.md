# dsh-insights-kit

> GitHub: <https://github.com/ice5kysl/dsh-insights-kit> ｜ MIT License ｜ Target dsh: `@deepseek-ai/dsh` ≥ 0.1.1-rc.2 ｜ English · [简体中文](./README.zh-CN.md)

A **dsh (DeepSeek Harness) plugin** written to official conventions, in "bundle" form — the thin in-dsh client of **[dsh-insights.com](https://dsh-insights.com)**, the observatory of the dsh plugin ecosystem (health grades S–D for the whole corpus, scenario picks, ecosystem dynamics, published as open JSON). It solves one pain point:

> Before installing a plugin you want to know whether it's healthy — but today that means leaving dsh, opening a browser, and hunting the site down by hand.

This plugin brings the answer **inside dsh Web**: an always-visible ✦ button in the sidebar footer opens the「生态」panel (a right-side drawer over the app) with three sections:

- **体检 Audit** — enumerates your **installed plugins** through the official `pluginInventory` Remote (live Cordis Loader state) and health-checks them in one batch: grade badge + score per plugin, an S/A/B/C/D summary bar, **npm version-drift hints** (npm latest ≠ repo version), and "better alternatives ↗" links on low-grade (C/D) rows — plus a **BREAKING-release alert card** warning when official dsh releases may require plugin adaptation. Builds that don't expose the inventory gateway degrade gracefully to a **version & compatibility reminder** form (dist-tags, recent releases with BREAKING flagged, advised actions).
- **查验 Check** — paste `owner/repo` **or a GitHub URL**; get the plugin's health card: a large grade badge (S purple / A green / B blue / C orange / D red), the 0–100 score, four dimension bars (engineering / docs / discovery / maintenance), the full deduction list with severities, and a "view full page on dsh-insights.com ↗" link. Repos outside the authoritative corpus get a clear **"Not in the authoritative corpus"** notice instead of a fake score.
- **场景 Scenarios** — browse scenario-based recommendations (name / grade / one-line reason per plugin); clicking any plugin jumps straight to Check with its card loaded.
- **Bilingual zh/en UI**: auto-detected from the browser language (zh → Chinese, anything else → English); a 「中 / EN」 button in the panel header switches at any time and remembers the preference.

## Why host-side routes are needed (design notes)

The browser face never talks to dsh-insights.com directly. All data flows through the official **`ctx.webServer.register`** route seam (`dsh-host-webserver`), which keeps the dsh web server's loopback trust posture as the only network boundary:

| Endpoint (GET) | Description |
|---|---|
| `/dsh-insights/plugin?full_name=owner/repo` | One plugin's health card, trimmed (`full_name/stars/grade/score/dimScores/drops/npm/version/description/url`); upstream drop codes enriched to `{code, sev, label}`; 404 `not-in-corpus` when absent |
| `/dsh-insights/search?q=&limit=20` | Case-insensitive substring match over `full_name` + `description`, ranked by stars; compact rows (no `dimScores`/`drops`) |
| `/dsh-insights/audit?npm=a,b,c` | Batch health lookup by npm package name (powers 体检 Audit): each name → trimmed card or null (unlisted) |
| `/dsh-insights/scenarios` | `scenarios.json` passthrough |
| `/dsh-insights/dynamics` | `dynamics.json` passthrough |
| `/dsh-insights/health` | Liveness + per-document cache age |

- **Upstream**: `https://dsh-insights.com/data/{insights,dynamics}.json`, plus `scenarios.json` from the public repo's raw file (it isn't served under the site's `/data/`) — fetched lazily on first request, cached in memory with a **6-hour TTL**; failed fetches return **502 + JSON error** and never poison the cache.
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
npm run build        # esbuild double-sided build → lib/index.js + lib/client.js
npm run typecheck    # tsc --noEmit (strict)
npm test             # host-face smoke test against local fixtures (no network)
```

CI runs install → typecheck → build → smoke → `npm pack --dry-run` on every push (see `.github/workflows/ci.yml`).
