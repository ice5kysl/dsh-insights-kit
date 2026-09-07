/**
 * dsh-insights-kit — installed-plugin enumeration via the official Remote.
 *
 * The host ships a read-only projection of the Cordis Loader state,
 * `@deepseek-ai/dsh-host-plugin-inventory` (Remote namespace
 * `pluginInventory`, method `list`). Standard dsh web builds pre-mount every
 * official Remote at boot (dsh-api-remotes), so the namespace is available as
 * the cordis service `remote.pluginInventory`.
 *
 * Cordis guards service access: reading `remote.pluginInventory` from a fiber
 * that did not declare it in `inject` throws ("cannot get property … without
 * inject"). Declaring it on the plugin's own `inject` would make it a hard
 * dependency — on a build without the namespace the whole panel would park
 * forever. Instead `mountInventory` parks a child fiber on the dependency
 * (`ctx.inject([...], cb)` fires once the service appears, never otherwise)
 * with a bounded wait, so the rest of the panel loads regardless.
 *
 * Graceful degradation is a first-class path: when the namespace never shows
 * up, `mountInventory` resolves to null and the「我的插件体检」page falls
 * back to the version/compatibility reminder form.
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

/** Minimal face of the cordis context this plugin's resolution path needs. */
export interface CtxLike {
  remote: RemoteLike
  /** Park a callback on service dependencies; fires once they are available. */
  inject(names: string[], cb: (ctx: { remote: RemoteLike }) => void): unknown
}

export type InventoryLister = () => Promise<readonly PluginInventoryEntry[]>

/**
 * Wrap `remote.pluginInventory` as a lister; null when the namespace is
 * absent. Never throws: the cordis accessor guard throws on un-injected
 * reads, so every probe is wrapped.
 */
function listerOf(remote: RemoteLike): InventoryLister | null {
  let ns: RemoteLike['pluginInventory']
  try {
    ns = remote.pluginInventory
  } catch {
    return null
  }
  if (!ns || typeof ns.list !== 'function') return null
  return async () => {
    const result = await ns.list()
    if (!result.ok || !result.value) {
      throw new Error(result.error?.message ?? 'pluginInventory/list failed')
    }
    return result.value.entries
  }
}

/** Bounded wait for the namespace service to appear after apply(). */
const INVENTORY_WAIT_MS = 3000

/**
 * Resolve the inventory lister. The namespace is usually pre-mounted by the
 * time a dynamic plugin starts, so the injected child fiber fires on the next
 * tick; on builds without it the wait times out to null (degraded page).
 * The returned promise never rejects.
 */
export function mountInventory(ctx: CtxLike): Promise<InventoryLister | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), INVENTORY_WAIT_MS)
    try {
      ctx.inject(['remote', 'remote.pluginInventory'], (child) => {
        clearTimeout(timer)
        resolve(listerOf(child.remote))
      })
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
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
