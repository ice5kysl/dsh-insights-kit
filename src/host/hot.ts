/**
 * dsh-insights-kit — restart-free activation (hot mount/unmount).
 *
 * Minimal port of dsh-market's proven recipe (src/hot.ts): a freshly
 * installed plugin joins the RUNNING composition through a kit-owned Include
 * subtree (`@deepseek-ai/cordis-plugin-include`, vendored with the harness).
 * Durable state stays with the profile manifest (`dependencies` +
 * `dsh.profile.bundles`, written by ops.ts), so the next boot loads the
 * plugin through the normal bundle layer; the subtree here exists only for
 * the current process — its input files live under `<profile>/.dsh-insights/`
 * and are wiped on every boot, so nothing can collide with the bundle layer.
 *
 * Two activation shapes:
 * - packages with a `cordis.patch.yml` of PLAIN insert rows (`- id:` /
 *  `name:`) — the rows are rewritten under `dshi-`-prefixed ids and mounted;
 * - client-only packages (`dsh.client` without a patch) — a shim entry under
 *   the package name, so the client module system gets a live loader entry
 *   to serve the bundle from.
 *
 * Anything else (patch with config/expression rows, include plugin
 * unavailable on the host, wedged activation) degrades to
 * `restartRequired: true` — the durable manifest state is already correct,
 * so a restart always converges.
 *
 * Uninstall works for both our hot mounts (dispose the handle) and
 * bundle-layer entries (loader.entries() + `update({disabled})`, the
 * in-memory toggle dsh-market's theme manager uses).
 *
 * @module dsh-insights-kit/host-hot
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Per-profile dir holding this session's hot-mount input files. */
const HOT_DIR = '.dsh-insights'

/** Id prefix for hot-mounted rows — never collides with the bundle layer. */
const ID_PREFIX = 'dshi-'

/** Ceiling for one hot-mount activation before it counts as wedged. */
const HOT_MOUNT_TIMEOUT_MS = 10_000

interface HotRow {
  id: string
  name: string
}

export interface PluginHandle {
  await(): Promise<unknown>
  dispose(): Promise<unknown> | void
}

/** The slice of the cordis context the hot mount consumes. */
export interface HotContext {
  plugin(plugin: unknown, config: unknown): PluginHandle
  logger?(name: string): { info?(...parts: unknown[]): void; warn?(...parts: unknown[]): void }
}

/** The loader-entry face the live disable path needs (cordis Loader). */
export interface LoaderEntryLike {
  options: { id?: string; name?: string; disabled?: boolean | null }
  fiber?: unknown
  update(options: { disabled: boolean | null }, create?: boolean, force?: boolean): Promise<void>
}

export interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
}

// ── the Include subclass (host-capability probe, memoized) ───────────────────

let hotTreeClass: unknown | null | undefined

/** Packages whose host import is replaced by a no-op shim (client-only). */
const shimNames = new Set<string>()

/**
 * The write-suppressed Include subclass, built once per process; null when
 * the harness's vendored include plugin is not importable (older builds) —
 * callers then fall back to restart activation.
 */
async function loadHotTreeClass(): Promise<unknown | null> {
  if (hotTreeClass !== undefined) return hotTreeClass
  try {
    // Computed specifier: the include plugin ships with the harness
    // (vendored, unpublished), resolving through the profile fallback at
    // runtime. DSH_INSIGHTS_INCLUDE_MODULE overrides it for tests.
    const specifier = process.env.DSH_INSIGHTS_INCLUDE_MODULE ?? '@deepseek-ai/cordis-plugin-include'
    const mod = (await import(specifier)) as {
      Include?: new (...args: never[]) => { write(): void; import(name: string): unknown }
    }
    if (mod.Include === undefined) throw new Error('no Include export')
    const Base = mod.Include
    class InsightsHotTree extends Base {
      /** Runtime-only mount list; the bundle layer owns persistence. */
      override write(): void {}
      override import(name: string): unknown {
        if (shimNames.has(name)) return { name, apply: () => {} }
        return super.import(name)
      }
    }
    hotTreeClass = InsightsHotTree
  } catch {
    hotTreeClass = null
  }
  return hotTreeClass
}

// ── cordis.patch.yml parsing (plain insert rows only) ────────────────────────

/**
 * Insert rows of a plugin's bundle patch, or null when the patch contains
 * anything beyond plain `id`/`name` insert rows (config blocks, disables,
 * expressions) — those compositions fall back to restart activation.
 */
export function parseSimplePatch(patchText: string): HotRow[] | null {
  const rows: HotRow[] = []
  let pending: string | null = null
  for (const raw of patchText.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    if (/^-\s+insert:\s*$/.test(line)) continue
    const id = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line)
    if (id !== null) {
      if (pending !== null) return null
      pending = id[1]!
      continue
    }
    const name = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (name !== null && pending !== null) {
      rows.push({ id: pending, name: name[1]! })
      pending = null
      continue
    }
    return null
  }
  if (pending !== null || rows.length === 0) return null
  return rows
}

/** Wipe leftover hot-mount inputs; call once when the host face starts. */
export function cleanHotDir(profileDir: string): void {
  let entries: string[]
  try {
    entries = readdirSync(join(profileDir, HOT_DIR))
  } catch {
    return
  }
  for (const name of entries) {
    if (/^hot-\d+\.yml$/.test(name)) rmSync(join(profileDir, HOT_DIR, name), { force: true })
  }
}

