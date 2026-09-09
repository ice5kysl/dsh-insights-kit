/**
 * dsh-insights-kit — browser-side fetch client for the host /dsh-insights
 * surface (same-origin, mirror of src/host wire shapes).
 *
 * The host routes live on the same web server that serves the GUI, so a
 * plain same-origin `fetch` works without extra credentials — identical to
 * how the official client talks to `/api`.
 *
 * Also owns the GitHub-URL → owner/repo parsing used by the「查验」input.
 *
 * @module dsh-insights-kit/insights-api
 */

import { L } from './locale.ts'

export type DropSeverity = 'fail' | 'major' | 'warn' | 'minor'

export interface DropInfo {
  code: string
  sev: DropSeverity
  label: { zh: string; en: string }
}

export interface PluginCompat {
  enginesDsh: string | null
  dshPeers: Array<{ name: string; range: string }>
}

export interface PluginCard {
  full_name: string
  url: string | null
  stars: number
  grade: string | null
  score: number | null
  dimScores: Record<string, number>
  drops: DropInfo[]
  npm: string | null
  version: string | null
  npmLatest: string | null
  description: string | null
  /** dsh-compat signal (engines.dsh + first 3 dsh peers) from compat.json;
   *  present on /audit hits only, null when the plugin is not probed. */
  compat?: PluginCompat | null
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

export interface ScenarioPlugin {
  full_name: string
  url?: string
  stars?: number
  score?: number
  grade?: string
  npm?: string | null
  active?: boolean
  reasons?: string[]
  /** npm package name, annotated host-side from the corpus (drives the
   *  copyable install/uninstall command button); absent when unknown. */
  pkgName?: string
}

export interface Scenario {
  id: string
  zh?: string
  en?: string
  candidates?: number
  plugins?: ScenarioPlugin[]
}

export interface ScenariosDoc {
  generatedAt?: string
  scenarios?: Scenario[]
}

export interface ReleaseRow {
  tag: string
  name?: string
  prerelease?: boolean
  published_at?: string
  breaking?: boolean
  summary?: string | null
  added?: number
  fixed?: number
}

export interface PlatformRepo {
  repo: string
  stars?: number
  forks?: number
  pushed_at?: string
  description?: string
  latestRelease?: ReleaseRow | null
}

export interface DynamicsDoc {
  fetchedAt?: string
  dsh?: {
    repo?: string
    stars?: number
    forks?: number
    pushed_at?: string
    description?: string
    releases?: ReleaseRow[]
    npm?: {
      pkg?: string
      distTags?: Record<string, string>
      versions?: Array<{ version?: string; time?: string }>
    }
  }
  platform?: PlatformRepo[]
}

export interface WireError {
  code: string
  message: string
}

export class ApiError extends Error {
  readonly code: string
  /** Uninstall blockers: installed packages declaring the target as a dependency. */
  readonly dependents?: string[]
  constructor(error: WireError, dependents?: string[]) {
    super(error.message)
    this.code = error.code
    this.dependents = dependents
  }
}

/** The wire error from one response, with any structured extras attached. */
function apiFailure(status: number, body: ({ ok?: boolean; error?: WireError } & Record<string, unknown>) | null): ApiError {
  const error = body?.error ?? { code: 'http', message: `HTTP ${status}` }
  const dependents = Array.isArray(body?.dependents)
    ? body.dependents.filter((entry): entry is string => typeof entry === 'string')
    : undefined
  return new ApiError(error, dependents)
}

async function getJson<T>(query: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/dsh-insights/${query}`, { headers: { accept: 'application/json' } })
  } catch {
    throw new ApiError({
      code: 'network',
      message: L('无法连接本机 dsh web 服务（/dsh-insights 不可达）', 'Cannot reach the local dsh web service (/dsh-insights)'),
    })
  }
  let body: ({ ok?: boolean; error?: WireError } & Record<string, unknown>) | null = null
  try {
    body = await response.json()
  } catch {
    // non-JSON body (e.g. the SPA fallback HTML) — treat as endpoint missing
  }
  if (!response.ok || body === null || body.ok !== true) {
    throw apiFailure(response.status, body)
  }
  return body as unknown as T
}

/** One same-category pick attached to the plugin health card. */
export interface SimilarPick {
  full_name: string
  grade: string | null
  score: number | null
  stars: number
}

/** Fetch one plugin's health card; throws ApiError code `not-in-corpus` when absent. */
export async function fetchPlugin(
  fullName: string,
): Promise<{ generatedAt: string | null; plugin: PluginCard; similar?: SimilarPick[] }> {
  return getJson(`plugin?full_name=${encodeURIComponent(fullName)}`)
}

export async function searchPlugins(q: string, limit = 20): Promise<{ total: number; results: SearchHit[] }> {
  return getJson(`search?q=${encodeURIComponent(q)}&limit=${limit}`)
}

export async function fetchScenarios(): Promise<{ scenarios: ScenariosDoc }> {
  return getJson('scenarios')
}

export async function fetchDynamics(): Promise<{ dynamics: DynamicsDoc }> {
  return getJson('dynamics')
}

/** The running dsh version as seen host-side (`null` when not resolvable). */
export async function fetchRuntime(): Promise<{ dsh: { version: string | null } }> {
  return getJson('runtime')
}

/** One installed-plugin row of the active profile (host-side manifest read). */
export interface InstalledPlugin {
  name: string
  spec: string
  /** Installed version from the profile's node_modules, null when pending. */
  version: string | null
  /** Carries a dsh/cordis manifest field (loads as a plugin). */
  plugin: boolean
  /** In the manifest's `dsh.profile.bundles` load list (true when no bundles field). */
  enabled: boolean
}

/**
 * The active profile's installed plugins, read host-side from the profile
 * manifest (the same seam `dsh plugin add` operates on). Always available on
 * any build — no Remote namespace involved.
 */
export async function fetchInstalled(): Promise<{
  profile: string
  /** Count of in-box @deepseek-ai/* bundles in the manifest. */
  baseline: number
  plugins: InstalledPlugin[]
}> {
  return getJson('installed')
}

/** Liveness + capabilities (mutations = one-click install/uninstall usable). */
export async function fetchHealth(): Promise<{ mutations?: boolean }> {
  return getJson('health')
}

/** Result of a one-click install/uninstall against the local profile. */
export interface OpResult {
  ok: boolean
  status?: 'done' | 'partial' | 'failed'
  /** 'already-installed' noop marker on install. */
  note?: string
  detail?: string
  /** True when the change went live in the running composition (hot mount/disable) — no restart, just a page refresh. */
  hot?: boolean
  restartRequired?: boolean
}

/** POST one profile mutation with the anti-CSRF custom header. */
async function postOp(path: 'install' | 'uninstall' | 'disable', name: string): Promise<OpResult> {
  let response: Response
  try {
    response = await fetch(`/dsh-insights/${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-dsh-insights-kit': 'mutate',
      },
      body: JSON.stringify({ name }),
    })
  } catch {
    throw new ApiError({
      code: 'network',
      message: L('无法连接本机 dsh web 服务（/dsh-insights 不可达）', 'Cannot reach the local dsh web service (/dsh-insights)'),
    })
  }
  let body: ({ ok?: boolean; error?: WireError } & Record<string, unknown>) | null = null
  try {
    body = await response.json()
  } catch {
    // non-JSON body — treat as endpoint missing
  }
  if (!response.ok || body === null || body.ok !== true) {
    throw apiFailure(response.status, body)
  }
  return body as unknown as OpResult
}

