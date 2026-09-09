/**
 * dsh-insights-kit — client-bundle × shell module-table compat check.
 *
 * The 0.1.2-rc.1 incident class: a plugin's client bundle `require()`s a
 * module the current shell can no longer resolve (seed word removed, package
 * dropped from the composition) and the loader dies at boot with a console
 * stack nobody reads. This module turns that crash into a named, visible
 * signal by comparing each installed plugin's bundle requires against what
 * the ON-DISK shell will resolve — i.e. exactly what the next `dsh web`
 * restart loads, so the check doubles as an upgrade pre-flight.
 *
 * What the shell can resolve (mirrors @deepseek-ai/dsh-client-modules'
 * makeRequire): a require(spec) hits when
 *
 *   1. spec is a SEED WORD — the `staticModules` object baked into the shell
 *      SPA asset (`dsh-web-frontend/dist/assets/index-*.js`, served as
 *      `function zp(){return{react:…,"react/jsx-runtime":…}}`; the extraction
 *      below is validated against all 14 published dsh-web-frontend builds);
 *   2. stripClientSuffix(spec) — a trailing "/client" removed — names a GRAPH
 *      ROW: a package with a `dsh.client` surface in the composition (profile
 *      plugins and the in-box @deepseek-ai/* client packages both count).
 *
 * Anything else is reported as `missing`: that plugin cannot load under the
 * current shell. Dynamic import() specifiers are not scanned (unobserved in
 * the wild; bundles built per dsh conventions go through require).
 *
 * All reads are fail-soft: an unlocatable shell yields `shell: null` and the
 * client simply hides the feature — never a guessed red card.
 *
 * @module dsh-insights-kit/host-shell
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readInstalledInventory, resolveProfileDir } from './installed.ts'

// ── seed-word extraction (shell asset) ───────────────────────────────────────

/**
 * Extract the seed-word table from a shell SPA bundle: the boot code calls
 * `staticModules:<fn>()`, and `<fn>` returns an object literal whose KEYS are
 * the seed words (values are minified refs). Strict: any deviation from the
 * observed shape returns null rather than a partial (false-red-card-prone)
 * table.
 */
export function extractSeedWords(source: string): string[] | null {
  const call = /staticModules:([A-Za-z_$][\w$]*)\(\)/.exec(source)
  if (!call) return null
  const fn = call[1]!.replace(/[$]/g, '\\$&')
  const def = new RegExp(`function ${fn}\\(\\)\\{return\\{`).exec(source)
  if (!def) return null
  const keys: string[] = []
  let i = def.index + def[0].length
  for (;;) {
    const entry = /^[\s,]*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*([A-Za-z_$][\w$]*)/.exec(source.slice(i, i + 240))
    if (!entry) return null
    keys.push(entry[1] ?? entry[2] ?? entry[3]!)
    i += entry[0].length
    if (source[i] === '}') break
    if (source[i] !== ',') return null
  }
  return keys.length > 0 ? keys : null
}

/** External require specifiers of a bundle (deduped, order of appearance). */
export function extractRequires(bundleText: string): string[] {
  const seen = new Set<string>()
  // esbuild keeps externals as require("x"); some pipelines emit __require("x")
  // for the same purpose. Only plain string literals count — computed and
  // template (`require(`${spec}`)`) requires are not statically decidable and
  // are left out rather than reported as bogus missing modules.
  const pattern = /\b__require\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(bundleText)) !== null) {
    const spec = match[1] ?? match[2]!
    if (!spec.includes('${')) seen.add(spec)
  }
  return [...seen]
}

/** Mirror of dsh-client-modules: "pkg/client" requires resolve against "pkg". */
export function stripClientSuffix(spec: string): string {
  return spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : spec
}

// ── shell location (memoized by asset identity) ──────────────────────────────

export interface ShellSeedTable {
  /** dsh version owning the shell (from dsh-web-app/dsh-base package.json). */
  version: string | null
  seedWords: string[]
  /** The @deepseek-ai scope directory of the install tree that owns the shell. */
  scopeDir: string
}

interface ShellResolution {
  scopeDir: string
  version: string | null
}

function readVersion(scopeDir: string): string | null {
  for (const pkg of ['dsh-web-app', 'dsh-base']) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(scopeDir, pkg, 'package.json'), 'utf8'))
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string' && version) return version
    } catch {
      // try the next carrier
    }
  }
  return null
}

