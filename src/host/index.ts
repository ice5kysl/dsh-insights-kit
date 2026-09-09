/**
 * dsh-insights-kit — single Loader entry (package name `dsh-insights-kit`).
 *
 * Host face (this module): registers a read-only HTTP surface on the official
 * `ctx.webServer` route seam under `/dsh-insights`, proxying the open dataset
 * published by dsh-insights.com (cached in memory, 6h TTL, lazy first load):
 *
 * - `GET /dsh-insights/plugin?full_name=owner/repo` — one plugin's health
 *   card (trimmed: full_name/stars/grade/score/dimScores/drops enriched to
 *   code+sev+label/npm/version/description/url) plus `similar`: top-5
 *   same-category picks from enrich.json; 404 when not in the corpus.
 * - `GET /dsh-insights/search?q=<word>&limit=20`   — case-insensitive
 *   substring match over full_name + description, ranked by stars; compact
 *   rows (no dimScores/drops).
 * - `GET /dsh-insights/audit?npm=a,b,c` — batch health lookup by npm package
 *   name (the「我的插件体检」page); each name maps to a trimmed card or null,
 *   with a `compat` slice (engines.dsh + first 3 dsh peers, joined from
 *   compat.json) attached to hits.
 * - `GET /dsh-insights/scenarios` — scenarios.json, with each pick annotated
 *   by its npm `pkgName` (joined from the corpus on `full_name`) so the
 *   client can offer copyable install/uninstall commands, plus an `observed`
 *   slice (compat-observed verdict + outcome at the running dsh version)
 *   when the upstream publishes compat-observed.json.
 * - `GET /dsh-insights/dynamics`  — dynamics.json passthrough.
 * - `GET /dsh-insights/runtime`   — the running dsh version (resolved from
 *   the installed @deepseek-ai/dsh-web-app / dsh-base package.json; null
 *   when not resolvable).
 * - `GET /dsh-insights/installed` — the active profile's installed plugins,
 *   read straight from the profile manifest (`~/.dsh/profiles/<profile>`,
 *   the same seam `dsh plugin add` operates on): name + spec + installed
 *   version + plugin-flag per row, plus the in-box baseline count. Local
 *   filesystem only, no upstream fetch; never blocks on a Remote namespace.
 * - `GET /dsh-insights/health`    — liveness + per-document cache age.
 * - `GET /dsh-insights/compat`    — client-bundle × shell module-table check:
 *   every enabled plugin's require set against the on-disk shell's seed words
 *   + graph rows (what the NEXT `dsh web` boot resolves), flagging plugins
 *   that would crash the loader on the current/next dsh build.
 * - `GET /dsh-insights/upgrade-check` — "should I upgrade dsh": the running
 *   version vs the latest shell in the observed compat matrix
 *   (compat-observed.json, dynamics dist-tags as fallback), with every
 *   enabled installed plugin's observed load outcome at that latest version;
 *   `available:false` when the current version or a known latest is missing.
 * - `POST /dsh-insights/install`   — one-click install into the active
 *   profile (`pnpm add` + append to `dsh.profile.bundles`), restricted to
 *   package names the corpus knows as plugins; body `{name}`.
 * - `POST /dsh-insights/uninstall` — drop from the bundles load list +
 *   `pnpm remove`, restricted to actually-installed names; body `{name}`.
 *   Refuses (409 + `dependents`) while other installed packages declare the
 *   target as a dependency.
 * - `POST /dsh-insights/disable` — quarantine: out of the load list, files
 *   kept (the crash-immunity escape hatch for a plugin that would break the
 *   next boot; the same dependents guard applies). Re-enabling is
 *   `POST /install` on an installed-but-disabled name (bundles append +
 *   hot mount, no pnpm run; response note `re-enabled`).
 *
 * Mutations are guarded beyond the host-trust gate: POST only, a custom
 * `x-dsh-insights-kit: mutate` header is required (cross-origin pages cannot
 * set it without a preflight this server never answers), a strict npm-name
 * check runs before anything touches disk or spawns pnpm (arg-array, no
 * shell), the @deepseek-ai/* baseline is never mutable, and
 * `DSH_INSIGHTS_NO_MUTATE=1` disables the whole surface. Changes take effect
 * on the next `dsh web` restart.
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
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cleanHotDir, disableEntry, hotMount, hotMountAvailable, hotUnmount, type HotContext, type LoaderLike } from './hot.ts'
import { readInstalledInventory, resolveProfileDir } from './installed.ts'
import { editBundles, findDependents, installPackage, isMutablePackage, pnpmAvailable, readBundlesShape, uninstallPackage, type OpKind } from './ops.ts'
import { checkClientCompat } from './shell.ts'
import {
  UpstreamError,
  auditByNpm,
  compatByNpm,
  computeUpgradeCheck,
  createStore,
  observedAtShell,
  observedByPkg,
  observedGeneratedAt,
  searchPlugins,
  similarByCategory,
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
  /** Park a callback on optional services (the `loader` hot-mount carrier). */
  inject(names: string[], cb: (ctx: { loader?: LoaderLike } & Record<string, unknown>) => void): unknown
  /** Mount a plugin subtree (cordis Context.plugin) — used by hot mounts. */
  plugin(plugin: unknown, config: unknown): { await(): Promise<unknown>; dispose(): Promise<unknown> | void }
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

