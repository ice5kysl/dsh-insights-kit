/**
 * dsh-insights-plugin — browser-side fetch client for the host /dsh-insights
 * surface (same-origin, mirror of src/host wire shapes).
 *
 * The host routes live on the same web server that serves the GUI, so a
 * plain same-origin `fetch` works without extra credentials — identical to
 * how the official client talks to `/api`.
 *
 * Also owns the GitHub-URL → owner/repo parsing used by the「查验」input.
 *
 * @module dsh-insights-plugin/insights-api
 */

import { L } from './locale.ts'

export type DropSeverity = 'fail' | 'major' | 'warn' | 'minor'

export interface DropInfo {
  code: string
  sev: DropSeverity
  label: { zh: string; en: string }
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

export interface ScenarioPlugin {
  full_name: string
  url?: string
  stars?: number
  score?: number
  grade?: string
  npm?: string | null
  active?: boolean
  reasons?: string[]
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
  }
  platform?: PlatformRepo[]
}

export interface WireError {
  code: string
  message: string
}

export class ApiError extends Error {
  readonly code: string
  constructor(error: WireError) {
    super(error.message)
    this.code = error.code
  }
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
    const error = body?.error ?? { code: 'http', message: `HTTP ${response.status}` }
    throw new ApiError(error)
  }
  return body as unknown as T
}

/** Fetch one plugin's health card; throws ApiError code `not-in-corpus` when absent. */
export async function fetchPlugin(fullName: string): Promise<{ generatedAt: string | null; plugin: PluginCard }> {
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
