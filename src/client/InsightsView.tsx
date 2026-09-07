/**
 * dsh-insights-kit — the「生态」session view tab (browser face).
 *
 * Registers into the official `conversation.view` list slot (session scope),
 * so the session header grows a tab — 对话 | 轨迹 | 生态 (Chat | Trajectory |
 * Ecosystem) — ordered after the shipped entries. The body carries three
 * sub-sections, switched by an inner tab strip (a single scroll page was
 * considered; three focused sub-tabs mirror the host shell's own tab idiom
 * and keep each dataset's fetch lazy):
 *
 * 1. 查验 Check      — paste `owner/repo` or a GitHub URL, get the plugin's
 *    DSH Insights health card: grade badge (S/A/B/C/D), score, the four
 *    dimension bars, the deduction list, and a link out to the full page on
 *    dsh-insights.com. Unknown repos get a「不在权威集」notice.
 * 2. 场景 Scenarios  — scenario → recommended plugins (name/grade/one-liner);
 *    clicking a plugin jumps to the Check section with it loaded.
 * 3. 动态 Dynamics   — dsh official releases (breaking flagged) + platform
 *    repo activity.
 *
 * All data flows through the host `/dsh-insights` surface; the client never
 * talks to dsh-insights.com directly. Bilingual zh/en with the same toggle
 * idiom as the other kit plugins.
 *
 * @module dsh-insights-kit/insights-view
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import {
  ApiError,
  fetchDynamics,
  fetchPlugin,
  fetchScenarios,
  parseRepoInput,
  type DynamicsDoc,
  type DropSeverity,
  type PluginCard,
  type Scenario,
  type ScenariosDoc,
} from './api.ts'
import { getLocale, L, setLocalePreference } from './locale.ts'

/** Selector-shaped hooks the shell's standard kit passes to session views. */
export interface InsightsViewProps {
  sessionId?: string
  useSessions?: <T>(selector: (state: any) => T) => T
  useWorkspaces?: <T>(selector: (state: any) => T) => T
}

type Section = 'check' | 'scenarios' | 'dynamics'
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

// ── style atoms (inline, matching the host shell's plain look) ───────────────

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  fontSize: 13,
  color: 'var(--fg, #1f2328)',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
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

// ── section: 查验 Check ──────────────────────────────────────────────────────

interface CheckState {
  state: LoadState
  card?: PluginCard
  generatedAt?: string | null
  notInCorpus?: boolean
  error?: unknown
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

  useEffect(() => {
    if (query) setInput(query)
  }, [query])

  function submit(): void {
    const parsed = parseRepoInput(input)
    if (!parsed) {
      setHint(L('请输入 owner/repo 或 GitHub 仓库 URL', 'Enter owner/repo or a GitHub repository URL'))
      return
    }
    setHint('')
    onQueryChange(parsed)
    onCheck(parsed)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
        <input
          style={inputStyle}
          value={input}
          placeholder={L('owner/repo 或 https://github.com/owner/repo', 'owner/repo or https://github.com/owner/repo')}
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
        </div>
      )}

      {result.card && <HealthCard card={result.card} generatedAt={result.generatedAt} />}
    </div>
  )
}

function HealthCard({ card, generatedAt }: { card: PluginCard; generatedAt?: string | null }): JSX.Element {
  const [owner, repo] = card.full_name.split('/')
  const pageUrl = `${SITE}/p/${owner}/${repo}/`
  const dims = Object.entries(card.dimScores)
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
          </div>
        </div>
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
    </div>
  )
}

// ── section: 场景 Scenarios ──────────────────────────────────────────────────

