/**
 * dsh-insights-kit — browser (client) face.
 *
 * Two registrations, both official additive seams:
 *
 * - `sidebar.footer.action` (list/root) — an always-visible footer button
 *   that opens the「生态」panel (via a window event; slot components share
 *   no ctx).
 * - `shell.overlay` (list/root) — the panel itself: a right-side drawer over
 *   the app (click-through until it opts into pointer events), hosting the
 *   three capability sections 体检 / 查验 / 场景.
 *
 * Also resolves the official `pluginInventory` Remote namespace (pre-mounted
 * by standard web builds via dsh-api-remotes) for the 体检 section via a
 * child fiber parked on the dependency — cordis guards un-injected service
 * reads with a throw, and a hard inject would park the whole panel on builds
 * without the namespace; builds without it degrade the 体检 page to the
 * version/compatibility reminder form, never breaking the rest of the panel.
 *
 * The same Loader entry carries the host face (`lib/index.js`, the
 * /dsh-insights routes), so this module ships as the package's `./client`
 * export and only ever runs in the browser cordis tree.
 *
 * @module dsh-insights-kit/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { InsightsPanel } from './InsightsView.tsx'
import { mountInventory, setInventoryLister, type RemoteLike } from './inventory.ts'
import { SidebarAction } from './SidebarAction.tsx'

export const name = 'insights'
export const inject = ['slots', 'remote'] as const

/** Minimal service faces this plugin consumes (typed locally at the boundary). */
interface SlotsLike {
  /** Run `cb` for the lifetime of the slot declaration (re-runs after redeclare). */
  inject(slot: string, cb: () => unknown): void
  /** Register one component into a declared slot. */
  register(options: Record<string, unknown>, component: unknown): unknown
}

interface ClientCtxLike {
  logger(name: string): { info(...parts: unknown[]): void }
  slots: SlotsLike
  remote: RemoteLike
  inject(names: string[], cb: (ctx: { remote: RemoteLike }) => void): unknown
}

export function apply(raw: Context): void {
  const ctx = raw as unknown as ClientCtxLike
  const log = ctx.logger('insights:client')

  // Inventory resolution parks a child fiber on `remote.pluginInventory`
  // (bounded wait, never rejects): slot components get no ctx, so stash the
  // promise for the 体检 section (null = enumeration unavailable → degraded
  // page). Never blocks the panel's other sections.
  setInventoryLister(mountInventory(ctx))

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'insights-kit.action', order: 10 },
      SidebarAction,
    ),
  )

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'insights-kit.panel', order: 100 },
      InsightsPanel,
    ),
  )

  log.info('DSH Insights client ready (sidebar footer action + overlay panel)')
}
