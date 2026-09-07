#!/usr/bin/env node
/**
 * dsh-insights-kit CLI (`dsh-insights-kit`).
 *
 * Currently one command, for plugin authors before publish:
 *
 *   dsh-insights-kit selfcheck <dir> [--json] [--lang zh|en]
 *
 * Scores a local plugin directory on the spot with the health-v5 rulebook
 * (src/host/selfcheck.ts — manifest/docs/repo/engineering/npm consistency,
 * plus the read-only surface scan). Text output groups deductions by rule
 * category with per-code fix guidance; `--json` prints the full report.
 *
 * Exit codes: 0 = no fail-tier deduction, 1 = at least one fail-tier
 * deduction (usable as a CI pre-publish gate), 2 = usage error or invalid
 * directory (SelfcheckError).
 *
 * The npm consistency check honors DSH_INSIGHTS_NPM_REGISTRY (tests point it
 * at a fake registry).
 *
 * @module dsh-insights-kit/cli
 */

import { SelfcheckError, runSelfcheck, type SelfcheckReport } from './host/selfcheck.ts'

type Lang = 'zh' | 'en'

/** Category display order/labels (mirrors the rule-code prefixes). */
const CATEGORY_LABELS: Record<string, { zh: string; en: string }> = {
  manifest: { zh: '清单', en: 'Manifest' },
  selfcheck: { zh: '结构', en: 'Structure' },
  docs: { zh: '文档', en: 'Docs' },
  repo: { zh: '仓库', en: 'Repo' },
  eng: { zh: '工程', en: 'Engineering' },
  npm: { zh: 'npm', en: 'npm' },
}
const CATEGORY_ORDER = ['manifest', 'selfcheck', 'docs', 'repo', 'eng', 'npm']

/** health-v5 score weights per severity (fail-tier drives exit code 1). */
const SEV_WEIGHT: Record<string, number> = { fail: 20, major: 10, warn: 5, minor: 2 }

const USAGE = `dsh-insights-kit — DSH Insights helper CLI

Usage:
  dsh-insights-kit selfcheck <dir> [--json] [--lang zh|en]

Commands:
  selfcheck <dir>   Score a local plugin directory with the health-v5
                    rulebook (read-only: nothing is modified).

Options:
  --json            Print the full report as JSON.
  --lang zh|en      Output language (default: $LANG — zh* → 中文, else English).
  -h, --help        Show this help.

Exit codes:
  0  no fail-tier deduction
  1  at least one fail-tier deduction (use as a CI pre-publish gate)
  2  usage error or invalid directory
`

function detectLang(flag: string | null): Lang {
  if (flag === 'zh' || flag === 'en') return flag
  const env = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').toLowerCase()
  return env.startsWith('zh') ? 'zh' : 'en'
}

interface CliArgs {
  dir: string
  json: boolean
  lang: string | null
}

/** Parse argv after the `selfcheck` command; throws SelfcheckError('usage'). */
function parseSelfcheckArgs(rest: string[]): CliArgs {
  const args: CliArgs = { dir: '', json: false, lang: null }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!
    if (arg === '--json') {
      args.json = true
    } else if (arg === '--lang') {
      const value = rest[++i]
      if (value !== 'zh' && value !== 'en') throw new SelfcheckError('usage', `--lang expects zh or en, got ${value ?? '(nothing)'}`)
      args.lang = value
    } else if (arg.startsWith('--lang=')) {
      const value = arg.slice('--lang='.length)
      if (value !== 'zh' && value !== 'en') throw new SelfcheckError('usage', `--lang expects zh or en, got ${value}`)
      args.lang = value
    } else if (arg.startsWith('-')) {
      throw new SelfcheckError('usage', `unknown option: ${arg}`)
    } else if (!args.dir) {
      args.dir = arg
    } else {
      throw new SelfcheckError('usage', `unexpected extra argument: ${arg}`)
    }
  }
  if (!args.dir) throw new SelfcheckError('usage', 'missing <dir> (absolute path of the plugin directory)')
  return args
}

