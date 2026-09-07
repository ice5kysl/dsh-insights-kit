/**
 * dsh-insights-kit — single Loader entry (package name `dsh-insights-kit`).
 *
 * Host face (this module): registers a read-only HTTP surface on the official
 * `ctx.webServer` route seam under `/dsh-insights`, proxying the open dataset
 * published by dsh-insights.com (cached in memory, 6h TTL, lazy first load):
 *
 * - `GET /dsh-insights/plugin?full_name=owner/repo` — one plugin's health
 *   card (trimmed: full_name/stars/grade/score/dimScores/drops enriched to
 *   code+sev+label/npm/version/description/url); 404 when not in the corpus.
 * - `GET /dsh-insights/search?q=<word>&limit=20`   — case-insensitive
 *   substring match over full_name + description, ranked by stars; compact
 *   rows (no dimScores/drops).
 * - `GET /dsh-insights/audit?npm=a,b,c` — batch health lookup by npm package
 *   name (the「我的插件体检」page); each name maps to a trimmed card or null.
 * - `GET /dsh-insights/scenarios` — scenarios.json passthrough.
 * - `GET /dsh-insights/dynamics`  — dynamics.json passthrough.
 * - `GET /dsh-insights/health`    — liveness + per-document cache age.
 *
 * Every request passes a host-trust gate mirroring the official /api fence:
 * loopback authorities are trusted; anything else needs a same-origin browser
 * marker. This is NOT an auth layer — same posture as the official web
 * server (bind 127.0.0.1 by default; keep the dsh web server loopback-bound
 * in deployments).
 *
 * Browser face (`./client`): the「生态」overlay panel opened from a sidebar
 * footer action (see src/client). It consumes these routes with same-origin
 * `fetch`.
 *
 * @module dsh-insights-kit
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  UpstreamError,
  auditByNpm,
  createStore,
  searchPlugins,
  trimPlugin,
  type InsightsStore,
} from './upstream.ts'

export const name = 'insights'

/** Required service: the web route-registration carrier (see dsh-host-webserver). */
export const inject = ['webServer'] as const

/** Minimal faces of the pieces this plugin consumes (typed locally). */
interface WebRoute {
  kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface WebServerLike {
  register(route: WebRoute): () => void
}

interface HostCtxLike {
  logger(name: string): { info(...parts: unknown[]): void }
  effect(fn: () => unknown): unknown
  webServer: WebServerLike
}

const PREFIX = '/dsh-insights'
const MAX_SEARCH_LIMIT = 50
const MAX_AUDIT_NAMES = 100
const startedAt = Date.now()

interface WireError {
  code: string
  message: string
}

function wireError(code: string, message: string): WireError {
  return { code, message }
}

export function apply(raw: unknown): void {
  const ctx = raw as HostCtxLike
  const log = ctx.logger('insights')
  log.info('dsh-insights-kit loaded (host /dsh-insights routes)')

  // DSH_INSIGHTS_UPSTREAM_BASE overrides the dataset origin (used by the
  // smoke test to serve fixtures; production installs leave it unset).
  const store = createStore({
    baseUrl: process.env.DSH_INSIGHTS_UPSTREAM_BASE || undefined,
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => void handleRequest(req, res, store, log),
  }))
  log.info('registered GET /dsh-insights/{plugin,search,audit,scenarios,dynamics,health} (read-only)')
}

