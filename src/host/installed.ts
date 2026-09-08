/**
 * dsh-insights-kit — installed-plugin enumeration via the profile manifest.
 *
 * A dsh plugin IS a direct dependency of the active profile
 * (`<DSH_HOME>/profiles/<profile>/package.json`, DSH_HOME defaulting to
 * `~/.dsh`) — that is the same seam `dsh plugin add` and dsh-market operate
 * on, and unlike the `pluginInventory` Remote namespace it is available on
 * every build: pure filesystem reads, no cordis service to wait for, nothing
 * to park on. The read mirrors dsh-market's src/profile.ts contract:
 *
 * - the in-box bundles (`@deepseek-ai/dsh-base` / `dsh-web-app` /
 *   `dsh-headless`) are the ONLY names filtered out — community plugins may
 *   legitimately live under the official scope, so no scope filter;
 * - the installed version comes from the package's own package.json under
 *   the profile's node_modules (null while the dep is declared but not yet
 *   materialized, e.g. a failed/pending install);
 * - `plugin: false` marks deps that carry no dsh/cordis manifest field —
 *   plain utility deps someone pinned into the profile. They are still
 *   listed (the audit will map them to null = unlisted) so the row count
 *   matches what the profile actually installs.
 *
 * All reads are fail-soft: a missing/corrupt manifest or node_modules entry
 * degrades that piece to empty/null instead of throwing — the 体检 page must
 * never hang on enumeration again.
 *
 * @module dsh-insights-kit/host-installed
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The in-box bundles dsh profile templates install themselves. */
const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

export interface InstalledPluginRow {
  /** npm package name as declared in the profile manifest. */
  name: string
  /** Version range spec from the profile manifest (`^1.2.3`, `link:…`; empty for bundle-only rows). */
  spec: string
  /** Installed version from node_modules, null when not materialized. */
  version: string | null
  /** Carries a dsh/cordis manifest field (i.e. loads as a plugin). */
  plugin: boolean
  /**
   * Present in the manifest's `dsh.profile.bundles` load list. When the
   * manifest declares no bundles field at all, every dep counts as enabled
   * (older profile shapes load every dependency).
   */
  enabled: boolean
}

export interface InstalledInventory {
  profile: string
  /** Count of in-box @deepseek-ai/* bundles present in the manifest. */
  baseline: number
  plugins: InstalledPluginRow[]
}

/** Expand the tilde forms supported by DSH configuration. */
function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the Harness home: explicit override (tests) → `DSH_HOME` →
 * `~/.dsh`. Blank environment values are unset, matching dsh semantics.
 */
export function resolveDshHome(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0
    ? fromEnv
    : join(homedir(), '.dsh'))
  return resolve(expandHomePath(selected))
}

/** Profile directory-name contract (aligned with dsh-app-boot's resolver). */
export function isDshProfileName(profile: string): boolean {
  return profile !== ''
    && profile !== '.'
    && profile !== '..'
    && profile !== 'node_modules'
    && !profile.includes('/')
    && !profile.includes('\\')
    && !profile.includes('\0')
}

/**
 * Which profile this host process booted: `DSH_INSIGHTS_PROFILE` (explicit
 * override) → `--profile <name>` on the host argv → `web`. The argv probe
 * mirrors dsh-market: installs from a secondary profile must not report the
 * real one's inventory.
 */
function activeProfile(env: NodeJS.ProcessEnv, argv: readonly string[]): string {
  const fromEnv = env.DSH_INSIGHTS_PROFILE
  if (fromEnv !== undefined && isDshProfileName(fromEnv)) return fromEnv
  const flag = argv.indexOf('--profile')
  if (flag >= 0) {
    const value = argv[flag + 1]
    if (value !== undefined && isDshProfileName(value)) return value
  }
  return 'web'
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/**
 * Read the installed-plugin inventory of the active profile. Never throws:
 * a missing profile/manifest yields an empty inventory, a missing
 * node_modules entry yields `version: null` for that row.
 *
 * `explicitDir` (DSH_INSIGHTS_PROFILE_DIR) points the read at a fixture or
 * at a host-owned profile location (e.g. DSH Desktop) instead of the
 * DSH_HOME-derived path.
 */
export function readInstalledInventory(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): InstalledInventory {
  const profile = activeProfile(env, argv)
  const explicitDir = env.DSH_INSIGHTS_PROFILE_DIR
  const dir = explicitDir !== undefined && explicitDir.trim().length > 0
    ? resolve(expandHomePath(explicitDir))
    : join(resolveDshHome(undefined, env), 'profiles', profile)

  const empty: InstalledInventory = { profile, baseline: 0, plugins: [] }
  const manifest = readJson(join(dir, 'package.json'))
  if (manifest === null) return empty

  // The load list: `dsh.profile.bundles` when declared (in-box bundles live
  // there and possibly ONLY there), otherwise every dependency loads.
  const dshField = manifest.dsh
  const bundlesRaw = typeof dshField === 'object' && dshField !== null && !Array.isArray(dshField)
    ? (dshField as Record<string, unknown>).profile
    : undefined
  const bundlesValue = typeof bundlesRaw === 'object' && bundlesRaw !== null && !Array.isArray(bundlesRaw)
    ? (bundlesRaw as Record<string, unknown>).bundles
    : undefined
  const bundles = Array.isArray(bundlesValue)
    ? new Set(bundlesValue.filter((name): name is string => typeof name === 'string'))
    : null

  const deps = manifest.dependencies
  const depEntries = typeof deps === 'object' && deps !== null && !Array.isArray(deps)
    ? Object.entries(deps as Record<string, unknown>)
    : []

  const plugins: InstalledPluginRow[] = []
  const seen = new Set<string>()
  let baseline = 0

  // In-box bundles count as the baseline from EITHER the dependencies or the
  // bundles list (different profile shapes place them differently).
  for (const name of INBOX_BUNDLES) {
    if (bundles?.has(name) || depEntries.some(([dep]) => dep === name)) baseline += 1
  }

  const rowFor = (name: string, spec: string): InstalledPluginRow => {
    let version: string | null = null
    let plugin = false
    const pkgPath = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = readJson(pkgPath)
      if (pkg !== null) {
        if (typeof pkg.version === 'string' && pkg.version) version = pkg.version
        // dsh bundles declare `dsh` (manifest v2) or `cordis` (legacy); a dep
        // with neither still loads as a plain library entry.
        plugin = pkg.dsh !== undefined || pkg.cordis !== undefined
      }
    }
    return { name, spec, version, plugin, enabled: bundles === null || bundles.has(name) }
  }

  for (const [name, spec] of depEntries) {
    if (INBOX_BUNDLES.has(name)) continue
    seen.add(name)
    plugins.push(rowFor(name, typeof spec === 'string' ? spec : ''))
  }
  // Bundle-only entries (loaded but not a manifest dependency — e.g. seeded
  // by a profile template) get a row too, with an empty spec.
  if (bundles !== null) {
    for (const name of bundles) {
      if (INBOX_BUNDLES.has(name) || seen.has(name)) continue
      plugins.push(rowFor(name, ''))
    }
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name))
  return { profile, baseline, plugins }
}