/** Match the two install-tree shapes under one root: scope dir itself, or a dsh package root carrying node_modules/@deepseek-ai. */
function scopeFromRoot(root: string): ShellResolution | null {
  if (existsSync(join(root, 'dsh-web-frontend', 'dist', 'assets'))) {
    return { scopeDir: root, version: readVersion(root) }
  }
  const nestedScope = join(root, 'node_modules', '@deepseek-ai')
  if (existsSync(join(nestedScope, 'dsh-web-frontend', 'dist', 'assets'))) {
    return { scopeDir: nestedScope, version: readVersion(nestedScope) }
  }
  return null
}

/**
 * Locate the dsh install tree's @deepseek-ai scope directory:
 * `DSH_INSIGHTS_DSH_ROOT` (tests; accepts the scope dir itself or a root that
 * contains node_modules/@deepseek-ai) → createRequire resolution of the
 * in-box packages (works from inside the harness process) → the host
 * process's own argv[1] (the dsh CLI entry, e.g. a homebrew symlink into the
 * global install tree). Null when every arm misses.
 */
function resolveShellScope(env: NodeJS.ProcessEnv, argv: readonly string[]): ShellResolution | null {
  const override = env.DSH_INSIGHTS_DSH_ROOT
  if (override !== undefined && override.trim() !== '') {
    return scopeFromRoot(override)
  }
  try {
    const require = createRequire(import.meta.url)
    const webAppPkg = require.resolve('@deepseek-ai/dsh-web-app/package.json')
    // …/@deepseek-ai/dsh-web-app/package.json → the scope directory
    const scopeDir = dirname(dirname(webAppPkg))
    if (existsSync(join(scopeDir, 'dsh-web-frontend', 'dist', 'assets'))) {
      return { scopeDir, version: readVersion(scopeDir) }
    }
  } catch {
    // not resolvable from this process — fall through to the argv probe
  }
  const entry = argv[1]
  if (typeof entry === 'string' && entry !== '') {
    try {
      let dir = dirname(realpathSync(entry))
      for (let depth = 0; depth < 8; depth += 1) {
        const scopeDir = join(dir, 'node_modules', '@deepseek-ai')
        if (existsSync(join(scopeDir, 'dsh-web-frontend', 'dist', 'assets'))) {
          return { scopeDir, version: readVersion(scopeDir) }
        }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch {
      // argv[1] unreadable — capability stays off
    }
  }
  return null
}

let shellCache: { key: string; table: ShellSeedTable | null } | null = null

/** Extract the seed table from one resolved scope dir; memoized by asset path + mtime. */
function seedFromScope(scope: ShellResolution): ShellSeedTable | null {
  let assetPath: string | null = null
  try {
    const assetsDir = join(scope.scopeDir, 'dsh-web-frontend', 'dist', 'assets')
    const asset = readdirSync(assetsDir).filter((name) => /^index-.*\.js$/.test(name)).sort()[0]
    if (asset !== undefined) assetPath = join(assetsDir, asset)
  } catch {
    return null
  }
  if (assetPath === null) return null
  let mtime = 0
  try {
    mtime = statSync(assetPath).mtimeMs
  } catch {
    return null
  }
  const key = `${assetPath}:${mtime}`
  if (shellCache !== null && shellCache.key === key) return shellCache.table
  let table: ShellSeedTable | null = null
  try {
    const seedWords = extractSeedWords(readFileSync(assetPath, 'utf8'))
    if (seedWords !== null) table = { version: scope.version, seedWords, scopeDir: scope.scopeDir }
  } catch {
    table = null
  }
  shellCache = { key, table }
  return table
}

/**
 * The on-disk shell's seed table (what the NEXT boot resolves), memoized so
 * repeated /compat requests do not re-parse a multi-MB bundle while a dsh
 * upgrade between panel opens is still picked up.
 */
export function readShellSeed(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): ShellSeedTable | null {
  const scope = resolveShellScope(env, argv)
  return scope === null ? null : seedFromScope(scope)
}

/** Well-known global dsh package roots, for callers running OUTSIDE the harness (selfcheck CLI). */
function wellKnownRoots(env: NodeJS.ProcessEnv): string[] {
  const dirs = [
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/usr/lib/node_modules/@deepseek-ai/dsh',
  ]
  if (typeof env.APPDATA === 'string' && env.APPDATA !== '') {
    dirs.push(join(env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  }
  return dirs
}

/**
 * readShellSeed plus the well-known global locations — the arm the
 * `selfcheck` CLI needs (it runs from a plugin directory, where neither
 * createRequire nor argv[1] points anywhere near the dsh install tree).
 */
export function readShellSeedLoose(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): ShellSeedTable | null {
  const strict = readShellSeed(env, argv)
  if (strict !== null) return strict
  for (const root of wellKnownRoots(env)) {
    const scope = scopeFromRoot(root)
    if (scope === null) continue
    const table = seedFromScope(scope)
    if (table !== null) return table
  }
  return null
}

// ── graph-row ids (packages with a client surface) ───────────────────────────

function hasClientSurface(pkgDir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    const dsh = (parsed as { dsh?: { client?: unknown } }).dsh
    return typeof dsh === 'object' && dsh !== null && dsh.client !== undefined
  } catch {
    return false
  }
}

/**
 * Ids the shell's module table materializes as graph rows: every profile
 * plugin with a `dsh.client` surface plus the in-box @deepseek-ai/* client
 * packages found next to the shell (rows exist only for packages WITH a
 * client entry, hence the surface check).
 */
export function collectRowIds(profileDir: string, scopeDir: string | null): Set<string> {
  const ids = new Set<string>()
  const scan = (baseDir: string, scoped: boolean): void => {
    let entries: string[]
    try {
      entries = readdirSync(baseDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      if (scoped && entry.startsWith('@')) {
        // one scope level deeper (node_modules/@scope/pkg)
        scan(join(baseDir, entry), false)
        continue
      }
      if (hasClientSurface(join(baseDir, entry))) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(join(baseDir, entry, 'package.json'), 'utf8'))
          const name = (parsed as { name?: unknown }).name
          if (typeof name === 'string' && name) ids.add(name)
        } catch { /* nameless package — skip */ }
      }
    }
  }
  scan(join(profileDir, 'node_modules'), true)
  if (scopeDir !== null) scan(scopeDir, false)
  return ids
}

// ── the per-plugin check ─────────────────────────────────────────────────────

export interface ClientCompatRow {
  name: string
  /** Bundle unreadable/missing → 'unknown'; no dsh.client surface → 'no-client'. */
  status: 'ok' | 'broken' | 'unknown' | 'no-client'
  requires: string[]
  /** Requires the current shell cannot resolve — nonempty ⇒ status 'broken'. */
  missing: string[]
}

export interface ClientCompatReport {
  /** Null when the shell asset cannot be located/parsed — client hides the feature. */
  shell: { version: string | null; seedWords: string[] } | null
  rows: ClientCompatRow[]
}

/** The client bundle path a package's dsh.client surface resolves to. */
function clientBundlePath(pkgDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    const pkg = parsed as { exports?: Record<string, unknown> }
    const client = pkg.exports?.['./client']
    const rel = typeof client === 'string'
      ? client
      : typeof client === 'object' && client !== null
        ? (client as Record<string, unknown>).import ?? (client as Record<string, unknown>).default
        : null
    if (typeof rel === 'string' && rel !== '') return join(pkgDir, rel)
  } catch {
    // fall through to the conventional path
  }
  const conventional = join(pkgDir, 'lib', 'client.js')
  return existsSync(conventional) ? conventional : null
}

