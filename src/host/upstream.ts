/**
 * Upstream data layer for the dsh-insights host face.
 *
 * The DSH Insights site (dsh-insights.com) publishes its dataset as open
 * JSON documents; this module fetches them lazily on first request and keeps
 * them in memory with a 6-hour TTL (the site regenerates roughly daily, so
 * 6h keeps data fresh without hammering the static host):
 *
 * - `insights.json`  (~6 MB; per-plugin health rows for the whole corpus)
 * - `scenarios.json` (scenario → recommended plugins)
 * - `dynamics.json`  (dsh releases + platform repo activity)
 * - `compat.json`    (per-plugin engines.dsh / dsh-peer compat signals)
 * - `enrich.json`    (per-plugin score/grade/category — same-category picks)
 * - `compat-observed.json` (observed load-test matrix: plugin × shell version
 *   → ok/broken; newer site builds only — every consumer must degrade
 *   silently when it 404s)
 *
 * The store is dependency-injected (`fetchJson`, `baseUrl`, `ttlMs`) so the
 * smoke test can run it against a local fixture server with no network.
 * Trimming/search helpers are pure and exported for direct unit-style tests.
 *
 * One freshness overlay: `dynamics.json` regenerates ~daily, so its dsh
 * dist-tags lag an official release by up to a day. `npmDistTags()` fetches
 * `@deepseek-ai/dsh`'s dist-tags straight from the npm registry (free,
 * unauthenticated) on a 5-minute TTL; the `/dynamics` route overlays them so
 * the Audit tab's "latest release" is announcement-day fresh.
 *
 * @module dsh-insights-kit/upstream
 */

import { enrichDrops, type DropInfo } from './drops.ts'
import { DEFAULT_NPM_REGISTRY } from './selfcheck.ts'
import { compareBaseVersions } from '../shared/compat.ts'

export const DEFAULT_BASE_URL = 'https://dsh-insights.com/data'
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

/** The shell package whose dist-tags get the live registry overlay. */
const DSH_NPM_PACKAGE = '@deepseek-ai/dsh'

/**
 * Live dist-tags TTL: short enough to pick up a release the day it is
 * announced, long enough to stay a polite client of the registry.
 */
export const NPM_DIST_TAGS_TTL_MS = 5 * 60 * 1000

/**
 * Per-document default origins: the whole dataset is served under the site's
 * /data/. `StoreOptions.baseUrl` (or DSH_INSIGHTS_UPSTREAM_BASE) overrides
 * all three with a single `<base>/<name>.json` origin (fixtures, mirrors).
 */
const DEFAULT_DOC_URLS: Record<string, string> = {
  insights: `${DEFAULT_BASE_URL}/insights.json`,
  scenarios: `${DEFAULT_BASE_URL}/scenarios.json`,
  dynamics: `${DEFAULT_BASE_URL}/dynamics.json`,
  compat: `${DEFAULT_BASE_URL}/compat.json`,
  enrich: `${DEFAULT_BASE_URL}/enrich.json`,
  compatObserved: `${DEFAULT_BASE_URL}/compat-observed.json`,
}

// ── upstream wire shapes (only the fields this plugin reads) ─────────────────

export interface UpstreamPlugin {
  full_name: string
  url?: string
  stars?: number
  description?: string
  pkgName?: string
  version?: string
  npm?: { published?: boolean; latest?: string | null }
  health?: {
    score?: number
    grade?: string
    dimScores?: Record<string, number>
    drops?: string[]
  }
}

export interface InsightsData {
  generatedAt?: string
  plugins: UpstreamPlugin[]
}

// ── compat.json (engines.dsh / dsh-peer compat signals, CC BY 4.0) ───────────

export interface CompatPeer {
  name: string
  range: string
}

export interface CompatRow {
  pkgName?: string
  repo?: string
  stars?: number
  npmLatest?: string | null
  enginesDsh?: string | null
  engines?: string[]
  dshPeers?: CompatPeer[]
}

export interface CompatData {
  officialDsh?: {
    latest?: string
    distTags?: Record<string, string>
    versions?: Array<{ version?: string; isPrerelease?: boolean; time?: string }>
  }
  plugins?: CompatRow[]
}

/** The per-plugin compat slice served to the browser (peers capped at 3). */
export interface CompatInfo {
  enginesDsh: string | null
  dshPeers: CompatPeer[]
}

