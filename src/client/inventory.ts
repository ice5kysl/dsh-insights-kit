/**
 * dsh-insights-kit — installed-plugin enumeration for the browser face.
 *
 * Enumeration reads the ACTIVE PROFILE's manifest through the plugin's own
 * host route (`GET /dsh-insights/installed`, pure filesystem read of
 * `<DSH_HOME>/profiles/<profile>` — the same seam `dsh plugin add` operates
 * on). This replaces the earlier `pluginInventory` Remote integration: that
 * namespace is not mounted by every dsh build, cordis guards un-injected
 * reads with a throw, and the bounded-wait child fiber left the 体检 page
 * parked on「正在枚举…」when it never appeared. The profile manifest is
 * available on every build, so enumeration no longer depends on any cordis
 * service.
 *
 * The result is memoized for the page session (module-level): the 体检 /
 * 场景 / 查验 sections all consume the same promise, and a plugin add/remove
 * shows up on the next page load. When the route itself fails (host face not
 * loaded, older host build), `getInstalled()` resolves to null and the 体检
 * page falls back to the version/compatibility reminder form.
 *
 * @module dsh-insights-kit/inventory
 */

import { fetchInstalled, type InstalledPlugin } from './api.ts'

export type { InstalledPlugin }

export interface InstalledInventory {
  profile: string
  /** Count of in-box @deepseek-ai/* baseline bundles (not audited). */
  baseline: number
  plugins: readonly InstalledPlugin[]
}

let installedPromise: Promise<InstalledInventory | null> | null = null

/**
 * The active profile's installed-plugin inventory (memoized for the page
 * session). Never rejects: any failure resolves to null (degraded 体检
 * page; other sections just skip their「已安装」markers).
 */
export function getInstalled(): Promise<InstalledInventory | null> {
  installedPromise ??= fetchInstalled()
    .then((res) => ({ profile: res.profile, baseline: res.baseline, plugins: res.plugins }))
    .catch(() => null)
  return installedPromise
}

/** Convenience: the installed npm package names as a set (for「已安装」pills). */
export async function installedNameSet(): Promise<ReadonlySet<string>> {
  const inventory = await getInstalled()
  return new Set((inventory?.plugins ?? []).map((plugin) => plugin.name))
}
