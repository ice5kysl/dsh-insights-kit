/**
 * dsh-insights-kit — the「生态」overlay panel (browser face).
 *
 * Registered into the official `shell.overlay` list slot (root scope): the
 * component stays mounted and renders nothing until the sidebar footer
 * action (or its window event) opens it, then draws a right-side drawer over
 * the app — the shell.overlay contract is additive and click-through until
 * an entry opts into pointer events, which the backdrop/drawer do while
 * open. Escape or a backdrop click closes it.
 *
 * Three capability sections, switched by an inner tab strip:
 *
 * 1. 体检 Audit      — enumerates installed plugins from the active
 *    profile's manifest (host-side filesystem read via
 *    `GET /dsh-insights/installed` — the same seam `dsh plugin add` operates
 *    on, available on every build), lists them immediately, then
 *    health-checks them against the corpus in one batch (grade badge + score
 *    per row, S/A/B/C/D summary bar, npm version-drift hints, per-row
 *    dsh-compat signal from compat.json, C/D rows link to on-site
 *    alternatives). Health cards are cached per `name@version` (24h,
 *    stale-while-revalidate): reopening the panel paints cached cards
 *    instantly while unchanged versions re-verify in the background. When
 *    the installed read fails, the page degrades to dist-tags + breaking
 *    releases + advised actions.
 * 2. 场景 Scenarios  — scenario → recommended plugins; clicking a plugin
 *    jumps to Check with it loaded.
 * 3. 查验 Check      — paste `owner/repo` / a GitHub URL for the exact health
 *    card (grade badge, score, dimension bars, deduction list, link out to
 *    the full page on dsh-insights.com), or type a bare keyword to search
 *    the corpus (debounced substring match; a missed exact lookup auto-lists
 *    similar plugins by repo name).
 *
 * All data flows through the host `/dsh-insights` surface; the client never
 * talks to dsh-insights.com directly. Bilingual zh/en with the same toggle
 * idiom as the other kit plugins.
 *
 * @module dsh-insights-kit/insights-view
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  ApiError,
  classifyCheckInput,
  fetchAudit,
  fetchCompat,
  fetchDynamics,
  fetchPlugin,
  fetchRuntime,
  fetchScenarios,
  installPlugin,
  searchPlugins,
  uninstallPlugin,
  disablePlugin,
  type ClientCompatReport,
  type ClientCompatRow,
  type DynamicsDoc,
  type DropSeverity,
  type PluginCard,
  type PluginCompat,
  type ReleaseRow,
  type Scenario,
  type ScenariosDoc,
  type SearchHit,
  type SimilarPick,
} from './api.ts'
import {
  getInstalled,
  INSTALLED_CHANGED_EVENT,
  installedNameSet,
  invalidateInstalled,
  mutationsAvailable,
  type InstalledPlugin,
} from './inventory.ts'
import { isOutdated, satisfiesSimpleRange } from '../shared/compat.ts'
import { getLocale, L, setLocalePreference } from './locale.ts'
import { PANEL_EVENT } from './SidebarAction.tsx'

type Section = 'audit' | 'scenarios' | 'check'
type LoadState = 'idle' | 'loading' | 'error' | 'ready'

const SITE = 'https://dsh-insights.com'

/** Grade → badge color (S 紫 / A 绿 / B 蓝 / C 橙 / D 红). */
const GRADE_COLORS: Record<string, string> = {
  S: '#7c3aed',
  A: '#16a34a',
  B: '#2563eb',
  C: '#ea580c',
  D: '#dc2626',
}

const SEV_COLORS: Record<DropSeverity, string> = {
  fail: '#dc2626',
  major: '#ea580c',
  warn: '#ca8a04',
  minor: '#64748b',
}

const DIM_LABELS: Record<string, { zh: string; en: string }> = {
  eng: { zh: '工程', en: 'Engineering' },
  docs: { zh: '文档', en: 'Docs' },
  discover: { zh: '可发现', en: 'Discovery' },
  maint: { zh: '维护', en: 'Maintenance' },
}

const GRADE_ORDER = ['S', 'A', 'B', 'C', 'D'] as const

// ── style atoms (inline, matching the host shell's plain look) ───────────────

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px',
  borderBottom: '1px solid var(--border, #e2e5e9)',
  flexShrink: 0,
}

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '12px 16px 24px',
}

const subTabStyle = (active: boolean): CSSProperties => ({
  border: '1px solid var(--border, #e2e5e9)',
  borderRadius: 6,
  padding: '3px 12px',
  fontSize: 12,
  cursor: 'pointer',
  background: active ? 'var(--fg, #1f2328)' : 'transparent',
  color: active ? 'var(--bg, #ffffff)' : 'inherit',
})

const buttonStyle: CSSProperties = {
  border: '1px solid var(--border, #d0d7de)',
  borderRadius: 6,
  padding: '5px 14px',
  fontSize: 13,
  cursor: 'pointer',
  background: 'var(--fg, #1f2328)',
  color: 'var(--bg, #ffffff)',
}

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: '1px solid var(--border, #d0d7de)',
  borderRadius: 6,
  padding: '5px 10px',
  fontSize: 13,
  background: 'var(--bg, #ffffff)',
  color: 'inherit',
}

const cardStyle: CSSProperties = {
  border: '1px solid var(--border, #e2e5e9)',
  borderRadius: 8,
  padding: '12px 14px',
  marginBottom: 12,
}

const mutedStyle: CSSProperties = { color: 'var(--fg-muted, #6a737d)', fontSize: 12 }

/** Small「已安装 / Installed」marker on scenario rows. */
const installedPillStyle: CSSProperties = {
  ...mutedStyle,
  border: '1px solid var(--border, #e2e5e9)',
  borderRadius: 6,
  padding: '0 6px',
  fontSize: 11,
  flexShrink: 0,
}

/** Row-trailing「复制命令」button (copies a terminal command, never runs it). */
const copyButtonStyle: CSSProperties = {
  border: '1px solid var(--border, #d0d7de)',
  borderRadius: 6,
  padding: '2px 8px',
  fontSize: 11,
  cursor: 'pointer',
  background: 'transparent',
  color: 'var(--fg-muted, #6a737d)',
  flexShrink: 0,
}

/**
 * One-shot copy-to-clipboard button for a terminal command (`dsh plugin …`).
 * Used as the fallback when the host reports one-click mutations unusable
 * (older build / kill switch / no pnpm). Shows「已复制 ✓」for ~2s after a
 * successful copy. stopPropagation keeps the surrounding row's onPick from
 * firing.
 */
function CopyCommandButton(props: { command: string; label: string }): JSX.Element {
  const { command, label } = props
  const [copied, setCopied] = useState(false)
  return (
    <button
      style={copyButtonStyle}
      title={command}
      onClick={(event) => {
        event.stopPropagation()
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }).catch(() => {})
      }}
    >
      {copied ? L('已复制 ✓', 'Copied ✓') : label}
    </button>
  )
}

/**
 * Re-render trigger for installed-state consumers: bumps every time a
 * successful install/uninstall invalidates the inventory.
 */
function useInstalledEpoch(): number {
  const [epoch, setEpoch] = useState(0)
  useEffect(() => {
    const bump = () => setEpoch((value) => value + 1)
    window.addEventListener(INSTALLED_CHANGED_EVENT, bump)
    return () => window.removeEventListener(INSTALLED_CHANGED_EVENT, bump)
  }, [])
  return epoch
}

