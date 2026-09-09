/**
 * dsh-insights-kit — local profile mutations (one-click install/uninstall).
 *
 * The recipe mirrors dsh-market's: a dsh plugin is a direct dependency of the
 * active profile, and the manifest's `dsh.profile.bundles` list is the load
 * list. So installing = `pnpm add <name>` in the profile dir + appending the
 * name to bundles; uninstalling = dropping it from bundles + `pnpm remove`.
 * Changes take effect on the next `dsh web` restart (the Loader composes the
 * tree at boot); the response tells the client to say so.
 *
 * Safety posture:
 * - pnpm is spawned with an ARGUMENT ARRAY (no shell), so a crafted name can
 *   never become a command; the name must additionally pass a strict npm
 *   package-name validation before either the manifest or pnpm sees it.
 * - Installs are scoped to names the dsh-insights.com corpus knows as plugin
 *   packages (checked by the route); uninstalls to names actually installed.
 * - The in-box @deepseek-ai/* baseline is never touchable.
 * - The manifest edit is atomic (write temp + rename) and pnpm gets a hard
 *   timeout; a failed pnpm run leaves the manifest untouched (install) or
 *   leaves the package installed-but-disabled (uninstall — reported as
 *   `partial` so the UI can say what happened).
 *
 * @module dsh-insights-kit/host-ops
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type OpKind = 'install' | 'uninstall' | 'disable'

export interface OpResult {
  ok: boolean
  /** `partial`: bundles dropped but pnpm remove failed (package disabled, still on disk). */
  status: 'done' | 'partial' | 'failed'
  /** pnpm's last output lines when status !== 'done'. */
  detail?: string
}

/** Strict npm package-name shape (scoped or plain); no leading dashes, no whitespace. */
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && NPM_NAME_RE.test(name) && !name.startsWith('-')
}

const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

/** Whether one name may EVER be mutated through this surface. */
export function isMutablePackage(name: string): boolean {
  return isValidPackageName(name) && !INBOX_BUNDLES.has(name) && !name.startsWith('@deepseek-ai/')
}

/**
 * The profile's load-list shape: 'list' = `dsh.profile.bundles` is an array
 * (only those load); 'all' = no bundles field (every dependency loads);
 * null = manifest unreadable. Matters because WRITING a bundles array into an
 * 'all'-shape profile silently flips it to 'list' (everything else stops
 * loading) — callers must skip the edit on 'all' (install: nothing to do) or
 * refuse it (disable: not expressible).
 */
export function readBundlesShape(profileDir: string): 'list' | 'all' | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const dsh = (parsed as Record<string, unknown>).dsh
    const profile = typeof dsh === 'object' && dsh !== null && !Array.isArray(dsh)
      ? (dsh as Record<string, unknown>).profile
      : undefined
    const bundles = typeof profile === 'object' && profile !== null && !Array.isArray(profile)
      ? (profile as Record<string, unknown>).bundles
      : undefined
    return Array.isArray(bundles) ? 'list' : 'all'
  } catch {
    return null
  }
}

/**
 * Add/remove one name in the manifest's `dsh.profile.bundles` load list
 * (creating the path on add when absent). Atomic write; unrelated fields are
 * preserved verbatim. Returns false when the manifest is unreadable.
 */