/** Loose shapes of scenarios.json — annotated opaquely, fields pass through. */
interface ScenarioPickShape {
  full_name?: string
  pkgName?: string
  [key: string]: unknown
}

interface ScenarioShape {
  plugins?: ScenarioPickShape[]
  [key: string]: unknown
}

interface ScenariosDocShape {
  scenarios?: ScenarioShape[]
  [key: string]: unknown
}

/**
 * The running dsh version, resolved from the installed official packages'
 * package.json (web-app first, base as fallback). Null when neither resolves
 * (e.g. the plugin runs outside a standard dsh install). Resolved lazily and
 * memoized — the module graph does not change over one process's lifetime.
 */
let dshVersionCache: string | null | undefined

function dshVersion(): string | null {
  if (dshVersionCache !== undefined) return dshVersionCache
  const require = createRequire(import.meta.url)
  for (const pkg of ['@deepseek-ai/dsh-web-app/package.json', '@deepseek-ai/dsh-base/package.json']) {
    try {
      const { version } = require(pkg) as { version?: unknown }
      if (typeof version === 'string' && version) {
        dshVersionCache = version
        return version
      }
    } catch {
      // not resolvable from here — try the next candidate
    }
  }
  dshVersionCache = null
  return null
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

  // Hot-mount carriers: leftover input files from a previous process are
  // wiped (the bundle layer owns durable state), and the loader service is
  // grabbed through a child fiber — never a hard dependency, so builds
  // without it simply fall back to restart-required mutation results.
  try {
    cleanHotDir(resolveProfileDir().dir)
  } catch { /* profile dir unresolvable — hot mounts degrade to restart */ }
  let loaderRef: LoaderLike | null = null
  try {
    ctx.inject(['loader'], (child) => {
      loaderRef = child.loader ?? null
    })
  } catch { /* no inject on this ctx shape — hot paths degrade */ }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => void handleRequest(req, res, store, log, () => loaderRef, ctx),
  }))
  log.info('registered GET /dsh-insights/{plugin,search,audit,scenarios,dynamics,runtime,installed,compat,upgrade-check,health} + POST install/uninstall (hot-mount capable)')
}

