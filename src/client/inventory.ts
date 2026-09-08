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

import { fetchHealth, fetchInstalled, type InstalledPlugin } from './api.ts'

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
  return new Set((inventory?.plugins ?? []).filter((plugin) => plugin.enabled).map((plugin) => plugin.name))
}

// ── mutation capability + change propagation ────────────────────────────────

let mutationsPromise: Promise<boolean> | null = null

/**
 * Whether the host face reports usable one-click mutations (kill switch off
 * AND pnpm runnable), per /dsh-insights/health. False on older builds (the
 * probe 404s), which flips the UI back to copy-commands.
 */
export function mutationsAvailable(): Promise<boolean> {
  mutationsPromise ??= fetchHealth()
    .then((health) => health.mutations === true)
    .catch(() => false)
  return mutationsPromise
}

/** Fired (window event) after a successful install/uninstall. */
export const INSTALLED_CHANGED_EVENT = 'dsh-insights-kit:installed-changed'

/**
 * Drop the memoized inventory and notify the panel sections to re-read it.
 * Called after any successful profile mutation.
 */
export function invalidateInstalled(): void {
  installedPromise = null
  try {
    window.dispatchEvent(new Event(INSTALLED_CHANGED_EVENT))
  } catch {
    // non-browser context — nothing subscribed anyway
  }
}
