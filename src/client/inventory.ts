/**
 * dsh-insights-kit — installed-plugin enumeration via the official Remote.
 *
 * The host ships a read-only projection of the Cordis Loader state,
 * `@deepseek-ai/dsh-host-plugin-inventory` (Remote namespace
 * `pluginInventory`, method `list`). The client-side gateway
 * (`ctx.remote`, provided by dsh-api-gateway) can mount any generated
 * contribution at runtime — `TypertClientRemote.$mount` — so a dynamically
 * loaded plugin like this one can enumerate the Loader entries without any
 * custom RPC. The contribution descriptor is inlined here with a `src-json`
 * result codec (pass-through JSON), which avoids bundling zod (the official
 * generated artifact's only import) — the wire shape is identical, only the
 * client-side validation strictness differs.
 *
 * Graceful degradation is a first-class path: if the host assembly of the
 * running dsh build does not expose the inventory gateway, `mountInventory`
 * resolves to null and the「我的插件体检」page falls back to the
 * version/compatibility reminder form.
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
  $mount(contribution: unknown): Promise<unknown>
  pluginInventory?: {
    list(): Promise<RemoteResult<{ entries: readonly PluginInventoryEntry[] }>>
  }
}

export type InventoryLister = () => Promise<readonly PluginInventoryEntry[]>

/** Generated-equivalent contribution for pluginInventory/list (src-json codec). */
const PLUGIN_INVENTORY_CONTRIBUTION = {
  package: '@deepseek-ai/dsh-host-plugin-inventory',
  descriptors: [
    {
      id: '@deepseek-ai/dsh-host-plugin-inventory#pluginInventory/list',
      service: 'pluginInventory',
      namespace: 'pluginInventory',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [],
      result: { mode: 'src-json' },
    },
  ],
}

/**
 * Mount the inventory namespace in this plugin's fiber and return a lister;
 * resolve to null when the running host does not serve the gateway (older or
 * differently composed dsh builds) or the mount itself fails.
 */
export async function mountInventory(remote: RemoteLike): Promise<InventoryLister | null> {
  try {
    await remote.$mount(PLUGIN_INVENTORY_CONTRIBUTION)
  } catch {
    return null
  }
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