export function editBundles(profileDir: string, name: string, op: 'add' | 'remove'): boolean {
  const file = join(profileDir, 'package.json')
  let manifest: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    manifest = parsed as Record<string, unknown>
  } catch {
    return false
  }
  const dsh = typeof manifest.dsh === 'object' && manifest.dsh !== null && !Array.isArray(manifest.dsh)
    ? { ...(manifest.dsh as Record<string, unknown>) }
    : {}
  const profile = typeof dsh.profile === 'object' && dsh.profile !== null && !Array.isArray(dsh.profile)
    ? { ...(dsh.profile as Record<string, unknown>) }
    : {}
  const current = Array.isArray(profile.bundles)
    ? profile.bundles.filter((entry): entry is string => typeof entry === 'string')
    : []
  const next = op === 'add'
    ? (current.includes(name) ? current : [...current, name])
    : current.filter((entry) => entry !== name)
  profile.bundles = next
  dsh.profile = profile
  manifest.dsh = dsh
  const tmp = join(profileDir, `package.json.dsh-insights-${process.pid}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n')
    renameSync(tmp, file)
  } catch {
    return false
  }
  return true
}

const PNPM_PROBE_TIMEOUT_MS = 10_000

let pnpmProbe: Promise<boolean> | null = null

/**
 * One memoized probe for a runnable pnpm (the mutation engine). The health
 * route reports it so the client only renders one-click buttons when the
 * capability is real; a missing pnpm flips the UI back to copy-commands.
 */
export function pnpmAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  pnpmProbe ??= new Promise<boolean>((resolvePromise) => {
    let child
    try {
      child = spawn(env.DSH_INSIGHTS_PNPM ?? 'pnpm', ['--version'], {
        cwd: homedir(),
        env,
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: PNPM_PROBE_TIMEOUT_MS,
      })
    } catch {
      resolvePromise(false)
      return
    }
    child.on('error', () => resolvePromise(false))
    child.on('close', (code) => resolvePromise(code === 0))
  })
  return pnpmProbe
}

const PNPM_TIMEOUT_MS = 180_000
const TAIL_LIMIT = 2000

/** Run pnpm in the profile dir: arg-array spawn (no shell), hard timeout. */
export function runPnpm(
  profileDir: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpResult> {
  const bin = env.DSH_INSIGHTS_PNPM ?? 'pnpm'
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(bin, args, { cwd: profileDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolvePromise({ ok: false, status: 'failed', detail: `spawn failed: ${(error as Error).message}` })
      return
    }
    let out = ''
    const append = (chunk: Buffer) => {
      out = (out + chunk.toString()).slice(-TAIL_LIMIT)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolvePromise({ ok: false, status: 'failed', detail: `pnpm timed out after ${PNPM_TIMEOUT_MS / 1000}s\n${out}` })
    }, PNPM_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      // ENOENT = pnpm not on PATH — the client falls back to copy-commands.
      resolvePromise({ ok: false, status: 'failed', detail: `pnpm not runnable: ${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise({ ok: true, status: 'done' })
      else resolvePromise({ ok: false, status: 'failed', detail: out || `pnpm exited ${code}` })
    })
  })
}

/**
 * Install one package into the profile: pnpm add first (it owns
 * `dependencies`), then the bundles append (we own the load list). A failed
 * bundles append after a successful add is rolled back with pnpm remove so
 * the profile never carries an installed-but-unlisted package nobody asked
 * for silently. On 'all'-shape profiles (no bundles field = every dependency
 * loads) the bundles edit is skipped outright — writing a list there would
 * flip the shape and unload everything else.
 */
export async function installPackage(profileDir: string, name: string, env?: NodeJS.ProcessEnv): Promise<OpResult> {
  const add = await runPnpm(profileDir, ['add', name], env)
  if (!add.ok) return add
  const shape = readBundlesShape(profileDir)
  if (shape === 'all') return { ok: true, status: 'done' }
  if (shape === null || !editBundles(profileDir, name, 'add')) {
    await runPnpm(profileDir, ['remove', name], env)
    return { ok: false, status: 'failed', detail: 'installed by pnpm but failed to append dsh.profile.bundles (rolled back)' }
  }
  return { ok: true, status: 'done' }
}

/**
 * Uninstall one package: drop it from the load list first (a later pnpm
 * failure then leaves it disabled, not half-loaded), then pnpm remove.
 */
export async function uninstallPackage(profileDir: string, name: string, env?: NodeJS.ProcessEnv): Promise<OpResult> {
  if (!editBundles(profileDir, name, 'remove')) {
    return { ok: false, status: 'failed', detail: 'failed to edit dsh.profile.bundles' }
  }
  const remove = await runPnpm(profileDir, ['remove', name], env)
  if (!remove.ok) return { ok: false, status: 'partial', detail: `disabled (removed from bundles) but pnpm remove failed: ${remove.detail}` }
  return { ok: true, status: 'done' }
}

/**
 * Reverse-dependency guard for uninstall: which installed packages declare
 * `target` in their dependencies/peerDependencies. Removing a shared building
 * block (the cordis:include lesson) breaks every dependent at the next boot
 * with the same "module table" crash class as a shell seed drift — the route
 * refuses the uninstall while this list is non-empty.
 */
export function findDependents(profileDir: string, target: string): string[] {
  const manifestPath = join(profileDir, 'package.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  } catch {
    return []
  }
  const deps = manifest.dependencies
  const names = typeof deps === 'object' && deps !== null && !Array.isArray(deps)
    ? Object.keys(deps as Record<string, unknown>)
    : []
  const dependents: string[] = []
  for (const name of names) {
    if (name === target) continue
    try {
      const pkg = JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, unknown>
        peerDependencies?: Record<string, unknown>
      }
      if ((pkg.dependencies !== undefined && target in pkg.dependencies)
        || (pkg.peerDependencies !== undefined && target in pkg.peerDependencies)) {
        dependents.push(name)
      }
    } catch {
      // unreadable dependent manifest — cannot prove safety either way; skip
    }
  }
  return dependents.sort()
}