/**
 * Index compat.json rows by lowercased npm package name (the /audit route
 * joins on it). Each entry keeps only what the client renders: engines.dsh
 * and the first 3 dsh peers.
 */
export function compatByNpm(doc: unknown): Map<string, CompatInfo> {
  const map = new Map<string, CompatInfo>()
  const plugins = (doc as CompatData | null)?.plugins
  if (!Array.isArray(plugins)) return map
  for (const row of plugins) {
    if (!row || typeof row.pkgName !== 'string' || !row.pkgName) continue
    map.set(row.pkgName.toLowerCase(), {
      enginesDsh: typeof row.enginesDsh === 'string' && row.enginesDsh ? row.enginesDsh : null,
      dshPeers: (Array.isArray(row.dshPeers) ? row.dshPeers : [])
        .filter((p) => p && typeof p.name === 'string' && typeof p.range === 'string')
        .slice(0, 3),
    })
  }
  return map
}

// ── enrich.json (per-plugin score/grade/category — same-category picks) ──────

export interface EnrichRow {
  full_name?: string
  category?: string | null
  score?: number | null
  grade?: string | null
  stars?: number
}

/** Compact row for the「相似推荐」section of the plugin health card. */
export interface SimilarPick {
  full_name: string
  grade: string | null
  score: number | null
  stars: number
}

/**
 * Same-category recommendations for one plugin (mirrors the site's /p/ page
 * logic, ranked by score desc then stars desc): the top `limit` enrich rows
 * sharing the plugin's category, excluding the plugin itself. Empty when the
 * plugin has no category or no siblings.
 */
export function similarByCategory(doc: unknown, fullName: string, limit = 5): SimilarPick[] {
  const rows: EnrichRow[] = Array.isArray(doc)
    ? doc as EnrichRow[]
    : Array.isArray((doc as { plugins?: EnrichRow[] } | null)?.plugins)
      ? (doc as { plugins: EnrichRow[] }).plugins
      : []
  const target = fullName.toLowerCase()
  const self = rows.find((r) => r.full_name?.toLowerCase() === target)
  if (!self || typeof self.category !== 'string' || !self.category) return []
  return rows
    .filter((r) => r.category === self.category && r.full_name && r.full_name.toLowerCase() !== target)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.stars ?? 0) - (a.stars ?? 0))
    .slice(0, limit)
    .map((r) => ({
      full_name: r.full_name!,
      grade: typeof r.grade === 'string' ? r.grade : null,
      score: typeof r.score === 'number' ? r.score : null,
      stars: typeof r.stars === 'number' ? r.stars : 0,
    }))
}

// ── compat-observed.json (observed load-test matrix, CC BY 4.0) ─────────────
//
// The site's runner statically analyzes each plugin's client bundle against a
// matrix of historical dsh shell builds (code-state require literals × the
// loader's real resolution order). Wire shape (all fields optional in
// practice — parse defensively):
//
//   { generatedAt, allShellVersions: string[], shellDistTags: {latest,…},
//     plugins: { <npm name>: { repo, version, requires,
//       results: { <shell version>: {status:'ok'} | {status:'broken',missing[]}
//                | {status:'conditional',conditional[]} },
//       verdict: { cls: 'ok'|'never'|'broken-since'|'supported-since'|'conditional'|'mixed' } } } }
//
// 'conditional' (2026-09-10 model fix): the require names a built-in graph
// row the plugin did not declare — the loader's factory branch usually
// resolves it (batch timing), so it is NOT a crash. Treated as its own
// state everywhere — never folded into fail.

/** One observed load outcome at one shell version. */
export interface ObservedResult {
  status: string
  missing: string[]
  /** Built-in graph rows that resolve only by batch timing (status 'conditional'). */
  conditional?: string[]
}

/** The per-plugin observed slice (keyed by npm package name, lowercased). */
export interface ObservedPlugin {
  /** verdict.cls passthrough ('ok' / 'never' / 'broken-since' / …), null when absent. */
  verdict: string | null
  /** The plugin version the matrix actually measured (drives the stale guard). */
  version: string | null
  /** shell version → observed outcome; sparse — absent versions mean untested. */
  results: Record<string, ObservedResult>
}

/**
 * Index compat-observed.json by lowercased npm package name. Anything
 * malformed (no plugins object, non-object rows, non-string statuses) is
 * skipped piecemeal — a partial document still annotates what it can.
 */
