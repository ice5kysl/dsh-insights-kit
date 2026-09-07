/**
 * dsh-insights-kit — installed-plugin enumeration via the official Remote.
 *
 * The host ships a read-only projection of the Cordis Loader state,
 * `@deepseek-ai/dsh-host-plugin-inventory` (Remote namespace
 * `pluginInventory`, method `list`). Standard dsh web builds pre-mount every
 * official Remote at boot (dsh-api-remotes), so the namespace is already
 * present on `ctx.remote` — probe it and use it directly.
 *
 * Mounting the contribution ourselves (`TypertClientRemote.$mount`) is
 * deliberately NOT done: the gateway rejects non-strict codecs at mount time
 * (`requireStrictCodec` in dsh-api-gateway), so a self-mount would have to
 * bundle the official descriptor's zod schema — hundreds of KB on every page
 * load — and on standard builds it would collide with the pre-mounted
 * namespace ("already mounted") anyway.
 *
 * Graceful degradation is a first-class path: when the probe finds no usable
 * namespace, `mountInventory` resolves to null and the「我的插件体检」page
 * falls back to the version/compatibility reminder form.
 *
 * @module dsh-insights-kit/inventory
 */

import { installedPluginNames, npmNameOfModule } from '../shared/installed.ts'

export { installedPluginNames, npmNameOfModule }

export interface PluginInventoryEntry {
  readonly entryId: string
  /** Exact module specifier imported by the Loader entry (npm name or path). */
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
}

interface RemoteResult<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { message?: string }
}

/** Minimal face of the client Remote gateway this plugin consumes. */
export interface RemoteLike {
  pluginInventory?: {
    list(): Promise<RemoteResult<{ entries: readonly PluginInventoryEntry[] }>>
  }
}

export type InventoryLister = () => Promise<readonly PluginInventoryEntry[]>

/**
 * Probe `remote.pluginInventory` and wrap it as a lister; null when the
 * namespace is absent (enumeration unavailable on this build).
 */
function listerOf(remote: RemoteLike): InventoryLister | null {
  const ns = remote.pluginInventory
  if (!ns || typeof ns.list !== 'function') return null
  return async () => {
    const result = await ns.list()
    if (!result.ok || !result.value) {
      throw new Error(result.error?.message ?? 'pluginInventory/list failed')
    }
    return result.value.entries
  }
}

/**
 * Resolve the inventory lister from the pre-mounted namespace; null when the
 * running build does not expose it (enumeration unavailable → degraded page).
 */
export async function mountInventory(remote: RemoteLike): Promise<InventoryLister | null> {
  return listerOf(remote)
}

// ── module-level stash (slot components get no ctx) ──────────────────────────

let listerPromise: Promise<InventoryLister | null> | null = null

/** Called once from the client apply(); the panel reads via getInventoryLister. */
export function setInventoryLister(promise: Promise<InventoryLister | null>): void {
  listerPromise = promise
}

/** The mounted lister, or null when enumeration is unavailable on this build. */
export function getInventoryLister(): Promise<InventoryLister | null> {
  return listerPromise ?? Promise.resolve(null)
}