// ── request handling ─────────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: InsightsStore,
  log: { info(...parts: unknown[]): void },
  getLoader: () => LoaderLike | null,
  hotCtx: HotContext,
): Promise<void> {
  if (!trusted(req)) {
    sendJson(res, 403, { ok: false, error: wireError('forbidden', 'untrusted host/origin') })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  const mutationOp: OpKind | null = pathname === `${PREFIX}/install`
    ? 'install'
    : pathname === `${PREFIX}/uninstall`
      ? 'uninstall'
      : pathname === `${PREFIX}/disable`
        ? 'disable'
        : null
  if (mutationOp !== null ? req.method !== 'POST' : req.method !== 'GET') {
    sendJson(res, 405, {
      ok: false,
      error: wireError('method-not-allowed', mutationOp !== null ? 'POST only for install/uninstall/disable' : 'only GET is served here'),
    })
    return
  }
  try {
    if (mutationOp !== null) {
      await handleMutation(req, res, store, mutationOp, getLoader, hotCtx)
      return
    }
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
      // Same-category picks from enrich.json (top 5 by score then stars, self
      // excluded); a failed enrich fetch degrades to an empty list rather
      // than failing the card.
      const enrichDoc = await store.enrich().catch(() => null)
      sendJson(res, 200, {
        ok: true,
        generatedAt: data.generatedAt ?? null,
        plugin: trimPlugin(plugin),
        similar: similarByCategory(enrichDoc, plugin.full_name),
      })
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
      const results = auditByNpm(data.plugins, names)
      // Attach the compat slice (engines.dsh + first 3 dsh peers) to each
      // hit, joined on npm package name; unlisted names stay null. A failed
      // compat fetch degrades to no annotation rather than failing the audit.
      const compatDoc = await store.compat().catch(() => null)
      const compat = compatByNpm(compatDoc)
      const annotated: Record<string, unknown> = {}
      for (const name of names) {
        const card = results[name]
        annotated[name] = card
          ? { ...card, compat: compat.get(name.toLowerCase()) ?? null }
          : null
      }
      sendJson(res, 200, {
        ok: true,
        generatedAt: data.generatedAt ?? null,
        results: annotated,
      })
      return
    }
    if (pathname === `${PREFIX}/scenarios`) {
      // Passthrough plus per-pick annotations (joined from the corpus on
      // full_name, omitted when the corpus has no row):
      // - `pkgName` so the client can offer copyable `dsh plugin add/remove`
      //   commands;
      // - `observed` — the compat-observed load-test verdict + the outcome at
      //   the RUNNING dsh version (null when that version was never tested).
      // compat-observed.json only exists on newer site builds: a 404/parse
      // failure degrades to no annotation rather than failing the response.
      // Response shape stays backward-compatible: picks only gain fields.
      const doc = (await store.scenarios()) as ScenariosDocShape
      const data = await store.insights()
      const observedDoc = await store.compatObserved().catch(() => null)
      const observed = observedByPkg(observedDoc)
      const currentShell = dshVersion()
      const pkgByRepo = new Map<string, string>()
      for (const p of data.plugins) {
        if (p.pkgName) pkgByRepo.set(p.full_name.toLowerCase(), p.pkgName)
      }
      const scenarios = (doc.scenarios ?? []).map((scenario) => ({
        ...scenario,
        plugins: (scenario.plugins ?? []).map((plugin) => {
          const pkgName = pkgByRepo.get((plugin.full_name ?? '').toLowerCase())
          const annotated = pkgName ? { ...plugin, pkgName } : { ...plugin }
          const entry = pkgName ? observed.get(pkgName.toLowerCase()) : undefined
          if (!entry) return pkgName ? annotated : plugin
          const { atCurrentShell, missing } = observedAtShell(entry, currentShell)
          return {
            ...annotated,
            observed: {
              verdict: entry.verdict,
              atCurrentShell,
              ...(missing ? { missing } : {}),
            },
          }
        }),
      }))
      sendJson(res, 200, {
        ok: true,
        scenarios: { ...doc, scenarios, observedAt: observedGeneratedAt(observedDoc) },
      })
      return
    }
    if (pathname === `${PREFIX}/dynamics`) {
      sendJson(res, 200, { ok: true, dynamics: await store.dynamics() })
      return
    }
    if (pathname === `${PREFIX}/runtime`) {
      // Local-only info (no upstream fetch): the running dsh version, null
      // when the official packages cannot be resolved from here.
      sendJson(res, 200, { ok: true, dsh: { version: dshVersion() } })
      return
    }
    if (pathname === `${PREFIX}/installed`) {
      // Local-only (no upstream fetch): the active profile's installed
      // plugins, read from the profile manifest on every request so plugin
      // add/remove is reflected on the next panel open.
      sendJson(res, 200, { ok: true, ...readInstalledInventory() })
      return
    }
    if (pathname === `${PREFIX}/compat`) {
      // Local-only: every enabled plugin's client-bundle requires vs the
      // on-disk shell's module table (the next boot's resolvable set) — the
      // "will it survive the running/next dsh build" pre-check. shell is null
      // when the install tree cannot be located.
      sendJson(res, 200, { ok: true, compat: checkClientCompat() })
      return
    }
    if (pathname === `${PREFIX}/upgrade-check`) {
      // Local + upstream combined: the running dsh version vs the latest
      // shell in the observed compat matrix, with every enabled installed
      // plugin's observed load outcome AT that latest version. Both upstream
      // docs degrade to null on failure (older sites lack compat-observed
      // entirely) — the answer then is available:false, never an error.
      const inventory = readInstalledInventory()
      const observedDoc = await store.compatObserved().catch(() => null)
      const dynamicsDoc = await store.dynamics().catch(() => null)
      const installed = inventory.plugins
        .filter((plugin) => plugin.enabled)
        .map((plugin) => plugin.name)
      sendJson(res, 200, {
        ok: true,
        ...computeUpgradeCheck(observedDoc, dynamicsDoc, installed, dshVersion()),
      })
      return
    }
    if (pathname === `${PREFIX}/health`) {
      sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-insights-kit',
        uptimeMs: Date.now() - startedAt,
        caches: store.status(),
        // The client renders one-click install/uninstall buttons only when
        // this is true (kill switch off AND pnpm runnable); older builds lack
        // the routes entirely and the client falls back to copy-commands.
        mutations: !mutationsDisabled() && await pnpmAvailable(),
        // Whether this host build can activate mutations without a restart
        // (the vendored include plugin importable). False → install/uninstall
        // still work, they just need a `dsh web` restart.
        hotMount: await hotMountAvailable(),
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
          '/dsh-insights/runtime',
          '/dsh-insights/installed',
          '/dsh-insights/compat',
          '/dsh-insights/upgrade-check',
          '/dsh-insights/health',
          'POST /dsh-insights/install',
          'POST /dsh-insights/uninstall',
          'POST /dsh-insights/disable',
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

// ── mutations (one-click install/uninstall) ─────────────────────────────────

/** Kill switch: any truthy-but-"0" value disables the mutation surface. */
function mutationsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DSH_INSIGHTS_NO_MUTATE
  return value !== undefined && value !== '' && value !== '0'
}

/**
 * Cross-origin pages cannot set this header without a CORS preflight this
 * server never answers, so requiring it blocks browser-borne CSRF outright
 * (the host-trust gate already pins Host/Origin to the loopback authority).
 */
const MUTATION_HEADER = 'x-dsh-insights-kit'
const MAX_BODY_BYTES = 4096

/** Read a small JSON body; null on anything malformed or oversized. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        resolvePromise(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolvePromise(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null)
      } catch {
        resolvePromise(null)
      }
    })
    req.on('error', () => resolvePromise(null))
  })
}

async function handleMutation(
  req: IncomingMessage,
  res: ServerResponse,
  store: InsightsStore,
  op: OpKind,
  getLoader: () => LoaderLike | null,
  hotCtx: HotContext,
): Promise<void> {
  if (mutationsDisabled()) {
    sendJson(res, 403, { ok: false, error: wireError('mutations-disabled', 'mutations disabled (DSH_INSIGHTS_NO_MUTATE)') })
    return
  }
  if (req.headers[MUTATION_HEADER] !== 'mutate') {
    sendJson(res, 403, { ok: false, error: wireError('mutation-header-required', `missing ${MUTATION_HEADER}: mutate`) })
    return
  }
  const body = await readJsonBody(req)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!isMutablePackage(name)) {
    sendJson(res, 400, { ok: false, error: wireError('invalid-name', 'name must be a non-official npm package name') })
    return
  }
  const { profile, dir } = resolveProfileDir()
  if (!existsSync(join(dir, 'package.json'))) {
    sendJson(res, 500, { ok: false, error: wireError('profile-missing', `profile ${profile} has no manifest at ${dir}`) })
    return
  }
  const inventory = readInstalledInventory()
  const row = inventory.plugins.find((plugin) => plugin.name.toLowerCase() === name.toLowerCase())
  const installed = row !== undefined

  if (op === 'install') {
    if (row?.enabled === true) {
      sendJson(res, 200, { ok: true, name, op, status: 'done', note: 'already-installed', restartRequired: false })
      return
    }
    if (row !== undefined && row.version !== null) {
      // Installed but disabled (out of the bundles load list, files on disk):
      // re-enable = bundles append + hot mount, no pnpm run. (A null version
      // means declared-but-not-materialized — falls through to full install.)
      if (!editBundles(dir, row.name, 'add')) {
        sendJson(res, 500, { ok: false, name, op, status: 'failed', detail: 'failed to edit dsh.profile.bundles', restartRequired: false })
        return
      }
      const hot = await hotMount(hotCtx, dir, row.name)
      sendJson(res, 200, {
        ok: true,
        name,
        op,
        status: 'done',
        note: 're-enabled',
        hot: hot.ok,
        detail: hot.reason ?? undefined,
        restartRequired: !hot.ok,
      })
      return
    }
    // Scope installs to plugin packages the corpus knows — the buttons exist
    // to install vetted ecosystem plugins, not arbitrary npm packages.
    const data = await store.insights()
    const known = data.plugins.some((plugin) => plugin.pkgName?.toLowerCase() === name.toLowerCase())
    if (!known) {
      sendJson(res, 400, { ok: false, error: wireError('not-in-corpus', `${name} is not a plugin package in the dsh-insights corpus`) })
      return
    }
    const result = await installPackage(dir, name)
    if (!result.ok) {
      sendJson(res, 500, { ok: result.ok, name, op, status: result.status, detail: result.detail, restartRequired: false })
      return
    }
    // Restart-free activation: mount the fresh package into the running
    // composition (dsh-market's Include-subtree recipe). Failure degrades to
    // restart-required — the durable manifest state already converges.
    const hot = await hotMount(hotCtx, dir, name)
    sendJson(res, 200, {
      ok: true,
      name,
      op,
      status: 'done',
      hot: hot.ok,
      detail: hot.reason ?? undefined,
      restartRequired: !hot.ok,
    })
    return
  }

  if (op === 'disable') {
    // Quarantine a broken/misbehaving plugin: out of the load list, files
    // kept — the crash-immunity escape hatch that keeps dsh bootable.
    if (!installed) {
      sendJson(res, 404, { ok: false, error: wireError('not-installed', `${name} is not installed in profile ${profile}`) })
      return
    }
    if (row?.enabled === false) {
      sendJson(res, 200, { ok: true, name, op, status: 'done', note: 'already-disabled', restartRequired: false })
      return
    }
    const shape = readBundlesShape(dir)
    if (shape !== 'list') {
      sendJson(res, 400, {
        ok: false,
        error: wireError('unsupported-profile', shape === 'all'
          ? `profile ${profile} has no dsh.profile.bundles list — single-plugin disable is not expressible (every dependency loads)`
          : `profile ${profile} manifest unreadable`),
      })
      return
    }
    // Same reverse-dependency guard as uninstall: a disabled dependency is an
    // UNLOADED dependency — dependents crash at the next boot identically.
    const dependents = findDependents(dir, name)
    if (dependents.length > 0) {
      sendJson(res, 409, {
        ok: false,
        error: wireError('has-dependents', `${name} is a dependency of: ${dependents.join(', ')}`),
        dependents,
      })
      return
    }
    const liveOff = await hotUnmount(name) || await disableEntry(getLoader(), name)
    if (!editBundles(dir, name, 'remove')) {
      sendJson(res, 500, { ok: false, name, op, status: 'failed', detail: 'failed to edit dsh.profile.bundles', restartRequired: false })
      return
    }
    sendJson(res, 200, { ok: true, name, op, status: 'done', hot: liveOff, restartRequired: !liveOff })
    return
  }

  if (!installed) {
    sendJson(res, 404, { ok: false, error: wireError('not-installed', `${name} is not installed in profile ${profile}`) })
    return
  }
  // Reverse-dependency guard: removing a package other installed plugins
  // declare as a dependency breaks THEM at the next boot (the shared-building
  // -block crash class). Refuse and name the dependents; the user uninstalls
  // those first.
  const dependents = findDependents(dir, name)
  if (dependents.length > 0) {
    sendJson(res, 409, {
      ok: false,
      error: wireError('has-dependents', `${name} is a dependency of: ${dependents.join(', ')}`),
      dependents,
    })
    return
  }
  // Stop the live plugin first (hot mount dispose, else the bundle-layer
  // in-memory disable), then the file-level removal. A pnpm failure after
  // this leaves the package disabled-but-on-disk — consistent and reported.
  const liveOff = await hotUnmount(name) || await disableEntry(getLoader(), name)
  const result = await uninstallPackage(dir, name)
  const code = result.ok ? 200 : result.status === 'partial' ? 200 : 500
  sendJson(res, code, {
    ok: result.ok,
    name,
    op,
    status: result.status,
    hot: liveOff,
    detail: result.detail,
    restartRequired: result.status === 'failed' ? false : !liveOff,
  })
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