export function observedByPkg(doc: unknown): Map<string, ObservedPlugin> {
  const map = new Map<string, ObservedPlugin>()
  const plugins = (doc as { plugins?: unknown } | null)?.plugins
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return map
  for (const [name, row] of Object.entries(plugins as Record<string, unknown>)) {
    if (!name || typeof row !== 'object' || row === null) continue
    const resultsRaw = (row as { results?: unknown }).results
    const results: Record<string, ObservedResult> = {}
    if (typeof resultsRaw === 'object' && resultsRaw !== null && !Array.isArray(resultsRaw)) {
      for (const [shell, entry] of Object.entries(resultsRaw as Record<string, unknown>)) {
        if (!shell || typeof entry !== 'object' || entry === null) continue
        const status = (entry as { status?: unknown }).status
        if (typeof status !== 'string' || !status) continue
        const missingRaw = (entry as { missing?: unknown }).missing
        const condRaw = (entry as { conditional?: unknown }).conditional
        results[shell] = {
          status,
          missing: Array.isArray(missingRaw)
            ? missingRaw.filter((m): m is string => typeof m === 'string')
            : [],
          ...(Array.isArray(condRaw)
            ? { conditional: condRaw.filter((m): m is string => typeof m === 'string') }
            : {}),
        }
      }
    }
    const cls = (row as { verdict?: { cls?: unknown } | null }).verdict?.cls
    const version = (row as { version?: unknown }).version
    map.set(name.toLowerCase(), {
      verdict: typeof cls === 'string' && cls ? cls : null,
      version: typeof version === 'string' && version ? version : null,
      results,
    })
  }
  return map
}

/** The doc-level generatedAt, when present. */
export function observedGeneratedAt(doc: unknown): string | null {
  const at = (doc as { generatedAt?: unknown } | null)?.generatedAt
  return typeof at === 'string' && at ? at : null
}

/** The wire tri-state for one plugin at one shell version. */
export interface ObservedAtShell {
  /** 'ok' | 'conditional' (graph-row timing, not a crash) | 'fail' | null (untested). */
  atCurrentShell: 'ok' | 'fail' | 'conditional' | null
  /** Unresolvable modules at that shell (present only on a fail with a list). */
  missing?: string[]
  /** Timing-resolved graph rows at that shell (present only on conditional). */
  conditional?: string[]
}

/**
 * One plugin's observed outcome at one shell version (typically the running
 * dsh version): null when either side is unknown or the matrix never tested
 * that combination. 'ok' → ok; 'conditional' → its own state (never a fail);
 * any other status maps to 'fail'.
 */
export function observedAtShell(entry: ObservedPlugin | undefined, shell: string | null): ObservedAtShell {
  if (!entry || !shell) return { atCurrentShell: null }
  const result = entry.results[shell]
  if (!result) return { atCurrentShell: null }
  if (result.status === 'ok') return { atCurrentShell: 'ok' }
  if (result.status === 'conditional') {
    return {
      atCurrentShell: 'conditional',
      ...(result.conditional && result.conditional.length > 0 ? { conditional: result.conditional } : {}),
    }
  }
  return {
    atCurrentShell: 'fail',
    ...(result.missing.length > 0 ? { missing: result.missing } : {}),
  }
}

// ── upgrade-check (实测矩阵 × 已装清单) ──────────────────────────────────────

export type UpgradeRowStatus = 'ok' | 'fail' | 'conditional' | 'unknown' | 'stale'

export interface UpgradeCheckRow {
  name: string
  status: UpgradeRowStatus
  /** The plugin version the matrix actually measured (stale rows only). */
  measuredVersion?: string
}

export interface UpgradeCheckResult {
  /** False when there is nothing to compare (no current version / no known latest). */
  available: boolean
  current: string | null
  latest: string | null
  counts: { ok: number; fail: number; conditional: number; unknown: number; stale: number; total: number }
  rows: UpgradeCheckRow[]
  /** compat-observed generatedAt (null when the doc is absent). */
  observedAt: string | null
}

/** Is `a` newer than `b` by base-version compare (prerelease dropped)? Null-safe. */
function isNewerBase(a: string, b: string): boolean {
  const order = compareBaseVersions(a, b)
  return order !== null && order > 0
}