/**
 * One-click install/uninstall against the local profile (host POST routes:
 * pnpm + bundles edit). Renders the plain copy-command button instead while
 * the capability probe is pending or the host reports mutations unusable
 * (older build / kill switch / no pnpm) — the panel never hard-depends on
 * the mutation surface. On success the installed inventory is invalidated
 * and every section re-reads it (「已安装」pills and the 体检 list flip).
 */
function InstallActionButton(props: { pkgName: string; installed: boolean; profile?: string }): JSX.Element {
  const { pkgName, installed, profile } = props
  const [canMutate, setCanMutate] = useState<boolean | null>(null)
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState<string>('')
  /** True when the change went live in the running composition (no restart). */
  const [wentHot, setWentHot] = useState(false)

  useEffect(() => {
    let cancelled = false
    void mutationsAvailable().then((available) => {
      if (!cancelled) setCanMutate(available)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Reset any transient result when the row's installed state flips.
  useEffect(() => {
    setState('idle')
    setMessage('')
  }, [installed])

  const command = `dsh plugin --profile ${profile ?? 'web'} ${installed ? 'remove' : 'add'} ${pkgName}`
  if (canMutate !== true) {
    return (
      <CopyCommandButton
        command={command}
        label={installed ? L('复制卸载命令', 'Copy uninstall command') : L('复制安装命令', 'Copy install command')}
      />
    )
  }

  const run = async (): Promise<void> => {
    setState('busy')
    setMessage('')
    setWentHot(false)
    try {
      const result = installed ? await uninstallPlugin(pkgName) : await installPlugin(pkgName)
      invalidateInstalled()
      setWentHot(result.hot === true)
      if (result.note === 'already-installed') {
        setState('done')
        setMessage(L('已安装，无需重复操作', 'Already installed'))
      } else if (result.note === 're-enabled') {
        setState('done')
        setMessage(result.hot === true
          ? L('已恢复启用并即时激活 ✓ 刷新页面即可使用', 'Re-enabled & activated ✓ refresh the page to use it')
          : L('已恢复启用 ✓ 重启 dsh web 后生效', 'Re-enabled ✓ restart `dsh web` to take effect'))
      } else if (result.hot === true) {
        setState('done')
        setMessage(installed
          ? L('已卸载并即时停用 ✓ 刷新页面移除界面', 'Uninstalled & deactivated ✓ refresh the page to remove its UI')
          : L('已安装并即时激活 ✓ 刷新页面即可使用', 'Installed & activated ✓ refresh the page to use it'))
      } else if (result.restartRequired) {
        setState('done')
        setMessage(installed
          ? L('已卸载 ✓ 重启 dsh web 后完全生效', 'Uninstalled ✓ restart `dsh web` to finish')
          : L('已安装 ✓ 重启 dsh web 后生效', 'Installed ✓ restart `dsh web` to activate'))
      } else {
        setState('done')
        setMessage(L('已完成 ✓', 'Done ✓'))
      }
    } catch (error) {
      setState('error')
      if (error instanceof ApiError && error.code === 'has-dependents' && error.dependents && error.dependents.length > 0) {
        setMessage(L(
          '无法卸载：{names} 依赖它，请先卸载依赖方',
          'Blocked: {names} depend on it — uninstall them first',
          { names: error.dependents.join(', ') },
        ))
      } else {
        setMessage(error instanceof Error ? error.message : String(error))
      }
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <button
        style={copyButtonStyle}
        disabled={state === 'busy'}
        title={L('直接在本机 profile 执行（pnpm + 装载清单）；支持热挂载的宿主即刻生效，否则重启 dsh web 生效', 'Runs against the local profile (pnpm + the load list); hot-mount capable hosts activate immediately, otherwise restart `dsh web`')}
        onClick={(event) => {
          event.stopPropagation()
          void run()
        }}
      >
        {state === 'busy'
          ? (installed ? L('卸载中…', 'Uninstalling…') : L('安装中…', 'Installing…'))
          : (installed ? L('卸载', 'Uninstall') : L('安装', 'Install'))}
      </button>
      {state === 'done' && message && <span style={{ ...mutedStyle, color: '#16a34a' }}>{message}</span>}
      {state === 'done' && wentHot && (
        <button
          style={copyButtonStyle}
          onClick={(event) => {
            event.stopPropagation()
            window.location.reload()
          }}
        >
          {L('立即刷新', 'Refresh now')}
        </button>
      )}
      {state === 'error' && (
        <span style={{ ...mutedStyle, color: '#dc2626' }} title={message}>
          {L('操作失败', 'Failed')}{message ? `：${message.slice(0, 120)}` : ''}
        </span>
      )}
    </span>
  )
}

function GradeBadge({ grade, large }: { grade: string | null | undefined; large?: boolean }): JSX.Element {
  const g = (grade ?? '?').toUpperCase()
  const color = GRADE_COLORS[g] ?? '#64748b'
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: large ? 44 : 22,
        height: large ? 44 : 22,
        borderRadius: large ? 10 : 6,
        background: color,
        color: '#fff',
        fontWeight: 700,
        fontSize: large ? 22 : 12,
        flexShrink: 0,
      }}
      title={L('健康等级', 'Health grade')}
    >
      {g}
    </span>
  )
}

function Stars({ n }: { n: number }): JSX.Element {
  return <span style={mutedStyle}>★ {n.toLocaleString()}</span>
}

function ErrorNote({ error }: { error: unknown }): JSX.Element {
  const code = error instanceof ApiError ? error.code : 'internal'
  const text = code === 'upstream'
    ? L('上游数据暂时不可用（dsh-insights.com 拉取失败），请稍后再试', 'Upstream data temporarily unavailable (dsh-insights.com fetch failed); please retry later')
    : code === 'network'
      ? L('无法连接本机 dsh web 服务', 'Cannot reach the local dsh web service')
      : (error as Error)?.message ?? String(error)
  return <div style={{ ...cardStyle, borderColor: '#dc2626', color: '#dc2626' }}>{text}</div>
}

/** Shared breaking-release warning card (both audit forms). */
function BreakingCard({ releases }: { releases: readonly ReleaseRow[] }): JSX.Element | null {
  const breaking = releases.filter((rel) => rel.breaking).slice(0, 3)
  if (breaking.length === 0) return null
  return (
    <div style={{ ...cardStyle, borderColor: '#dc2626' }}>
      <div style={{ fontWeight: 700, color: '#dc2626', marginBottom: 6 }}>
        {L('dsh 官方 BREAKING 变更预警', 'Official dsh BREAKING-change alert')}
      </div>
      <ul style={{ margin: '0 0 6px', paddingLeft: 0, listStyle: 'none' }}>
        {breaking.map((rel) => (
          <li key={rel.tag} style={{ padding: '2px 0' }}>
            <span style={{ background: '#dc2626', color: '#fff', borderRadius: 4, fontSize: 11, fontWeight: 700, padding: '1px 6px', marginRight: 6 }}>BREAKING</span>
            <code style={{ fontWeight: 700 }}>{rel.name ?? rel.tag}</code>
            <span style={{ ...mutedStyle, marginLeft: 6 }}>{(rel.published_at ?? '').slice(0, 10)}</span>
            {rel.summary && <div style={{ ...mutedStyle, marginTop: 2 }}>{rel.summary}</div>}
          </li>
        ))}
      </ul>
      <div style={mutedStyle}>
        {L(
          '升级 dsh 前，已装插件可能需要适配这些变更——建议先逐个查验健康分与维护状态。',
          'Installed plugins may need to adapt to these changes before you upgrade dsh — check each plugin\'s health and maintenance state first.',
        )}
      </div>
    </div>
  )
}

/** dist-tag chips (latest/alpha/next), shown in both audit forms. */
function DistTags({ tags }: { tags: Record<string, string> | undefined }): JSX.Element | null {
  if (!tags || Object.keys(tags).length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
      {Object.entries(tags).map(([tag, version]) => (
        <span key={tag} style={{ ...mutedStyle, border: '1px solid var(--border, #e2e5e9)', borderRadius: 6, padding: '2px 8px' }}>
          {tag}: <code>{version}</code>
        </span>
      ))}
    </div>
  )
}

/**
 *「当前 dsh 版本 · 最新 release」line at the top of the Audit tab. Hidden
 * entirely when the host could not resolve the running version; the upgrade
 * hint compares base versions only (prerelease tags dropped).
 */
function DshVersionLine({ version, latest }: { version: string | null | undefined; latest?: string }): JSX.Element | null {
  if (!version) return null
  const outdated = latest ? isOutdated(version, latest) : null
  return (
    <div style={{ ...mutedStyle, marginBottom: 12 }}>
      {latest
        ? L('当前 dsh 版本 {cur} · 最新 release {lat}', 'Current dsh {cur} · latest release {lat}', { cur: version, lat: latest })
        : L('当前 dsh 版本 {cur}', 'Current dsh {cur}', { cur: version })}
      {outdated === true && (
        <span style={{ color: '#ca8a04' }}>
          {' · '}{L('有新版本，建议升级 dsh', 'newer dsh available — consider upgrading')}
        </span>
      )}
      {outdated === false && (
        <span style={{ color: '#16a34a' }}>
          {' · '}{L('已是最新', 'up to date')} ✓
        </span>
      )}
    </div>
  )
}

/**
 * Per-row dsh-compat line for audit hits: `engines.dsh` preferred, else the
 * cordis peer range (or the first declared dsh peer). A ✓/⚠ verdict is shown
 * only when the running dsh version is known and the range is a simple ^/~
 * range (conservative base-version check); otherwise the bare range text.
 */
function CompatLine({ compat, dshVersion }: { compat: PluginCompat | null | undefined; dshVersion: string | null | undefined }): JSX.Element | null {
  if (!compat) return null
  let text: string
  let verdictRange: string | null = null
  if (compat.enginesDsh) {
    text = L('dsh 兼容：engines.dsh {range}', 'dsh compat: engines.dsh {range}', { range: compat.enginesDsh })
    verdictRange = compat.enginesDsh
  } else {
    const peer = compat.dshPeers.find((p) => p.name === '@deepseek-ai/cordis') ?? compat.dshPeers[0]
    if (!peer) return null
    text = L('dsh 兼容：peer {name} {range}', 'dsh compat: peer {name} {range}', { name: peer.name, range: peer.range })
  }
  const verdict = dshVersion && verdictRange ? satisfiesSimpleRange(dshVersion, verdictRange) : null
  return (
    <div style={{ ...mutedStyle, marginTop: 2, marginLeft: 30 }}>
      {text}
      {verdict === true && <span style={{ color: '#16a34a', marginLeft: 6 }} title={L('当前 dsh 版本满足该范围（按基础版本保守判断）', 'Current dsh satisfies this range (conservative base-version check)')}>✓</span>}
      {verdict === false && <span style={{ color: '#ea580c', marginLeft: 6 }} title={L('当前 dsh 版本不满足该范围（按基础版本保守判断）', 'Current dsh does not satisfy this range (conservative base-version check)')}>⚠</span>}
    </div>
  )
}

// ── section: 体检 Audit ──────────────────────────────────────────────────────

type AuditForm = 'loading' | 'full' | 'degraded'

/**
 * One installed row. `card` is tri-state: undefined = audit pending (or the
 * batch failed, see `auditFailed`), null = not in the corpus, card = ready.
 */
interface AuditRow {
  name: string
  version: string | null
  plugin: boolean
  card: PluginCard | null | undefined
}

interface AuditState {
  form: AuditForm
  rows?: AuditRow[]
  /** In-box @deepseek-ai/* bundles in the profile (context, not audited). */
  baseline?: number
  /** Installed but disabled (not in the bundles load list) — not audited. */
  disabled?: number
  /** The profile the inventory was read from (drives uninstall commands). */
  profile?: string
  dynamics?: DynamicsDoc
  /** Running dsh version from /dsh-insights/runtime (null when unknown). */
  dshVersion?: string | null
  /** The audit batch failed after the list rendered — pending rows stay. */
  auditFailed?: boolean
  /**
   * Shell module-table pre-check (null on older hosts / unlocatable shell):
   * per-plugin client-bundle requires vs the on-disk shell's resolvable set.
   */
  compat?: ClientCompatReport | null
}

// ── per-version health-card cache (24h TTL) ──────────────────────────────────
//
// The corpus refreshes daily, so a card is reused only while the installed
// VERSION is unchanged and the entry is fresh: opening the panel paints
// instantly, upgrading a plugin or waiting a day re-audits. localStorage is
// opportunistic — private-mode/unavailable storage simply skips the cache.

const AUDIT_CACHE_PREFIX = 'dsh-insights-kit:audit:v1:'
const AUDIT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Cached card for `name@version`; undefined on miss/stale/unavailable storage. */
function auditCacheRead(name: string, version: string | null): PluginCard | null | undefined {
  if (!version) return undefined
  try {
    const raw = localStorage.getItem(AUDIT_CACHE_PREFIX + name)
    if (!raw) return undefined
    const entry = JSON.parse(raw) as { v?: unknown; at?: unknown; card?: PluginCard | null }
    if (entry.v !== version || typeof entry.at !== 'number') return undefined
    if (Date.now() - entry.at > AUDIT_CACHE_TTL_MS) return undefined
    return entry.card ?? null
  } catch {
    return undefined
  }
}

function auditCacheWrite(name: string, version: string | null, card: PluginCard | null): void {
  if (!version) return
  try {
    localStorage.setItem(AUDIT_CACHE_PREFIX + name, JSON.stringify({ v: version, at: Date.now(), card }))
  } catch {
    // storage full/blocked — caching is best-effort
  }
}

/**
 * Red「无法加载」mark for plugins whose client bundle requires modules the
 * on-disk shell cannot resolve (the 0.1.2-rc.1 crash class) — visible before
 * the restart that would otherwise fail with a console-only stack.
 */
function ShellCompatPill(props: { report: ClientCompatRow | undefined }): JSX.Element | null {
  const { report } = props
  if (!report || report.status !== 'broken') return null
  return (
    <span
      style={{ background: '#dc2626', color: '#fff', borderRadius: 4, fontSize: 11, fontWeight: 700, padding: '1px 6px' }}
      title={L(
        '当前 dsh shell 的模块表已无法解析：{mods}。升级该插件到新构建，或先卸载/禁用，否则重启后它将加载失败。',
        'The current dsh shell can no longer resolve: {mods}. Upgrade the plugin to a fresh build, or uninstall/disable it first — it will fail to load after restart.',
        { mods: report.missing.join(', ') },
      )}
    >
      {L('无法加载', 'won\u2019t load')}
    </span>
  )
}

/**
 * Quarantine action for「won't load」rows: drops the plugin from the load
 * list (files kept) so the next `dsh web` boot cannot be broken by it.
 * Renders nothing while the mutation surface is unavailable.
 */
function DisableButton(props: { pkgName: string }): JSX.Element | null {
  const { pkgName } = props
  const [canMutate, setCanMutate] = useState<boolean | null>(null)
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  useEffect(() => {
    let cancelled = false
    void mutationsAvailable().then((available) => {
      if (!cancelled) setCanMutate(available)
    })
    return () => {
      cancelled = true
    }
  }, [])
  if (canMutate !== true) return null
  if (state === 'done') {
    return <span style={{ ...mutedStyle, color: '#16a34a' }}>{L('已禁用 ✓', 'Disabled ✓')}</span>
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        style={copyButtonStyle}
        disabled={state === 'busy'}
        title={L('移出装载清单（文件保留）：重启后不再加载，随时可重新启用', 'Out of the load list (files kept): not loaded after restart, re-enable any time')}
        onClick={(event) => {
          event.stopPropagation()
          setState('busy')
          disablePlugin(pkgName)
            .then(() => {
              invalidateInstalled()
              setState('done')
            })
            .catch((error: unknown) => {
              setState('error')
              setMessage(error instanceof Error ? error.message : String(error))
            })
        }}
      >
        {state === 'busy' ? L('禁用中…', 'Disabling…') : L('禁用', 'Disable')}
      </button>
      {state === 'error' && (
        <span style={{ ...mutedStyle, color: '#dc2626' }} title={message}>{L('失败', 'Failed')}</span>
      )}
    </span>
  )
}

function AuditSection(props: { onPick: (fullName: string) => void }): JSX.Element {
  const { onPick } = props
  const [audit, setAudit] = useState<AuditState>({ form: 'loading' })
  // Bumps when a one-click install/uninstall lands elsewhere in the panel:
  // re-read the (invalidated) inventory and re-render the list.
  const epoch = useInstalledEpoch()
  // Quarantine-all (broken plugins → disable) action state.
  const [quarantine, setQuarantine] = useState<'idle' | 'busy' | 'done'>('idle')
  const [quarantineFailed, setQuarantineFailed] = useState<string[]>([])
  const [canMutate, setCanMutate] = useState(false)
  useEffect(() => {
    let cancelled = false
    void mutationsAvailable().then((available) => {
      if (!cancelled) setCanMutate(available)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // dynamics feeds both forms (breaking card + dist-tags + latest
      // release); the runtime probe reports the running dsh version. Both
      // tolerate failure so the audit list still renders. The compat probe
      // (older hosts 404 it → null) powers the「无法加载」pre-check marks.
      const [dynamics, dshVersion, inventory, compat] = await Promise.all([
        fetchDynamics()
          .then((res) => res.dynamics)
          .catch(() => undefined),
        fetchRuntime()
          .then((res) => res.dsh?.version ?? null)
          .catch(() => null),
        getInstalled(),
        fetchCompat()
          .then((res) => res.compat)
          .catch(() => null),
      ])
      if (!inventory) {
        if (!cancelled) setAudit({ form: 'degraded', dynamics, dshVersion })
        return
      }
      // List first: render the manifest rows immediately (cached cards where
      // the installed version is unchanged), then audit the rest in one
      // batch. Disabled entries (installed but out of the bundles load list)
      // are not audited — they do not load.
      const rows: AuditRow[] = inventory.plugins
        .filter((plugin: InstalledPlugin) => plugin.enabled)
        .map((plugin: InstalledPlugin) => ({
          name: plugin.name,
          version: plugin.version,
          plugin: plugin.plugin,
          card: auditCacheRead(plugin.name, plugin.version),
        }))
      if (cancelled) return
      setAudit({
        form: 'full',
        rows,
        baseline: inventory.baseline,
        disabled: inventory.plugins.length - rows.length,
        profile: inventory.profile,
        dynamics,
        dshVersion,
        compat,
      })
      const pending = rows.filter((row) => row.card === undefined)
      if (pending.length === 0) return
      try {
        const res = await fetchAudit(pending.map((row) => row.name))
        if (cancelled) return
        for (const row of pending) {
          const card = res.results[row.name] ?? null
          row.card = card
          auditCacheWrite(row.name, row.version, card)
        }
        setAudit((prev) => (prev.form === 'full' ? { ...prev, rows: [...rows] } : prev))
      } catch {
        if (!cancelled) {
          setAudit((prev) => (prev.form === 'full' ? { ...prev, rows: [...rows], auditFailed: true } : prev))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [epoch])

  if (audit.form === 'loading') return <div style={mutedStyle}>{L('正在读取已装插件清单…', 'Reading the installed-plugin list…')}</div>

  const releases = audit.dynamics?.dsh?.releases ?? []
  const distTags = audit.dynamics?.dsh?.npm?.distTags
  const latestRelease = distTags?.latest

  if (audit.form === 'degraded') {
    return (
      <div>
        <DshVersionLine version={audit.dshVersion} latest={latestRelease} />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {L('无法读取已装插件清单', 'Cannot read the installed-plugin list')}
          </div>
          <div style={mutedStyle}>
            {L(
              '本机的 /dsh-insights/installed 接口不可用（host 侧插件未加载或异常），「体检」降级为版本与兼容性提醒。以下为 dsh 官方发布动态——升级前建议在「查验」页逐个检查已装插件的健康分与维护状态。',
              'The local /dsh-insights/installed endpoint is unavailable (the host-side plugin is not loaded or errored), so Audit falls back to version & compatibility reminders. Below are the official dsh release dynamics — before upgrading, check each installed plugin\'s health and maintenance state on the Check tab.',
            )}
          </div>
        </div>
        <DistTags tags={distTags} />
        <BreakingCard releases={releases} />
        <div style={cardStyle}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{L('最近 releases', 'Recent releases')}</div>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {releases.slice(0, 5).map((rel) => (
              <li key={rel.tag} style={{ padding: '4px 0', borderTop: '1px solid var(--border, #eef1f4)' }}>
                <code style={{ fontWeight: 700 }}>{rel.name ?? rel.tag}</code>
                {rel.breaking && (
                  <span style={{ background: '#dc2626', color: '#fff', borderRadius: 4, fontSize: 11, fontWeight: 700, padding: '1px 6px', marginLeft: 6 }}>BREAKING</span>
                )}
                <span style={{ ...mutedStyle, marginLeft: 6 }}>{(rel.published_at ?? '').slice(0, 10)}</span>
                {rel.summary && <div style={{ ...mutedStyle, marginTop: 2 }}>{rel.summary}</div>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    )
  }

  const rows = audit.rows ?? []
  const listed = rows.filter((row) => !!row.card)
  const counts: Record<string, number> = {}
  for (const row of listed) {
    const grade = (row.card?.grade ?? '?').toUpperCase()
    counts[grade] = (counts[grade] ?? 0) + 1
  }
  const unlisted = rows.filter((row) => row.card === null).length
  const profile = audit.profile ?? 'web'
  const compatByName = new Map((audit.compat?.rows ?? []).map((row) => [row.name, row]))
  const brokenCompat = (audit.compat?.rows ?? []).filter((row) => row.status === 'broken')
  const shellVersion = audit.compat?.shell?.version ?? null
  // On-disk shell newer than the running one = dsh was upgraded but `dsh web`
  // not restarted yet — the exact pre-flight window this check exists for.
  const upgradePending = shellVersion !== null && !!audit.dshVersion && shellVersion !== audit.dshVersion

  return (
    <div>
      <DshVersionLine version={audit.dshVersion} latest={latestRelease} />

      {upgradePending && (
        <div style={{ ...cardStyle, borderLeft: '3px solid #ca8a04' }}>
          <div style={mutedStyle}>
            {L(
              '检测到磁盘上的 dsh 已是 {disk}（当前运行 {run}）——重启前请先看下方「无法加载」标注。',
              'The on-disk dsh is already {disk} (running {run}) — check the「won\u2019t load」marks below before restarting.',
              { disk: shellVersion, run: audit.dshVersion ?? '?' },
            )}
          </div>
        </div>
      )}

      {brokenCompat.length > 0 && (
        <div style={{ ...cardStyle, borderLeft: '3px solid #dc2626' }}>
          <div style={{ fontWeight: 600, color: '#dc2626', marginBottom: 4 }}>
            {L(
              '{n} 个插件在当前 dsh 构建下无法加载',
              '{n} plugin(s) cannot load on the current dsh build',
              { n: brokenCompat.length },
            )}
          </div>
          <div style={mutedStyle}>
            {L(
              '它们的界面包引用了 shell 模块表已移除的模块（行内红标有具体模块名）。这不是体检扣分项，是会直接加载失败的硬错误：升级插件到修复后的构建，或先卸载/禁用。',
              'Their UI bundles require modules the shell module table no longer ships (the inline red mark names them). This is not a score deduction — it is a hard load failure: upgrade to a fixed build, or uninstall/disable first.',
            )}
          </div>
          {canMutate && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                style={copyButtonStyle}
                disabled={quarantine === 'busy'}
                title={L('把上述插件全部移出装载清单（文件保留，随时可恢复），让 dsh 安全重启', 'Drop all of the above from the load list (files kept, reversible) so dsh can restart safely')}
                onClick={() => {
                  setQuarantine('busy')
                  void (async () => {
                    const failed: string[] = []
                    for (const row of brokenCompat) {
                      try {
                        await disablePlugin(row.name)
                      } catch {
                        failed.push(row.name)
                      }
                    }
                    setQuarantineFailed(failed)
                    setQuarantine('done')
                    invalidateInstalled()
                  })()
                }}
              >
                {quarantine === 'busy' ? L('隔离中…', 'Quarantining…') : L('一键隔离（全部禁用，可恢复）', 'Quarantine all (disable, reversible)')}
              </button>
              {quarantine === 'done' && (
                <span style={{ ...mutedStyle, color: quarantineFailed.length > 0 ? '#dc2626' : '#16a34a' }}>
                  {quarantineFailed.length === 0
                    ? L('已全部禁用 ✓ 现在重启 dsh web 即可安全启动', 'All disabled ✓ `dsh web` can now restart safely')
                    : L('部分失败：{names}', 'Failed: {names}', { names: quarantineFailed.join(', ') })}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {GRADE_ORDER.map((grade) => (
          <span key={grade} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <GradeBadge grade={grade} />
            <span style={mutedStyle}>× {counts[grade] ?? 0}</span>
          </span>
        ))}
        {unlisted > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <GradeBadge grade={null} />
            <span style={mutedStyle}>{L('未收录 × {n}', 'unlisted × {n}', { n: unlisted })}</span>
          </span>
        )}
      </div>

      {rows.length === 0 && (
        <div style={cardStyle}>
          <div style={mutedStyle}>
            {L(
              '未发现第三方已装插件（官方 @deepseek-ai/* 基线不计入体检）。',
              'No third-party installed plugins found (the official @deepseek-ai/* baseline is not audited).',
            )}
          </div>
        </div>
      )}

      {audit.auditFailed && (
        <div style={cardStyle}>
          <div style={mutedStyle}>
            {L(
              '健康分拉取失败（上游数据暂不可达）——下方为本地已装清单，稍后可重开面板重试。',
              'Health scores could not be fetched (upstream data unavailable) — the local installed list is shown below; reopen the panel later to retry.',
            )}
          </div>
        </div>
      )}

      <div style={cardStyle}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>
          {L('已装插件（{n}）', 'Installed plugins ({n})', { n: rows.length })}
          {typeof audit.baseline === 'number' && audit.baseline > 0 && (
            <span style={{ ...mutedStyle, fontWeight: 400, marginLeft: 8 }}>
              {L('另有 {m} 个官方基线模块（设置 → 插件里能看到）不参与体检', 'plus {m} official baseline modules (visible under Settings → Plugins), not audited', { m: audit.baseline })}
            </span>
          )}
          {typeof audit.disabled === 'number' && audit.disabled > 0 && (
            <span style={{ ...mutedStyle, fontWeight: 400, marginLeft: 8 }}>
              {L('{m} 个已禁用未列出', '{m} disabled, not listed', { m: audit.disabled })}
            </span>
          )}
        </div>
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
          {rows.map((row) => {
            const card = row.card
            if (card === undefined) {
              return (
                <li key={row.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', flexWrap: 'wrap' }}>
                  <code style={{ fontWeight: 600 }}>{row.name}</code>
                  {row.version && <span style={mutedStyle}>@{row.version}</span>}
                  <ShellCompatPill report={compatByName.get(row.name)} />
                  {compatByName.get(row.name)?.status === 'broken' && <DisableButton pkgName={row.name} />}
                  <span style={mutedStyle}>{audit.auditFailed ? L('未体检', 'not audited') : L('体检中…', 'auditing…')}</span>
                </li>
              )
            }
            if (!card) {
              return (
                <li key={row.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', flexWrap: 'wrap' }}>
                  <GradeBadge grade={null} />
                  <code style={{ fontWeight: 600 }}>{row.name}</code>
                  {row.version && <span style={mutedStyle}>@{row.version}</span>}
                  <ShellCompatPill report={compatByName.get(row.name)} />
                  {compatByName.get(row.name)?.status === 'broken' && <DisableButton pkgName={row.name} />}
                  <span style={mutedStyle}>
                    {row.plugin
                      ? L('未收录（不在权威集）', 'unlisted (not in the corpus)')
                      : L('工具依赖（非插件，不参与体检）', 'utility dependency (not a plugin, not audited)')}
                  </span>
                  <InstallActionButton pkgName={row.name} installed profile={profile} />
                </li>
              )
            }
            const [owner, repo] = card.full_name.split('/')
            const drift = card.npmLatest && card.version && card.npmLatest !== card.version
            const low = card.grade === 'C' || card.grade === 'D'
            return (
              <li key={row.name} style={{ padding: '4px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <GradeBadge grade={card.grade} />
                  <button
                    onClick={() => onPick(card.full_name)}
                    style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontWeight: 600, fontSize: 13, wordBreak: 'break-all', textAlign: 'left' }}
                    title={L('在「查验」页打开健康卡', 'Open the health card on the Check tab')}
                  >
                    {card.full_name}
                  </button>
                  {card.score !== null && <span style={mutedStyle}>{card.score}</span>}
                  {row.version && <span style={mutedStyle}>@{row.version}</span>}
                  <ShellCompatPill report={compatByName.get(row.name)} />
                  {compatByName.get(row.name)?.status === 'broken' && <DisableButton pkgName={row.name} />}
                  <Stars n={card.stars} />
                  {drift && (
                    <span style={{ background: '#ca8a04', color: '#fff', borderRadius: 4, fontSize: 11, fontWeight: 700, padding: '1px 6px' }}
                      title={L('npm latest 与仓库版本不一致，可能有新版本', 'npm latest differs from the repo version — an update may be available')}>
                      npm {card.npmLatest}
                    </span>
                  )}
                  {low && (
                    <a href={`${SITE}/p/${owner}/${repo}/`} target="_blank" rel="noreferrer" style={{ color: '#2563eb', fontSize: 12 }}>
                      {L('同类更优替代 ↗', 'better alternatives ↗')}
                    </a>
                  )}
                  <InstallActionButton pkgName={row.name} installed profile={profile} />
                </div>
                <CompatLine compat={card.compat} dshVersion={audit.dshVersion} />
              </li>
            )
          })}
        </ul>
      </div>
      <DistTags tags={distTags} />
      <BreakingCard releases={releases} />
      <div style={mutedStyle}>
        {L(
          '「卸载」按钮直接在本机 profile 执行（pnpm + 装载清单），重启 dsh web 生效；旧版 host 上退化为复制命令。',
          'The uninstall button runs against the local profile (pnpm + the load list); restart `dsh web` to take effect. On older host builds it falls back to copying the command.',
        )}
      </div>
      <div style={{ ...mutedStyle, marginTop: 4 }}>
        {L(
          '枚举来源：本机 dsh profile 清单（~/.dsh/profiles/{profile}，与 dsh plugin 安装器同源）；健康分来自 dsh-insights.com 权威集（客观启发式信号，非安全审计）；版本未变的插件 24h 内复用上次的体检结果。',
          'Enumeration source: the local dsh profile manifest (~/.dsh/profiles/{profile}, the same seam `dsh plugin` operates on); health scores from the dsh-insights.com corpus (objective heuristic signals, not a security audit); plugins whose version is unchanged reuse their last audit for 24h.',
          { profile },
        )}
      </div>
    </div>
  )
}

// ── section: 查验 Check ──────────────────────────────────────────────────────

interface CheckState {
  state: LoadState
  card?: PluginCard
  generatedAt?: string | null
  /** Same-category picks served with the card (empty/absent → no section). */
  similar?: SimilarPick[]
  notInCorpus?: boolean
  error?: unknown
}

interface SearchListState {
  state: LoadState
  query: string
  results: SearchHit[]
  total: number
  error?: unknown
}

/** One search/similar result row; clicking loads the plugin's health card. */
function SearchHitRow({ hit, onPick }: { hit: SearchHit; onPick: (fullName: string) => void }): JSX.Element {
  return (
    <li>
      <button
        onClick={() => onPick(hit.full_name)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          textAlign: 'left',
          border: 'none',
          background: 'none',
          padding: '4px 0',
          cursor: 'pointer',
          color: 'inherit',
          fontSize: 13,
        }}
        title={L('打开健康卡', 'Open the health card')}
      >
        <GradeBadge grade={hit.grade} />
        <span style={{ fontWeight: 600, wordBreak: 'break-all' }}>{hit.full_name}</span>
        <Stars n={hit.stars} />
        {hit.description && (
          <span style={{ ...mutedStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {hit.description}
          </span>
        )}
      </button>
    </li>
  )
}

function CheckSection(props: {
  query: string
  onQueryChange: (q: string) => void
  result: CheckState
  onCheck: (fullName: string) => void
}): JSX.Element {
  const { query, onQueryChange, result, onCheck } = props
  const [input, setInput] = useState(query)
  const [hint, setHint] = useState('')
  const [search, setSearch] = useState<SearchListState>({ state: 'idle', query: '', results: [], total: 0 })
  const [similar, setSimilar] = useState<SearchHit[]>([])
  // Generation counter discards stale in-flight search responses;
  // lastSearched dedupes repeat fetches of the same query.
  const searchGen = useRef(0)
  const lastSearched = useRef('')

  useEffect(() => {
    if (query) setInput(query)
  }, [query])

  function runSearch(q: string): void {
    if (lastSearched.current === q) return
    lastSearched.current = q
    const gen = ++searchGen.current
    setSearch({ state: 'loading', query: q, results: [], total: 0 })
    searchPlugins(q)
      .then((res) => {
        if (searchGen.current === gen) setSearch({ state: 'ready', query: q, results: res.results, total: res.total })
      })
      .catch((error: unknown) => {
        if (lastSearched.current === q) lastSearched.current = ''
        if (searchGen.current === gen) setSearch({ state: 'error', query: q, results: [], total: 0, error })
      })
  }

  // Debounced corpus search: bare words/phrases (no slash) search as you
  // type, 300ms after the last keystroke; slash-carrying input (owner/repo,
  // GitHub URL) keeps the exact-lookup path and never triggers a search.
  useEffect(() => {
    const classified = classifyCheckInput(input)
    if (classified.kind !== 'search') return
    const timer = setTimeout(() => runSearch(classified.query), 300)
    return () => clearTimeout(timer)
  }, [input])

  // Exact lookup missed the corpus → one automatic search by repo name,
  // rendered as「相似插件」under the notice (only when non-empty).
  useEffect(() => {
    if (!result.notInCorpus || !query.includes('/')) {
      setSimilar([])
      return
    }
    const repo = query.split('/').pop() ?? ''
    if (!repo) {
      setSimilar([])
      return
    }
    let cancelled = false
    searchPlugins(repo)
      .then((res) => {
        if (!cancelled) setSimilar(res.results)
      })
      .catch(() => {
        if (!cancelled) setSimilar([])
      })
    return () => {
      cancelled = true
    }
  }, [result.notInCorpus, query])

  function submit(): void {
    const classified = classifyCheckInput(input)
    if (classified.kind === 'exact') {
      setHint('')
      onQueryChange(classified.fullName)
      onCheck(classified.fullName)
    } else if (classified.kind === 'search') {
      setHint('')
      runSearch(classified.query)
    } else {
      setHint(L('请输入 owner/repo、GitHub 仓库 URL 或搜索关键词', 'Enter owner/repo, a GitHub repository URL, or search keywords'))
    }
  }

  function pickPlugin(fullName: string): void {
    onQueryChange(fullName)
    onCheck(fullName)
  }

  const classified = classifyCheckInput(input)
  const searchQuery = classified.kind === 'search' ? classified.query : null

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
        <input
          style={inputStyle}
          value={input}
          placeholder={L('owner/repo、GitHub URL 或关键词（如 market）', 'owner/repo, a GitHub URL, or keywords (e.g. market)')}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
        <button style={buttonStyle} onClick={submit} disabled={result.state === 'loading'}>
          {result.state === 'loading' ? L('查询中…', 'Checking…') : L('查验', 'Check')}
        </button>
      </div>
      {hint && <div style={{ ...mutedStyle, color: '#ea580c', marginBottom: 8 }}>{hint}</div>}
      <div style={{ ...mutedStyle, marginBottom: 12 }}>
        {L(
          '装插件前查一查：健康分来自 dsh-insights.com 的全量权威集（客观启发式信号，非安全审计）。',
          'Check before you install: health scores come from the dsh-insights.com authoritative corpus (objective heuristic signals, not a security audit).',
        )}
      </div>

      {searchQuery !== null ? (
        <div>
          {search.state === 'loading' && <div style={mutedStyle}>{L('搜索中…', 'Searching…')}</div>}
          {search.state === 'error' && <ErrorNote error={search.error} />}
          {search.state === 'ready' && search.query === searchQuery && (
            <div>
              <div style={{ ...mutedStyle, marginBottom: 8 }}>
                {L('搜索“{q}”· 命中 {n} 个', 'Search "{q}" · {n} hit(s)', { q: search.query, n: search.total })}
              </div>
              {search.results.length === 0 ? (
                <div style={cardStyle}>
                  <div style={mutedStyle}>{L('无匹配插件', 'No matching plugins')}</div>
                </div>
              ) : (
                <div style={cardStyle}>
                  <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                    {search.results.map((hit) => (
                      <SearchHitRow key={hit.full_name} hit={hit} onPick={pickPlugin} />
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          {result.state === 'error' && <ErrorNote error={result.error} />}

          {result.notInCorpus && (
            <div style={cardStyle}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {L('不在权威集', 'Not in the authoritative corpus')}
              </div>
              <div style={mutedStyle}>
                {L(
                  'dsh-insights.com 的权威集中没有收录该仓库——它可能不是 dsh 插件、太新尚未被增量发现收录，或未满足收录门槛。',
                  'This repository is not in the dsh-insights.com corpus — it may not be a dsh plugin, may be too new for incremental discovery, or may not meet the listing bar.',
                )}
              </div>
              {similar.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>
                    {L('相似插件', 'Similar plugins')}
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                    {similar.map((hit) => (
                      <SearchHitRow key={hit.full_name} hit={hit} onPick={pickPlugin} />
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {result.card && <HealthCard card={result.card} generatedAt={result.generatedAt} similar={result.similar} onPick={pickPlugin} />}
        </>
      )}
    </div>
  )
}

function HealthCard(props: {
  card: PluginCard
  generatedAt?: string | null
  similar?: SimilarPick[]
  onPick: (fullName: string) => void
}): JSX.Element {
  const { card, generatedAt, similar, onPick } = props
  const [owner, repo] = card.full_name.split('/')
  const pageUrl = `${SITE}/p/${owner}/${repo}/`
  const dims = Object.entries(card.dimScores)
  const drift = card.npmLatest && card.version && card.npmLatest !== card.version

  // Installed-plugin names (npm) from the local profile manifest (via the
  // host /dsh-insights/installed route), for the install/uninstall action.
  // Unavailable/failed enumeration → treat as not-installed (the plain
  // install command is shown), never an error. Re-reads when a one-click
  // mutation lands anywhere in the panel (epoch bump).
  const epoch = useInstalledEpoch()
  const [installedNames, setInstalledNames] = useState<ReadonlySet<string> | null>(null)
  useEffect(() => {
    let cancelled = false
    void installedNameSet().then((names) => {
      if (!cancelled) setInstalledNames(names)
    })
    return () => {
      cancelled = true
    }
  }, [epoch])
  const installed = card.npm !== null && installedNames?.has(card.npm) === true

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
        <GradeBadge grade={card.grade} large />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, wordBreak: 'break-all' }}>{card.full_name}</div>
          <div style={mutedStyle}>
            {card.score !== null && <span style={{ marginRight: 10 }}>{L('健康分', 'Score')} {card.score}/100</span>}
            <Stars n={card.stars} />
            {card.npm && <span style={{ marginLeft: 10 }}>{card.npm}{card.version ? `@${card.version}` : ''}</span>}
            {drift && <span style={{ marginLeft: 10, color: '#ca8a04' }}>npm latest {card.npmLatest}</span>}
          </div>
        </div>
      </div>

      {/* Install/uninstall: one-click against the local profile when the
          host reports mutations usable; the copy-command fallback otherwise. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {card.npm ? (
          <>
            {installed && <span style={installedPillStyle}>{L('已安装', 'Installed')}</span>}
            <InstallActionButton pkgName={card.npm} installed={installed} />
            <span style={mutedStyle}>
              {L('本机执行（pnpm），重启 dsh web 生效；旧版 host 上为复制命令', 'Runs locally (pnpm), restart `dsh web` to take effect; copies the command on older host builds')}
            </span>
          </>
        ) : (
          <span style={mutedStyle}>
            {L('未发布 npm，需从源码安装', 'Not published to npm — install from source')}
            {card.url && (
              <>
                {' · '}
                <a href={card.url} target="_blank" rel="noreferrer" style={{ color: '#2563eb' }}>GitHub ↗</a>
              </>
            )}
          </span>
        )}
      </div>

      {card.description && <div style={{ marginBottom: 10 }}>{card.description}</div>}

      {dims.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 10 }}>
          {dims.map(([dim, value]) => (
            <div key={dim}>
              <div style={{ display: 'flex', justifyContent: 'space-between', ...mutedStyle }}>
                <span>{DIM_LABELS[dim] ? L(DIM_LABELS[dim].zh, DIM_LABELS[dim].en) : dim}</span>
                <span>{value}</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--border, #e2e5e9)', overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(0, Math.min(100, value))}%`, height: '100%', background: value >= 90 ? '#16a34a' : value >= 60 ? '#2563eb' : '#ea580c' }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {card.drops.length > 0 ? (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{L('扣分明细', 'Deductions')}</div>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {card.drops.map((drop) => (
              <li key={drop.code} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' }}>
                <span style={{ color: SEV_COLORS[drop.sev] ?? '#64748b', fontSize: 11, fontWeight: 700, minWidth: 44, textTransform: 'uppercase' }}>
                  {drop.sev}
                </span>
                <span>{L(drop.label.zh, drop.label.en)}</span>
                <code style={{ ...mutedStyle, fontSize: 11 }}>{drop.code}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div style={{ ...mutedStyle, marginBottom: 10 }}>{L('无扣分项', 'No deductions')}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <a href={pageUrl} target="_blank" rel="noreferrer" style={{ color: '#2563eb' }}>
          {L('在 dsh-insights.com 查看完整页 ↗', 'View full page on dsh-insights.com ↗')}
        </a>
        {generatedAt && (
          <span style={mutedStyle}>
            {L('数据生成于 {at}', 'Data generated at {at}', { at: generatedAt.slice(0, 10) })}
          </span>
        )}
      </div>

      {similar && similar.length > 0 && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--border, #eef1f4)', paddingTop: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>
            {L('相似推荐', 'Similar picks')}
          </div>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {similar.map((pick) => (
              <li key={pick.full_name}>
                <button
                  onClick={() => onPick(pick.full_name)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    background: 'none',
                    padding: '4px 0',
                    cursor: 'pointer',
                    color: 'inherit',
                    fontSize: 13,
                  }}
                  title={L('加载该插件的健康卡', 'Load this plugin\'s health card')}
                >
                  <GradeBadge grade={pick.grade} />
                  <span style={{ fontWeight: 600, wordBreak: 'break-all' }}>{pick.full_name}</span>
                  {pick.score !== null && <span style={mutedStyle}>{pick.score}</span>}
                  <Stars n={pick.stars} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ── section: 场景 Scenarios ──────────────────────────────────────────────────

const EMPTY_SET: ReadonlySet<string> = new Set()

function ScenariosSection(props: {
  doc?: ScenariosDoc
  state: LoadState
  error?: unknown
  onPick: (fullName: string) => void
}): JSX.Element {
  const { doc, state, error, onPick } = props
  const [installed, setInstalled] = useState<ReadonlySet<string>>(EMPTY_SET)
  // Bumps when a one-click install/uninstall lands (possibly on another tab):
  // re-resolve the「已安装」markers from the invalidated inventory.
  const epoch = useInstalledEpoch()

  // Resolve the set of installed corpus plugins once on mount: installed npm
  // names (local profile manifest via /dsh-insights/installed) → batch audit
  // → full_names. When the read or the audit fails, rows simply render
  // without the「已安装」marker — never an error here.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const names = [...await installedNameSet()]
        if (names.length === 0) return
        const res = await fetchAudit(names)
        if (cancelled) return
        const found = new Set<string>()
        for (const name of names) {
          const card = res.results[name]
          if (card) found.add(card.full_name)
        }
        setInstalled(found)
      } catch {
        // silent degradation, see above
      }
    })()
    return () => {
      cancelled = true
    }
  }, [epoch])

  if (state === 'loading' || state === 'idle') return <div style={mutedStyle}>{L('加载场景推荐…', 'Loading scenario picks…')}</div>
  if (state === 'error') return <ErrorNote error={error} />
  const scenarios: Scenario[] = doc?.scenarios ?? []
  if (scenarios.length === 0) return <div style={mutedStyle}>{L('暂无场景数据', 'No scenario data yet')}</div>
  return (
    <div>
      <div style={{ ...mutedStyle, marginBottom: 4 }}>
        {L('按使用场景发现插件（{n} 个场景）；点任意插件跳到「查验」。', 'Discover plugins by use case ({n} scenarios); click any plugin to jump to Check.', { n: scenarios.length })}
      </div>
      <div style={{ ...mutedStyle, marginBottom: 12 }}>
        {L(
          '「安装/卸载」直接在本机 profile 执行（pnpm + 装载清单），重启 dsh web 生效；旧版 host 上退化为复制命令。',
          'Install/uninstall runs against the local profile (pnpm + the load list); restart `dsh web` to take effect. On older host builds the buttons fall back to copying the command.',
        )}
      </div>
      {scenarios.map((scenario) => (
        <div key={scenario.id} style={cardStyle}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            {L(scenario.zh ?? scenario.id, scenario.en ?? scenario.id)}
            {typeof scenario.candidates === 'number' && (
              <span style={{ ...mutedStyle, fontWeight: 400, marginLeft: 8 }}>
                {L('{n} 个候选', '{n} candidates', { n: scenario.candidates })}
              </span>
            )}
          </div>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {(scenario.plugins ?? []).map((plugin) => {
              const isInstalled = installed.has(plugin.full_name)
              return (
                <li key={plugin.full_name}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      onClick={() => onPick(plugin.full_name)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flex: 1,
                        minWidth: 0,
                        flexWrap: 'wrap',
                        textAlign: 'left',
                        border: 'none',
                        background: 'none',
                        padding: '4px 0',
                        cursor: 'pointer',
                        color: 'inherit',
                        fontSize: 13,
                      }}
                    >
                      <GradeBadge grade={plugin.grade} />
                      <span style={{ fontWeight: 600, wordBreak: 'break-all' }}>{plugin.full_name}</span>
                      {isInstalled && <span style={installedPillStyle}>{L('已安装', 'Installed')}</span>}
                      {typeof plugin.stars === 'number' && <Stars n={plugin.stars} />}
                      {plugin.reasons && plugin.reasons.length > 0 && (
                        <span style={{ ...mutedStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {plugin.reasons[0]}
                        </span>
                      )}
                    </button>
                    {plugin.pkgName && (
                      <InstallActionButton pkgName={plugin.pkgName} installed={isInstalled} />
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

// ── the panel ────────────────────────────────────────────────────────────────

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  display: 'flex',
  justifyContent: 'flex-end',
  background: 'rgba(15, 18, 26, 0.42)',
}

const drawerStyle: CSSProperties = {
  width: 640,
  maxWidth: '100vw',
  height: '100%',
  background: 'var(--bg, #ffffff)',
  color: 'var(--fg, #1f2328)',
  boxShadow: '-24px 0 64px rgba(15, 18, 26, 0.35)',
  display: 'flex',
  flexDirection: 'column',
  fontSize: 13,
}

/** The shell.overlay entry: mounted always, visible only while open. */
export function InsightsPanel(): JSX.Element | null {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onToggle = (): void => setOpen((prev) => !prev)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener(PANEL_EVENT, onToggle)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener(PANEL_EVENT, onToggle)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  if (!open) return null
  return (
    <div style={backdropStyle} onClick={() => setOpen(false)}>
      <div style={drawerStyle} onClick={(event) => event.stopPropagation()}>
        <PanelContent onClose={() => setOpen(false)} />
      </div>
    </div>
  )
}

function PanelContent(props: { onClose: () => void }): JSX.Element {
  const { onClose } = props
  const [section, setSection] = useState<Section>('audit')
  const [checkQuery, setCheckQuery] = useState('')
  const [check, setCheck] = useState<CheckState>({ state: 'idle' })
  const [scenariosDoc, setScenariosDoc] = useState<ScenariosDoc | undefined>(undefined)
  const [scenariosState, setScenariosState] = useState<LoadState>('idle')
  const [scenariosError, setScenariosError] = useState<unknown>(undefined)
  /** 顶栏中/EN 切换：写入偏好后 bump 一次，让整棵视图按新语言重渲染。 */
  const [, setLocaleTick] = useState(0)

  function runCheck(fullName: string): void {
    setCheck({ state: 'loading' })
    fetchPlugin(fullName)
      .then((res) => setCheck({ state: 'ready', card: res.plugin, generatedAt: res.generatedAt, similar: res.similar ?? [] }))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'not-in-corpus') {
          setCheck({ state: 'ready', notInCorpus: true })
        } else {
          setCheck({ state: 'error', error })
        }
      })
  }

  // Lazy-load the scenarios dataset on first visit (audit/check load inside
  // their own sections).
  useEffect(() => {
    if (section === 'scenarios' && scenariosState === 'idle') {
      setScenariosState('loading')
      fetchScenarios()
        .then((res) => {
          setScenariosDoc(res.scenarios)
          setScenariosState('ready')
        })
        .catch((error: unknown) => {
          setScenariosError(error)
          setScenariosState('error')
        })
    }
  }, [section, scenariosState])

  function jumpToCheck(fullName: string): void {
    setCheckQuery(fullName)
    setSection('check')
    runCheck(fullName)
  }

  const tabs: Array<{ id: Section; label: string }> = [
    { id: 'audit', label: L('体检', 'Audit') },
    { id: 'scenarios', label: L('场景', 'Scenarios') },
    { id: 'check', label: L('查验', 'Check') },
  ]

  let body: ReactNode
  if (section === 'audit') {
    body = <AuditSection onPick={jumpToCheck} />
  } else if (section === 'scenarios') {
    body = <ScenariosSection doc={scenariosDoc} state={scenariosState} error={scenariosError} onPick={jumpToCheck} />
  } else {
    body = <CheckSection query={checkQuery} onQueryChange={setCheckQuery} result={check} onCheck={runCheck} />
  }

  return (
    <>
      <div style={headerStyle}>
        <span style={{ fontWeight: 700 }}>DSH Insights</span>
        {tabs.map((tab) => (
          <button key={tab.id} style={subTabStyle(section === tab.id)} onClick={() => setSection(tab.id)}>
            {tab.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <a href={SITE} target="_blank" rel="noreferrer" style={{ ...mutedStyle, color: '#2563eb' }}>
          dsh-insights.com ↗
        </a>
        <button
          style={{ ...subTabStyle(false), fontSize: 11 }}
          onClick={() => {
            setLocalePreference(getLocale() === 'zh' ? 'en' : 'zh')
            setLocaleTick((tick) => tick + 1)
          }}
          title={L('Switch to English', '切换到中文')}
        >
          {getLocale() === 'zh' ? 'EN' : '中'}
        </button>
        <button style={{ ...subTabStyle(false), fontSize: 11 }} onClick={onClose} title={L('关闭 (Esc)', 'Close (Esc)')}>
          ✕
        </button>
      </div>
      <div style={bodyStyle}>{body}</div>
    </>
  )
}