function ScenariosSection(props: {
  doc?: ScenariosDoc
  state: LoadState
  error?: unknown
  onPick: (fullName: string) => void
}): JSX.Element {
  const { doc, state, error, onPick } = props
  if (state === 'loading' || state === 'idle') return <div style={mutedStyle}>{L('加载场景推荐…', 'Loading scenario picks…')}</div>
  if (state === 'error') return <ErrorNote error={error} />
  const scenarios: Scenario[] = doc?.scenarios ?? []
  if (scenarios.length === 0) return <div style={mutedStyle}>{L('暂无场景数据', 'No scenario data yet')}</div>
  return (
    <div>
      <div style={{ ...mutedStyle, marginBottom: 12 }}>
        {L('按使用场景发现插件（{n} 个场景）；点任意插件跳到「查验」。', 'Discover plugins by use case ({n} scenarios); click any plugin to jump to Check.', { n: scenarios.length })}
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
            {(scenario.plugins ?? []).map((plugin) => (
              <li key={plugin.full_name}>
                <button
                  onClick={() => onPick(plugin.full_name)}
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
                >
                  <GradeBadge grade={plugin.grade} />
                  <span style={{ fontWeight: 600, wordBreak: 'break-all' }}>{plugin.full_name}</span>
                  {typeof plugin.stars === 'number' && <Stars n={plugin.stars} />}
                  {plugin.reasons && plugin.reasons.length > 0 && (
                    <span style={{ ...mutedStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {plugin.reasons[0]}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

// ── section: 动态 Dynamics ───────────────────────────────────────────────────

function DynamicsSection(props: { doc?: DynamicsDoc; state: LoadState; error?: unknown }): JSX.Element {
  const { doc, state, error } = props
  if (state === 'loading' || state === 'idle') return <div style={mutedStyle}>{L('加载生态动态…', 'Loading ecosystem dynamics…')}</div>
  if (state === 'error') return <ErrorNote error={error} />
  if (!doc) return <div style={mutedStyle}>{L('暂无动态数据', 'No dynamics data yet')}</div>
  const releases = doc.dsh?.releases ?? []
  const platform = doc.platform ?? []
  return (
    <div>
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>
          {L('dsh 官方 Release', 'Official dsh releases')}
          {doc.dsh?.repo && (
            <span style={{ ...mutedStyle, fontWeight: 400, marginLeft: 8 }}>
              {doc.dsh.repo} <Stars n={doc.dsh.stars ?? 0} />
            </span>
          )}
        </div>
        {releases.length === 0 && <div style={mutedStyle}>{L('暂无 release 记录', 'No releases recorded')}</div>}
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
          {releases.map((rel) => (
            <li key={rel.tag} style={{ padding: '6px 0', borderTop: '1px solid var(--border, #eef1f4)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <code style={{ fontWeight: 700 }}>{rel.name ?? rel.tag}</code>
                {rel.breaking && (
                  <span style={{ background: '#dc2626', color: '#fff', borderRadius: 4, fontSize: 11, fontWeight: 700, padding: '1px 6px' }}>
                    BREAKING
                  </span>
                )}
                {rel.prerelease && <span style={{ ...mutedStyle, border: '1px solid var(--border, #e2e5e9)', borderRadius: 4, padding: '0 6px' }}>pre</span>}
                <span style={mutedStyle}>{(rel.published_at ?? '').slice(0, 10)}</span>
                {(typeof rel.added === 'number' || typeof rel.fixed === 'number') && (
                  <span style={mutedStyle}>+{rel.added ?? 0} / fix {rel.fixed ?? 0}</span>
                )}
              </div>
              {rel.summary && <div style={{ ...mutedStyle, marginTop: 2 }}>{rel.summary}</div>}
            </li>
          ))}
        </ul>
      </div>

      <div style={cardStyle}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>{L('平台仓库动态', 'Platform repository activity')}</div>
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
          {platform.map((repo) => (
            <li key={repo.repo} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>{repo.repo}</span>
              <Stars n={repo.stars ?? 0} />
              {repo.latestRelease ? (
                <code style={mutedStyle}>
                  {repo.latestRelease.name ?? repo.latestRelease.tag} ({(repo.latestRelease.published_at ?? '').slice(0, 10)})
                </code>
              ) : (
                <span style={mutedStyle}>{L('无 release', 'no release')}</span>
              )}
              <span style={mutedStyle}>{L('push 于 {at}', 'pushed {at}', { at: (repo.pushed_at ?? '').slice(0, 10) })}</span>
            </li>
          ))}
        </ul>
      </div>

      {doc.fetchedAt && (
        <div style={mutedStyle}>{L('动态抓取于 {at}', 'Dynamics fetched at {at}', { at: doc.fetchedAt.slice(0, 16).replace('T', ' ') })}</div>
      )}
    </div>
  )
}

// ── the view ─────────────────────────────────────────────────────────────────

export function InsightsView(_props: InsightsViewProps): JSX.Element {
  const [section, setSection] = useState<Section>('check')
  const [checkQuery, setCheckQuery] = useState('')
  const [check, setCheck] = useState<CheckState>({ state: 'idle' })
  const [scenariosDoc, setScenariosDoc] = useState<ScenariosDoc | undefined>(undefined)
  const [scenariosState, setScenariosState] = useState<LoadState>('idle')
  const [scenariosError, setScenariosError] = useState<unknown>(undefined)
  const [dynamicsDoc, setDynamicsDoc] = useState<DynamicsDoc | undefined>(undefined)
  const [dynamicsState, setDynamicsState] = useState<LoadState>('idle')
  const [dynamicsError, setDynamicsError] = useState<unknown>(undefined)
  /** 顶栏中/EN 切换：写入偏好后 bump 一次，让整棵视图按新语言重渲染。 */
  const [, setLocaleTick] = useState(0)

  function runCheck(fullName: string): void {
    setCheck({ state: 'loading' })
    fetchPlugin(fullName)
      .then((res) => setCheck({ state: 'ready', card: res.plugin, generatedAt: res.generatedAt }))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'not-in-corpus') {
          setCheck({ state: 'ready', notInCorpus: true })
        } else {
          setCheck({ state: 'error', error })
        }
      })
  }

  // Lazy-load each section's dataset on first visit.
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
    if (section === 'dynamics' && dynamicsState === 'idle') {
      setDynamicsState('loading')
      fetchDynamics()
        .then((res) => {
          setDynamicsDoc(res.dynamics)
          setDynamicsState('ready')
        })
        .catch((error: unknown) => {
          setDynamicsError(error)
          setDynamicsState('error')
        })
    }
  }, [section, scenariosState, dynamicsState])

  function pickFromScenario(fullName: string): void {
    setCheckQuery(fullName)
    setSection('check')
    runCheck(fullName)
  }

  const tabs: Array<{ id: Section; label: string }> = [
    { id: 'check', label: L('查验', 'Check') },
    { id: 'scenarios', label: L('场景', 'Scenarios') },
    { id: 'dynamics', label: L('动态', 'Dynamics') },
  ]

  let body: ReactNode
  if (section === 'check') {
    body = <CheckSection query={checkQuery} onQueryChange={setCheckQuery} result={check} onCheck={runCheck} />
  } else if (section === 'scenarios') {
    body = <ScenariosSection doc={scenariosDoc} state={scenariosState} error={scenariosError} onPick={pickFromScenario} />
  } else {
    body = <DynamicsSection doc={dynamicsDoc} state={dynamicsState} error={dynamicsError} />
  }

  return (
    <div style={pageStyle}>
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
      </div>
      <div style={bodyStyle}>{body}</div>
    </div>
  )
}