/**
 * The latest shell version worth comparing against: the NEWEST of
 * compat-observed's shellDistTags.{latest,next} that is actually in the
 * matrix — the official npm tag hygiene is poor (`latest` has pointed at an
 * ancient build while `next` carried the current line), so neither tag is
 * trusted on its own. The alpha line is deliberately excluded: it is not an
 * upgrade recommendation. dynamics.json's dsh dist-tag latest stays as the
 * fallback for upstreams without the matrix. A candidate not in the matrix's
 * version list counts as unknown (the matrix predates it, so no plugin has
 * observed results there).
 */
function resolveObservedLatest(doc: unknown, dynamics: unknown): string | null {
  const versionsRaw = (doc as { allShellVersions?: unknown } | null)?.allShellVersions
  const matrix = Array.isArray(versionsRaw)
    ? versionsRaw.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
  const tags = (doc as { shellDistTags?: { latest?: unknown; next?: unknown } | null } | null)?.shellDistTags
  let best: string | null = null
  for (const candidate of [tags?.latest, tags?.next]) {
    if (typeof candidate !== 'string' || !candidate) continue
    if (matrix.length > 0 && !matrix.includes(candidate)) continue
    if (best === null || isNewerBase(candidate, best)) best = candidate
  }
  if (best !== null) return best
  const fallback = (dynamics as { dsh?: { npm?: { distTags?: { latest?: unknown } | null } | null } | null } | null)?.dsh?.npm?.distTags?.latest
  if (typeof fallback === 'string' && fallback && (matrix.length === 0 || matrix.includes(fallback))) {
    return fallback
  }
  return null
}

/**
 * Should-dsh-be-upgraded computation: each installed plugin's observed status
 * AT the latest shell version:
 *
 * - 'ok' / 'fail' — the matrix's verdict at that shell;
 * - 'conditional' — a built-in graph row resolves it in practice (batch
 *   timing); NOT a crash, never counted as fail;
 * - 'stale'       — the matrix measured a DIFFERENT plugin version than the
 *   one installed (the plugin was updated after the matrix run — the verdict
 *   cannot be trusted either way, so it counts in neither ok nor fail);
 * - 'unknown'     — the plugin or the shell version was never tested.
 *
 * Pure — current/latest/counts are reported, the comparison verdict is the
 * client's call (base-version compare). Not available when the running
 * version is unknown or no latest is known.
 */
export function computeUpgradeCheck(
  doc: unknown,
  dynamics: unknown,
  installed: ReadonlyArray<{ name: string; version: string | null }>,
  current: string | null,
): UpgradeCheckResult {
  const observed = observedByPkg(doc)
  const latest = resolveObservedLatest(doc, dynamics)
  const counts = { ok: 0, fail: 0, conditional: 0, unknown: 0, stale: 0, total: installed.length }
  const rows: UpgradeCheckRow[] = installed.map(({ name, version }) => {
    const entry = observed.get(name.toLowerCase())
    const result = latest !== null ? entry?.results[latest] : undefined
    let status: UpgradeRowStatus
    let measuredVersion: string | undefined
    if (entry === undefined || result === undefined) {
      status = 'unknown'
    } else if (entry.version !== null && version !== null && entry.version !== version) {
      // Freshness guard: the matrix ran against another build of this plugin
      // (the update-then-retest window) — no conclusion, report what was
      // actually measured.
      status = 'stale'
      measuredVersion = entry.version
    } else {
      status = result.status === 'ok' ? 'ok' : result.status === 'conditional' ? 'conditional' : 'fail'
    }
    counts[status] += 1
    return { name, status, ...(measuredVersion !== undefined ? { measuredVersion } : {}) }
  })
  return {
    available: current !== null && latest !== null,
    current,
    latest,
    counts,
    rows,
    observedAt: observedGeneratedAt(doc),
  }
}

// ── trimmed shapes served to the browser ─────────────────────────────────────

export interface TrimmedPlugin {
  full_name: string
  url: string | null
  stars: number
  grade: string | null
  score: number | null
  dimScores: Record<string, number>
  drops: DropInfo[]
  /** npm package name (repo package.json `name`), when known. */
  npm: string | null
  /** Repo package.json `version` (falling back to npm latest when unknown). */
  version: string | null
  /** npm registry `latest` dist-tag, when published (drives the drift hint). */
  npmLatest: string | null
  description: string | null
}