// ── mount / unmount ──────────────────────────────────────────────────────────

let hotSequence = 0
const hotHandles = new Map<string, PluginHandle>()

/** Package names currently live through a kit hot mount. */
export function listHotMounts(): string[] {
  return [...hotHandles.keys()]
}

class ActivationTimeout extends Error {}

function raceActivationTimeout<T>(awaitable: T | Promise<T>): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new ActivationTimeout(`activation did not settle within ${HOT_MOUNT_TIMEOUT_MS / 1000}s`))
    }, HOT_MOUNT_TIMEOUT_MS)
    Promise.resolve(awaitable).then(
      (value) => { clearTimeout(timer); resolvePromise(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export interface HotMountResult {
  ok: boolean
  /** Why the plugin could not go live without a restart (null on success). */
  reason: string | null
}

/** The `dsh` declaration block of an installed package, or null when unreadable. */
function readPkgDsh(profileDir: string, packageName: string): { client?: unknown; bundle?: unknown } | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir, 'node_modules', packageName, 'package.json'), 'utf8'),
    ) as { dsh?: { client?: unknown; bundle?: unknown } }
    return manifest.dsh ?? {}
  } catch {
    return null
  }
}

/**
 * Mount `packageName` (just installed into the profile) into the running
 * composition. Never throws: every failure shape returns ok:false + reason,
 * leaving the durable manifest state for the next boot.
 */
export async function hotMount(ctx: HotContext, profileDir: string, packageName: string): Promise<HotMountResult> {
  try {
    const HotTree = await loadHotTreeClass()
    if (HotTree === null) {
      return { ok: false, reason: 'host cannot hot-mount (include plugin unavailable); restart required' }
    }
    let patchText: string | null
    try {
      patchText = readFileSync(join(profileDir, 'node_modules', packageName, 'cordis.patch.yml'), 'utf8')
    } catch {
      patchText = null
    }
    let rows: HotRow[] | null
    if (patchText !== null) {
      rows = parseSimplePatch(patchText)
      if (rows === null) {
        return { ok: false, reason: 'bundle patch carries config/expression rows; hot-mount supports plain inserts only — activates on restart' }
      }
    } else {
      // No host patch: only a client-only package (dsh.client, no dsh.bundle)
      // has anything to activate — via a shim entry so client-modules serves
      // its bundle. Anything else simply has nothing to mount.
      const dsh = readPkgDsh(profileDir, packageName)
      if (dsh === null || dsh.client === undefined || dsh.bundle !== undefined) {
        return { ok: false, reason: 'no bundle patch and no dsh.client surface — nothing to hot-mount' }
      }
      shimNames.add(packageName)
      rows = [{ id: `client-${packageName.replace(/[^A-Za-z0-9_.-]/g, '-')}`, name: packageName }]
    }
    const dir = join(profileDir, HOT_DIR)
    mkdirSync(dir, { recursive: true })
    hotSequence += 1
    const file = join(dir, `hot-${String(hotSequence)}.yml`)
    writeFileSync(file, rows.map((row) => `- id: '${ID_PREFIX}${row.id}'\n  name: '${row.name}'\n`).join(''))
    const handle = ctx.plugin(HotTree, { path: pathToFileURL(file).href })
    try {
      await raceActivationTimeout(handle.await())
    } catch (error) {
      // A wedged activation (typically a plugin parked on a service nothing
      // provides) must not hold the route open: unwind best-effort and
      // report restart-required.
      hotHandles.delete(packageName)
      shimNames.delete(packageName)
      try {
        await handle.dispose()
      } catch { /* best effort */ }
      const reason = error instanceof ActivationTimeout
        ? 'activation timed out (plugin may be waiting on a missing service); activates on restart'
        : `activation failed: ${(error as Error).message}`
      return { ok: false, reason }
    }
    hotHandles.set(packageName, handle)
    return { ok: true, reason: null }
  } catch (error) {
    return { ok: false, reason: `hot-mount failed: ${(error as Error).message}` }
  }
}

/** Whether the vendored include plugin imported — memoized capability probe. */
export async function hotMountAvailable(): Promise<boolean> {
  return (await loadHotTreeClass()) !== null
}

/**
 * Dispose a plugin hot-mounted earlier in this session. False when no live
 * hot mount exists (bundle-layer entries are disabled via disableEntry).
 */
export async function hotUnmount(packageName: string): Promise<boolean> {
  const handle = hotHandles.get(packageName)
  if (handle === undefined) return false
  hotHandles.delete(packageName)
  shimNames.delete(packageName)
  try {
    await handle.dispose()
    return true
  } catch {
    return false
  }
}

/**
 * Live-disable bundle-layer entries whose `options.name` matches the package
 * (the in-memory toggle; the durable removal is the bundles edit + pnpm
 * remove in ops.ts). True when at least one entry flipped.
 */
export async function disableEntry(loader: LoaderLike | null, packageName: string): Promise<boolean> {
  if (loader === null) return false
  let found = false
  for (const entry of loader.entries()) {
    if (entry.options.name !== packageName) continue
    try {
      await entry.update({ disabled: true }, false, true)
      found = true
    } catch {
      // entry update failed — leave the restart path to converge
    }
  }
  return found
}