/**
 * Compare every enabled profile plugin's client bundle against the on-disk
 * shell's resolvable set. Never throws; unreadable pieces degrade their row
 * to 'unknown' instead of failing the report.
 */
export function checkClientCompat(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): ClientCompatReport {
  const shell = readShellSeed(env, argv)
  if (shell === null) return { shell: null, rows: [] }
  const { dir } = resolveProfileDir(env, argv)
  const seed = new Set(shell.seedWords)
  const rowIds = collectRowIds(dir, shell.scopeDir)
  const inventory = readInstalledInventory(env, argv)
  const rows: ClientCompatRow[] = []
  for (const plugin of inventory.plugins) {
    if (!plugin.enabled) continue
    const pkgDir = join(dir, 'node_modules', plugin.name)
    if (!hasClientSurface(pkgDir)) {
      rows.push({ name: plugin.name, status: 'no-client', requires: [], missing: [] })
      continue
    }
    const bundlePath = clientBundlePath(pkgDir)
    if (bundlePath === null) {
      rows.push({ name: plugin.name, status: 'unknown', requires: [], missing: [] })
      continue
    }
    let requires: string[]
    try {
      requires = extractRequires(readFileSync(bundlePath, 'utf8'))
    } catch {
      rows.push({ name: plugin.name, status: 'unknown', requires: [], missing: [] })
      continue
    }
    const missing = requires.filter((spec) => !seed.has(spec) && !rowIds.has(stripClientSuffix(spec)))
    rows.push({ name: plugin.name, status: missing.length > 0 ? 'broken' : 'ok', requires, missing })
  }
  return { shell: { version: shell.version, seedWords: shell.seedWords }, rows }
}