export interface SearchHit {
  full_name: string
  url: string | null
  stars: number
  grade: string | null
  score: number | null
  npm: string | null
  version: string | null
  description: string | null
}

/** Full health card for /dsh-insights/plugin (drops enriched to code/sev/label). */
export function trimPlugin(p: UpstreamPlugin): TrimmedPlugin {
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
    description: p.description ?? null,
  }
}

/** Compact row for /dsh-insights/search (no dimScores/drops). */
export function trimSearchHit(p: UpstreamPlugin): SearchHit {
  return {
    full_name: p.full_name,
    url: p.url ?? null,
    stars: p.stars ?? 0,
    grade: p.health?.grade ?? null,
    score: p.health?.score ?? null,
    npm: p.pkgName ?? null,
    version: p.version ?? p.npm?.latest ?? null,
    description: p.description ?? null,
  }
}

/**
 * Case-insensitive substring match over `full_name` + `description`, ranked
 * by stars descending (then name for stability). Empty query matches nothing.
 */
export function searchPlugins(
  plugins: readonly UpstreamPlugin[],
  query: string,
  limit: number,
): { total: number; results: SearchHit[] } {
  const q = query.trim().toLowerCase()
  if (!q) return { total: 0, results: [] }
  const matched = plugins.filter((p) =>
    p.full_name.toLowerCase().includes(q)
    || (p.description ?? '').toLowerCase().includes(q),
  )
  matched.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || a.full_name.localeCompare(b.full_name))
  return { total: matched.length, results: matched.slice(0, limit).map(trimSearchHit) }
}

/**
 * Batch health lookup keyed by npm package name (the「我的插件体检」route):
 * for each requested name, the trimmed card of the corpus row whose
 * `pkgName` matches (case-insensitively), or null when unlisted. Names are
 * lowercased/trimmed/deduped by the caller's map semantics — the last
 * duplicate wins identically, so this is order-independent.
 */
export function auditByNpm(
  plugins: readonly UpstreamPlugin[],
  names: readonly string[],
): Record<string, TrimmedPlugin | null> {
  const byNpm = new Map<string, UpstreamPlugin>()
  for (const p of plugins) {
    if (p.pkgName) byNpm.set(p.pkgName.toLowerCase(), p)
  }
  const out: Record<string, TrimmedPlugin | null> = {}
  for (const raw of names) {
    const name = raw.trim().toLowerCase()
    if (!name) continue
    const hit = byNpm.get(name)
    out[raw.trim()] = hit ? trimPlugin(hit) : null
  }
  return out
}

// ── cached store ─────────────────────────────────────────────────────────────

export type FetchJson = (url: string) => Promise<unknown>

export class UpstreamError extends Error {
  readonly url: string
  constructor(url: string, message: string) {
    super(message)
    this.url = url
  }
}

/** Default JSON fetcher: global fetch + non-2xx guard. */
export async function defaultFetchJson(url: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } })
  } catch (error) {
    throw new UpstreamError(url, `fetch failed: ${(error as Error).message}`)
  }
  if (!res.ok) throw new UpstreamError(url, `upstream responded HTTP ${res.status}`)
  try {
    return await res.json()
  } catch {
    throw new UpstreamError(url, 'upstream returned non-JSON body')
  }
}

type CacheName = 'insights' | 'scenarios' | 'dynamics' | 'compat' | 'enrich' | 'compatObserved'

/**
 * On-disk document file names per cache entry — the cache name is camelCase
 * for readability while the site serves kebab-case (`compat-observed.json`).
 */
const DOC_FILES: Record<CacheName, string> = {
  insights: 'insights',
  scenarios: 'scenarios',
  dynamics: 'dynamics',
  compat: 'compat',
  enrich: 'enrich',
  compatObserved: 'compat-observed',
}

interface CacheEntry {
  data: unknown
  fetchedAt: number
}

export interface CacheStatus {
  cached: boolean
  ageMs: number | null
  stale: boolean
}

export interface StoreOptions {
  /** Override the upstream base (tests point this at a fixture server). */
  baseUrl?: string
  /**
   * Registry base for the live dsh dist-tags overlay (defaults to the public
   * npm registry; tests point this at the fake registry — same override as
   * selfcheck's, wired from DSH_INSIGHTS_NPM_REGISTRY).
   */
  npmRegistry?: string
  ttlMs?: number
  fetchJson?: FetchJson
  now?: () => number
}

