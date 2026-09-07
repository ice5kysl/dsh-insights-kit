/**
 * dsh-insights-plugin — browser (client) face.
 *
 * One registration on the official additive seam:
 *
 * `conversation.view` (list/session) — a「生态」view tab registered after the
 * shipped chat (order 0) and trajectory (order 10) tabs, at order 30, so the
 * session header reads 对话 | 轨迹 | … | 生态. While the tab is active the
 * session body becomes the DSH Insights assistant (查验 / 场景 / 动态);
 * switching tabs or sessions unmounts it.
 *
 * The same Loader entry carries the host face (`lib/index.js`, the
 * /dsh-insights routes), so this module ships as the package's `./client`
 * export and only ever runs in the browser cordis tree.
 *
 * @module dsh-insights-plugin/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { L } from './locale.ts'
import { InsightsView } from './InsightsView.tsx'

export const name = 'insights'
export const inject = ['slots'] as const

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
}

export function apply(raw: Context): void {
  const ctx = raw as unknown as ClientCtxLike
  const log = ctx.logger('insights:client')

  // The「生态」view tab: order 30 renders after the shipped chat (0) and
  // trajectory (10) tabs and the file-explorer kit (20) when present; the
  // header tab strip lists conversation.view entries automatically, and the
  // body renders only the active entry (官方 `only: <active id>` 机制).
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'insights',
        order: 30,
        label: () => L('生态', 'Ecosystem'),
      },
      InsightsView,
    ),
  )

  log.info('DSH Insights registered as session view tab (对话 | 轨迹 | 生态)')
}
