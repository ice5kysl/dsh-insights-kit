/**
 * dsh-insights-kit — sidebar footer action (browser face).
 *
 * Occupies the official `sidebar.footer.action` list slot (always visible,
 * whichever workspace browser renders). Clicking toggles the「生态」overlay
 * panel through a window event (slot components share no ctx — the same
 * idiom the workspace-kit sidebar toggle uses).
 *
 * @module dsh-insights-kit/sidebar-action
 */

import type { CSSProperties } from 'react'
import { L } from './locale.ts'

export const PANEL_EVENT = 'dsh-insights-kit:toggle-panel'

/** Selector-shaped props provided by the renderer (no store seat used). */
export interface SidebarActionProps {
  /** Owner share: wide content vs 56px rail. */
  wide?: boolean
}

export function SidebarAction(props: SidebarActionProps): JSX.Element {
  const wide = Boolean(props.wide)
  return (
    <button
      type="button"
      style={wide ? styles.wide : styles.rail}
      title={L(
        'DSH Insights —— 插件体检 / 查验健康分 / 场景发现',
        'DSH Insights — audit installed plugins / check health scores / discover by scenario',
      )}
      onClick={() => window.dispatchEvent(new CustomEvent(PANEL_EVENT))}
    >
      <span style={styles.glyph}>✦</span>
      {wide && <span>{L('生态', 'Insights')}</span>}
    </button>
  )
}

const styles: Record<string, CSSProperties> = {
  wide: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '6px 10px',
    fontSize: 11,
    border: 'none',
    background: 'transparent',
    color: '#5a6478',
    cursor: 'pointer',
    textAlign: 'left',
  },
  rail: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 32,
    fontSize: 14,
    border: 'none',
    background: 'transparent',
    color: '#5a6478',
    cursor: 'pointer',
  },
  glyph: {
    fontSize: 13,
    lineHeight: 1,
  },
}