export interface InsightsStore {
  insights(): Promise<InsightsData>
  scenarios(): Promise<unknown>
  dynamics(): Promise<unknown>
  compat(): Promise<unknown>
  enrich(): Promise<unknown>
  compatObserved(): Promise<unknown>
  /**
   * Live `@deepseek-ai/dsh` dist-tags from the npm registry (5-min TTL).
   * Resolves null on ANY failure — this is a freshness overlay, not a source
   * of truth, so callers keep the snapshot's tags instead of erroring.
   */
  npmDistTags(): Promise<Record<string, string> | null>
  status(): Record<CacheName, CacheStatus>
}

/**
 * Lazy per-document in-memory cache. A failed fetch never poisons the cache:
 * the error propagates (the route answers 502) and the next request retries.
 * Concurrent first requests share one in-flight promise per document.
 */
export function createStore(options: StoreOptions = {}): InsightsStore {
  const baseUrl = options.baseUrl?.replace(/\/+$/, '')
  const npmRegistry = (options.npmRegistry ?? DEFAULT_NPM_REGISTRY).replace(/\/+$/, '')
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const fetchJson = options.fetchJson ?? defaultFetchJson
  const now = options.now ?? Date.now

  const cache = new Map<CacheName, CacheEntry>()
  const inflight = new Map<CacheName, Promise<unknown>>()

  function docUrl(name: CacheName): string {
    return baseUrl ? `${baseUrl}/${DOC_FILES[name]}.json` : (DEFAULT_DOC_URLS[name] ?? `${DEFAULT_BASE_URL}/${DOC_FILES[name]}.json`)
  }

  async function load(name: CacheName): Promise<unknown> {
    const hit = cache.get(name)
    if (hit && now() - hit.fetchedAt < ttlMs) return hit.data
    const pending = inflight.get(name)
    if (pending) return pending
    const task = fetchJson(docUrl(name))
      .then((data) => {
        cache.set(name, { data, fetchedAt: now() })
        return data
      })
      .finally(() => inflight.delete(name))
    inflight.set(name, task)
    return task
  }

  // Live dist-tags overlay: own entry (not a CacheName — different origin,
  // different TTL), single package, best-effort (null on failure, cached only
  // on a successful parse so a bad response retries next request).
  let npmTags: { tags: Record<string, string>; fetchedAt: number } | null = null
  let npmTagsInflight: Promise<Record<string, string> | null> | null = null

  function npmDistTags(): Promise<Record<string, string> | null> {
    if (npmTags && now() - npmTags.fetchedAt < NPM_DIST_TAGS_TTL_MS) return Promise.resolve(npmTags.tags)
    if (npmTagsInflight) return npmTagsInflight
    const task = fetchJson(`${npmRegistry}/${DSH_NPM_PACKAGE.replace(/^@/, '%40')}`)
      .then((doc) => {
        const raw = (doc as { 'dist-tags'?: unknown } | null | undefined)?.['dist-tags']
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
        const tags: Record<string, string> = {}
        for (const [tag, version] of Object.entries(raw)) {
          if (typeof version === 'string' && version) tags[tag] = version
        }
        if (Object.keys(tags).length === 0) return null
        npmTags = { tags, fetchedAt: now() }
        return tags
      })
      .catch(() => null)
      .finally(() => { npmTagsInflight = null })
    npmTagsInflight = task
    return task
  }

  async function insights(): Promise<InsightsData> {
    const data = (await load('insights')) as Partial<InsightsData>
    return { generatedAt: data.generatedAt, plugins: Array.isArray(data.plugins) ? data.plugins : [] }
  }

  return {
    insights,
    scenarios: () => load('scenarios'),
    dynamics: () => load('dynamics'),
    compat: () => load('compat'),
    enrich: () => load('enrich'),
    compatObserved: () => load('compatObserved'),
    npmDistTags,
    status() {
      const names: CacheName[] = ['insights', 'scenarios', 'dynamics', 'compat', 'enrich', 'compatObserved']
      const out = {} as Record<CacheName, CacheStatus>
      for (const name of names) {
        const hit = cache.get(name)
        const ageMs = hit ? now() - hit.fetchedAt : null
        out[name] = { cached: hit !== undefined, ageMs, stale: ageMs !== null && ageMs >= ttlMs }
      }
      return out
    },
  }
}
