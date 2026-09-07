/**
 * Upstream data layer for the dsh-insights host face.
 *
 * The DSH Insights site (dsh-insights.com) publishes its dataset as open
 * JSON documents; this module fetches them lazily on first request and keeps
 * them in memory with a 6-hour TTL (the site regenerates roughly daily, so
 * 6h keeps data fresh without hammering the static host):
 *
 * - `insights.json`  (~6 MB; per-plugin health rows for the whole corpus)
 * - `scenarios.json` (scenario → recommended plugins; not served on the
 *   site's /data/ — fetched from the public dsh-insights repo's raw file)
 * - `dynamics.json`  (dsh releases + platform repo activity)
 *
 * The store is dependency-injected (`fetchJson`, `baseUrl`, `ttlMs`) so the
 * smoke test can run it against a local fixture server with no network.
 * Trimming/search helpers are pure and exported for direct unit-style tests.
 *
 * @module dsh-insights-kit/upstream
 */

import { enrichDrops, type DropInfo } from './drops.ts'

export const DEFAULT_BASE_URL = 'https://dsh-insights.com/data'
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Per-document default origins. The site publishes most of the dataset under
 * /data/, but `scenarios.json` is only consumed by the static page build and
 * is NOT served on the site — it is however tracked in the public
 * ice5kysl/dsh-insights repo, so its canonical URL is the raw file.
 * `StoreOptions.baseUrl` (or DSH_INSIGHTS_UPSTREAM_BASE) overrides all three
 * with a single `<base>/<name>.json` origin (fixtures, mirrors).
 */
const DEFAULT_DOC_URLS: Record<string, string> = {
  insights: `${DEFAULT_BASE_URL}/insights.json`,
  scenarios: 'https://raw.githubusercontent.com/ice5kysl/dsh-insights/main/data/scenarios.json',
  dynamics: `${DEFAULT_BASE_URL}/dynamics.json`,
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

type CacheName = 'insights' | 'scenarios' | 'dynamics'

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
  ttlMs?: number
  fetchJson?: FetchJson
  now?: () => number
}

export interface InsightsStore {
  insights(): Promise<InsightsData>
  scenarios(): Promise<unknown>
  dynamics(): Promise<unknown>
  status(): Record<CacheName, CacheStatus>
}

/**
 * Lazy per-document in-memory cache. A failed fetch never poisons the cache:
 * the error propagates (the route answers 502) and the next request retries.
 * Concurrent first requests share one in-flight promise per document.
 */
export function createStore(options: StoreOptions = {}): InsightsStore {
  const baseUrl = options.baseUrl?.replace(/\/+$/, '')
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const fetchJson = options.fetchJson ?? defaultFetchJson
  const now = options.now ?? Date.now

  const cache = new Map<CacheName, CacheEntry>()
  const inflight = new Map<CacheName, Promise<unknown>>()

  function docUrl(name: CacheName): string {
    return baseUrl ? `${baseUrl}/${name}.json` : (DEFAULT_DOC_URLS[name] ?? `${DEFAULT_BASE_URL}/${name}.json`)
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

  async function insights(): Promise<InsightsData> {
    const data = (await load('insights')) as Partial<InsightsData>
    return { generatedAt: data.generatedAt, plugins: Array.isArray(data.plugins) ? data.plugins : [] }
  }

  return {
    insights,
    scenarios: () => load('scenarios'),
    dynamics: () => load('dynamics'),
    status() {
      const names: CacheName[] = ['insights', 'scenarios', 'dynamics']
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