/** One-click install of a corpus plugin package into the active profile. */
export function installPlugin(name: string): Promise<OpResult> {
  return postOp('install', name)
}

/** One-click uninstall of an installed package from the active profile. */
export function uninstallPlugin(name: string): Promise<OpResult> {
  return postOp('uninstall', name)
}

/**
 * Quarantine an installed plugin: out of the load list, files kept — the
 * crash-immunity escape hatch for「won't load」rows. Reversible via install
 * (the host re-enables installed-but-disabled names without a pnpm run).
 */
export function disablePlugin(name: string): Promise<OpResult> {
  return postOp('disable', name)
}

/** Batch health lookup by npm package names; unlisted names map to null. */
export async function fetchAudit(
  names: readonly string[],
): Promise<{ generatedAt: string | null; results: Record<string, PluginCard | null> }> {
  return getJson(`audit?npm=${encodeURIComponent(names.join(','))}`)
}

// ── client-bundle × shell module-table check (升级预检) ──────────────────────

export interface ClientCompatRow {
  name: string
  /** 'broken' = the bundle requires modules the on-disk shell cannot resolve. */
  status: 'ok' | 'broken' | 'unknown' | 'no-client'
  requires: string[]
  missing: string[]
}

export interface ClientCompatReport {
  /** The on-disk shell (what the next `dsh web` boot loads); null = not locatable. */
  shell: { version: string | null; seedWords: string[] } | null
  rows: ClientCompatRow[]
}

/** Local pre-check against the shell's module table; absent on older hosts. */
export async function fetchCompat(): Promise<{ compat: ClientCompatReport }> {
  return getJson('compat')
}

/**
 * Parse the「查验」input into `owner/repo`. Accepts a bare full name or a
 * GitHub URL in any common shape (https/http, with or without www, trailing
 * .git or extra path segments). Returns null when nothing parses.
 */
export function parseRepoInput(raw: string): string | null {
  const input = raw.trim()
  if (!input) return null
  const bare = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(input)
  if (bare) return `${bare[1]}/${bare[2]}`
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
    if (!/(^|\.)github\.com$/i.test(url.hostname)) return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    const repo = parts[1]!.replace(/\.git$/i, '')
    if (!/^[A-Za-z0-9_.-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null
    return `${parts[0]}/${repo}`
  } catch {
    return null
  }
}

// ── 查验 input routing (exact lookup vs corpus search) ───────────────────────

export type CheckInput =
  | { kind: 'exact'; fullName: string }
  | { kind: 'search'; query: string }
  | { kind: 'invalid' }

/**
 * Route the「查验」input: anything containing `/` (bare owner/repo or a
 * GitHub URL) keeps the exact-lookup behavior; a bare word/phrase searches
 * the corpus instead (substring match over full_name + description, host
 * side). Slash-carrying input that parses to nothing stays `invalid` (the
 * section shows its usual hint), same as before.
 */
export function classifyCheckInput(raw: string): CheckInput {
  const input = raw.trim()
  if (!input) return { kind: 'invalid' }
  if (input.includes('/') || /^https?:\/\//i.test(input)) {
    const fullName = parseRepoInput(input)
    return fullName ? { kind: 'exact', fullName } : { kind: 'invalid' }
  }
  return { kind: 'search', query: input }
}