// ── request handling ─────────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: InsightsStore,
  log: { info(...parts: unknown[]): void },
): Promise<void> {
  if (!trusted(req)) {
    sendJson(res, 403, { ok: false, error: wireError('forbidden', 'untrusted host/origin') })
    return
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: wireError('method-not-allowed', 'only GET is served') })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  try {
    if (pathname === `${PREFIX}/plugin`) {
      const fullName = (url.searchParams.get('full_name') ?? '').trim()
      if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
        sendJson(res, 400, { ok: false, error: wireError('invalid-query', 'missing or malformed ?full_name=owner/repo') })
        return
      }
      const data = await store.insights()
      const plugin = data.plugins.find((p) => p.full_name.toLowerCase() === fullName.toLowerCase())
      if (!plugin) {
        sendJson(res, 404, {
          ok: false,
          error: wireError('not-in-corpus', `${fullName} is not in the DSH Insights authoritative corpus`),
        })
        return
      }
      sendJson(res, 200, { ok: true, generatedAt: data.generatedAt ?? null, plugin: trimPlugin(plugin) })
      return
    }
    if (pathname === `${PREFIX}/search`) {
      const q = (url.searchParams.get('q') ?? '').trim()
      if (!q) {
        sendJson(res, 400, { ok: false, error: wireError('invalid-query', 'missing ?q=') })
        return
      }
      const rawLimit = Number(url.searchParams.get('limit'))
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_SEARCH_LIMIT)
        : 20
      const data = await store.insights()
      const { total, results } = searchPlugins(data.plugins, q, limit)
      sendJson(res, 200, { ok: true, q, total, limit, results })
      return
    }
    if (pathname === `${PREFIX}/audit`) {
      // Batch health lookup by npm package names (comma-separated), for the
      //「我的插件体检」page: each name maps to a trimmed card or null
      // (unlisted). Cap keeps the query string and the scan bounded.
      const names = (url.searchParams.get('npm') ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
        .slice(0, MAX_AUDIT_NAMES)
      if (names.length === 0) {
        sendJson(res, 400, { ok: false, error: wireError('invalid-query', 'missing ?npm=name1,name2,…') })
        return
      }
      const data = await store.insights()
      sendJson(res, 200, {
        ok: true,
        generatedAt: data.generatedAt ?? null,
        results: auditByNpm(data.plugins, names),
      })
      return
    }
    if (pathname === `${PREFIX}/scenarios`) {
      sendJson(res, 200, { ok: true, scenarios: await store.scenarios() })
      return
    }
    if (pathname === `${PREFIX}/dynamics`) {
      sendJson(res, 200, { ok: true, dynamics: await store.dynamics() })
      return
    }
    if (pathname === `${PREFIX}/health`) {
      sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-insights-kit',
        uptimeMs: Date.now() - startedAt,
        caches: store.status(),
      })
      return
    }
    if (pathname === PREFIX) {
      sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-insights-kit',
        endpoints: [
          '/dsh-insights/plugin?full_name=owner/repo',
          '/dsh-insights/search?q=&limit=',
          '/dsh-insights/audit?npm=a,b,c',
          '/dsh-insights/scenarios',
          '/dsh-insights/dynamics',
          '/dsh-insights/health',
        ],
      })
      return
    }
    sendJson(res, 404, { ok: false, error: wireError('not-found', `unknown endpoint ${url.pathname}`) })
  } catch (error) {
    if (error instanceof UpstreamError) {
      log.info('upstream fetch failed', error.url, error.message)
      sendJson(res, 502, { ok: false, error: wireError('upstream', error.message) })
      return
    }
    log.info('request failed', url.pathname, (error as Error).message)
    sendJson(res, 500, { ok: false, error: wireError('internal', (error as Error).message) })
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

// ── host-trust gate (mirrors the official /api fence posture) ───────────────

/** Lowercased hostname of an HTTP Host header, brackets stripped. */
function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  const trimmed = hostHeader.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end < 0 ? null : trimmed.slice(1, end).toLowerCase()
  }
  const colon = trimmed.lastIndexOf(':')
  const host = colon < 0 ? trimmed : trimmed.slice(0, colon)
  return host.toLowerCase() || null
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '0:0:0:0:0:0:0:1'
    || /^127(\.\d{1,3}){3}$/.test(hostname)
}

/**
 * Decide whether one request may reach the insights surface: loopback Host is
 * trusted outright (the official loopback arm); anything else must carry a
 * same-origin browser marker (the official browser-marker arm). Deployments
 * serving over extra LAN authorities should keep the web server bound to
 * loopback, or extend this gate with the deployment's trusted authorities.
 */
function trusted(req: IncomingMessage): boolean {
  const host = hostnameOf(req.headers.host)
  if (host && isLoopbackHostname(host)) return true
  const origin = req.headers.origin
  if (!origin || !host) return false
  try {
    const parsed = new URL(origin)
    if (parsed.hostname.toLowerCase() !== host) return false
    // Same-origin port must match too (default-port literals compare equal
    // against the Host header's explicit port after normalization by URL).
    const hostHeader = req.headers.host ?? ''
    if (hostHeader.includes(':')) {
      const portOfHost = hostnameOf(hostHeader) ? parsed.port || (parsed.protocol === 'https:' ? '443' : '80') : ''
      const expected = hostHeader.slice(hostHeader.lastIndexOf(':') + 1)
      return portOfHost === expected || (!expected && parsed.port === '')
    }
    return parsed.port === ''
  } catch {
    return false
  }
}