/** Human-readable text report, deductions grouped by category. */
function printReport(report: SelfcheckReport, lang: Lang): void {
  const t = (zh: string, en: string): string => (lang === 'zh' ? zh : en)
  const out: string[] = []

  out.push(`${report.pkgName ?? t('（未声明包名）', '(no package name)')}${report.version ? `@${report.version}` : ''}`)
  out.push(t(`目录：${report.dir}`, `dir: ${report.dir}`))
  out.push(t(`得分：${report.score}/100 · 等级 ${report.grade}`, `Score: ${report.score}/100 · Grade ${report.grade}`))
  if (report.npm) {
    const npm = report.npm
    out.push(npm.error
      ? t('npm：registry 不可达（npm 规则未计分）', `npm: registry unreachable (npm rules not scored) — ${npm.error}`)
      : npm.published
        ? t(`npm：已发布 · latest ${npm.latest ?? '?'} · ${npm.versions ?? '?'} 个版本`, `npm: published · latest ${npm.latest ?? '?'} · ${npm.versions ?? '?'} releases`)
        : t('npm：未发布', 'npm: not published'))
  }
  out.push('')

  if (report.drops.length === 0) {
    out.push(t('全部通过，无扣分项', 'All checks passed — no deductions'))
  } else {
    const groups = new Map<string, SelfcheckReport['drops']>()
    for (const d of report.drops) {
      const category = d.code.split('.')[0] ?? 'misc'
      const list = groups.get(category) ?? []
      list.push(d)
      groups.set(category, list)
    }
    const ordered = [...groups.keys()].sort(
      (a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99),
    )
    const total = report.drops.reduce((acc, d) => acc + (SEV_WEIGHT[d.sev] ?? 0), 0)
    out.push(t(`扣分（共 −${total}）：`, `Deductions (−${total} total):`))
    for (const category of ordered) {
      const list = groups.get(category)!
      const weight = list.reduce((acc, d) => acc + (SEV_WEIGHT[d.sev] ?? 0), 0)
      const label = CATEGORY_LABELS[category]
      out.push(`  [${label ? t(label.zh, label.en) : category}] −${weight}`)
      for (const d of list) {
        out.push(`    ${d.sev.toUpperCase().padEnd(5)}  ${d.code} — ${t(d.label.zh, d.label.en)}`)
        if (d.fix.zh || d.fix.en) out.push(`           ${t('怎么修：', 'Fix: ')}${t(d.fix.zh, d.fix.en)}`)
      }
    }
  }

  // Advisory hints: zero weight — listed after the deductions, never scored.
  if (report.hints.length > 0) {
    out.push('')
    out.push(t('提示（不计分）：', 'Hints (not scored):'))
    for (const hint of report.hints) {
      out.push(`  ${hint.code} — ${t(hint.zh, hint.en)}`)
    }
  }
  out.push('')

  const scan = report.scan
  const danger = scan.dangerouslySetInnerHTML ? t(' · ⚠ 存在 dangerouslySetInnerHTML', ' · ⚠ dangerouslySetInnerHTML present') : ''
  out.push(t(
    `只读面扫描：源码 ${scan.srcFiles} 个 · 消毒引用 ${scan.sanitizedRefs} 个${danger}`,
    `Surface scan: ${scan.srcFiles} source files · ${scan.sanitizedRefs} with sanitization refs${danger}`,
  ))
  if (scan.totalHits === 0) {
    out.push(t('  未发现写盘 / 子进程 / HTTP 写动词', '  no fs writes / child processes / HTTP write verbs found'))
  } else {
    out.push(t(`  ${scan.totalHits} 处命中（宣称"只读"的插件需逐条解释）：`, `  ${scan.totalHits} hit(s) (plugins claiming read-only must justify each):`))
    for (const hit of scan.hits) {
      out.push(`    ${hit.file} → ${hit.kind} (${hit.match})`)
    }
    if (scan.totalHits > scan.hits.length) out.push(t(`    …等共 ${scan.totalHits} 处`, `    …${scan.totalHits} in total`))
  }

  if (report.uncovered.length > 0) {
    out.push(t(
      `本地不可判定（不计分）：${report.uncovered.map((u) => u.code).join(' · ')}`,
      `Not decidable locally (not scored): ${report.uncovered.map((u) => u.code).join(' · ')}`,
    ))
  }

  process.stdout.write(`${out.join('\n')}\n`)
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return argv.length === 0 ? 2 : 0
  }
  const [command, ...rest] = argv
  if (command !== 'selfcheck') {
    process.stderr.write(`unknown command: ${command ?? ''}\n\n${USAGE}`)
    return 2
  }
  const args = parseSelfcheckArgs(rest)
  const lang = detectLang(args.lang)
  const report = await runSelfcheck(args.dir)
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    printReport(report, lang)
  }
  return report.drops.some((d) => d.sev === 'fail') ? 1 : 0
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    if (error instanceof SelfcheckError) {
      process.stderr.write(`dsh-insights-kit: ${error.message} (${error.code})\n`)
      if (error.code === 'usage') process.stderr.write(`\n${USAGE}`)
    } else {
      process.stderr.write(`dsh-insights-kit: ${(error as Error)?.message ?? String(error)}\n`)
    }
    process.exitCode = 2
  })
