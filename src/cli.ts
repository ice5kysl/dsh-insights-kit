#!/usr/bin/env node
/**
 * dsh-insights-kit CLI (`dsh-insights-kit`).
 *
 * Two commands:
 *
 *   dsh-insights-kit selfcheck <dir> [--json] [--lang zh|en]
 *   dsh-insights-kit doctor [--fix] [--profile <name>] [--json] [--lang zh|en]
 *
 * `selfcheck` scores a local plugin directory on the spot with the health-v5
 * rulebook (src/host/selfcheck.ts — manifest/docs/repo/engineering/npm
 * consistency, the read-only surface scan, and the shell seed-drift guard).
 * Text output groups deductions by rule category with per-code fix guidance;
 * `--json` prints the full report.
 *
 * `doctor` is the crash-recovery tool for the boot-failure class where a
 * plugin's client bundle requires modules the CURRENT dsh shell can no longer
 * resolve (the 0.1.2-rc.1 incident): it works fully offline against the
 * on-disk shell + profile manifest — precisely when `dsh web` itself will not
 * boot. Without flags it reports which installed plugins would fail to load;
 * `--fix` disables exactly those (out of the bundles load list, files kept,
 * re-enable any time) so dsh starts again.
 *
 * Exit codes: 0 = clean (selfcheck: no fail-tier deduction; doctor: nothing
 * broken or all fixed), 1 = problems found (selfcheck: fail-tier deduction;
 * doctor: broken plugins reported but not fixed), 2 = usage error.
 *
 * The npm consistency check honors DSH_INSIGHTS_NPM_REGISTRY; the shell seed
 * table resolution honors DSH_INSIGHTS_DSH_ROOT (tests point both at fakes).
 *
 * @module dsh-insights-kit/cli
 */

import { SelfcheckError, runSelfcheck, type SelfcheckReport } from './host/selfcheck.ts'
import { editBundles, findDependents, readBundlesShape } from './host/ops.ts'
import { checkClientCompat } from './host/shell.ts'
import { resolveProfileDir } from './host/installed.ts'

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
  dsh-insights-kit doctor [--fix] [--profile <name>] [--json] [--lang zh|en]

Commands:
  selfcheck <dir>   Score a local plugin directory with the health-v5
                    rulebook (read-only: nothing is modified).
  doctor            Check the installed plugins' client bundles against the
                    on-disk dsh shell's module table — works when dsh web
                    itself will not boot. --fix disables the broken ones
                    (load-list only; files kept, re-enable any time).

Options:
  --json            Print the full report as JSON.
  --lang zh|en      Output language (default: $LANG — zh* → 中文, else English).
  --profile <name>  dsh profile to inspect (default: web / $DSH_INSIGHTS_PROFILE).
  -h, --help        Show this help.

Exit codes:
  0  clean (selfcheck: no fail-tier deduction; doctor: nothing broken/fixed)
  1  problems found (selfcheck: fail-tier deduction; doctor: broken plugins)
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

// ── doctor: boot-failure recovery (offline) ──────────────────────────────────

interface DoctorArgs {
  fix: boolean
  json: boolean
  lang: string | null
  profile: string | null
}

function parseDoctorArgs(rest: string[]): DoctorArgs {
  const args: DoctorArgs = { fix: false, json: false, lang: null, profile: null }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!
    if (arg === '--fix') {
      args.fix = true
    } else if (arg === '--json') {
      args.json = true
    } else if (arg === '--lang') {
      const value = rest[++i]
      if (value !== 'zh' && value !== 'en') throw new SelfcheckError('usage', `--lang expects zh or en, got ${value ?? '(nothing)'}`)
      args.lang = value
    } else if (arg.startsWith('--lang=')) {
      const value = arg.slice('--lang='.length)
      if (value !== 'zh' && value !== 'en') throw new SelfcheckError('usage', `--lang expects zh or en, got ${value}`)
      args.lang = value
    } else if (arg === '--profile') {
      const value = rest[++i]
      if (!value) throw new SelfcheckError('usage', '--profile expects a profile name')
      args.profile = value
    } else if (arg.startsWith('--profile=')) {
      args.profile = arg.slice('--profile='.length)
    } else {
      throw new SelfcheckError('usage', `unknown option: ${arg}`)
    }
  }
  return args
}

/**
 * Report (and with --fix, quarantine) installed plugins whose client bundle
 * the on-disk shell can no longer resolve. Pure filesystem work — the whole
 * point is that it runs when `dsh web` will not boot.
 */
function runDoctor(args: DoctorArgs): number {
  const lang = detectLang(args.lang)
  const t = (zh: string, en: string): string => (lang === 'zh' ? zh : en)
  if (args.profile !== null) process.env.DSH_INSIGHTS_PROFILE = args.profile
  const { profile, dir } = resolveProfileDir()
  const report = checkClientCompat()
  const broken = report.rows.filter((row) => row.status === 'broken')
  const unknown = report.rows.filter((row) => row.status === 'unknown')
  const noClient = report.rows.filter((row) => row.status === 'no-client').length
  const fixed: string[] = []
  const fixFailed: string[] = []

  if (args.fix && broken.length > 0) {
    if (readBundlesShape(dir) !== 'list') {
      throw new SelfcheckError(
        'unsupported-profile',
        t(
          `profile ${profile} 没有 dsh.profile.bundles 装载清单（全量加载形态），无法单独禁用插件——请手工编辑 ${dir}/package.json 的 dependencies`,
          `profile ${profile} has no dsh.profile.bundles load list (all-dependencies-load shape); single-plugin disable is not expressible — edit ${dir}/package.json dependencies by hand`,
        ),
      )
    }
    for (const row of broken) {
      // A disabled dependency is an unloaded one: dependents would break at
      // the next boot instead. Surface them; the disable still proceeds
      // because the dependent of a broken plugin is already broken in
      // practice — but the user must see the chain.
      const dependents = findDependents(dir, row.name).filter((d) => !broken.some((b) => b.name === d))
      if (dependents.length > 0) {
        process.stderr.write(t(
          `注意：${dependents.join(', ')} 依赖 ${row.name}，禁用后它们也会受影响\n`,
          `note: ${dependents.join(', ')} depend on ${row.name}; disabling affects them too\n`,
        ))
      }
      if (editBundles(dir, row.name, 'remove')) fixed.push(row.name)
      else fixFailed.push(row.name)
    }
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      profile,
      profileDir: dir,
      shell: report.shell,
      broken: broken.map((row) => ({ name: row.name, missing: row.missing })),
      unknown: unknown.map((row) => row.name),
      noClient,
      fixed: args.fix ? fixed : undefined,
      fixFailed: args.fix ? fixFailed : undefined,
    }, null, 2)}\n`)
  } else {
    const out: string[] = []
    if (report.shell === null) {
      out.push(t(
        '未找到本机 dsh 安装树，无法校验（可用 DSH_INSIGHTS_DSH_ROOT 指向安装根）。',
        'No local dsh install tree found — cannot check (point DSH_INSIGHTS_DSH_ROOT at the install root).',
      ))
      process.stdout.write(`${out.join('\n')}\n`)
      return 0
    }
    out.push(t(
      `dsh shell：${report.shell.version ?? '未知版本'}（seed ${report.shell.seedWords.length} 个模块）· profile：${profile}`,
      `dsh shell: ${report.shell.version ?? 'unknown'} (${report.shell.seedWords.length} seed modules) · profile: ${profile}`,
    ))
    if (broken.length === 0) {
      out.push(t(
        `已检查 ${report.rows.length - noClient} 个有界面的插件：全部兼容 ✓`,
        `${report.rows.length - noClient} UI-carrying plugin(s) checked — all compatible ✓`,
      ))
    } else {
      out.push(t(
        `${broken.length} 个插件在当前 dsh 构建下无法加载（会导致 dsh web 启动失败）：`,
        `${broken.length} plugin(s) cannot load on the current dsh build (they break the dsh web boot):`,
      ))
      for (const row of broken) {
        out.push(`  ✗ ${row.name} — ${t('无法解析', 'unresolvable')}: ${row.missing.join(', ')}`)
      }
      if (args.fix) {
        for (const name of fixed) out.push(t(`  已禁用 ${name} ✓`, `  disabled ${name} ✓`))
        for (const name of fixFailed) out.push(t(`  禁用失败：${name}（请手工编辑装载清单）`, `  failed to disable: ${name} (edit the load list by hand)`))
        if (fixed.length > 0) {
          out.push(t(
            '已把上述插件移出装载清单（文件保留）。现在重启 dsh web 即可正常启动；恢复：在「生态」面板重新启用，或 dsh plugin add <name>。',
            'The above plugins are out of the load list (files kept). dsh web should boot now; re-enable any time from the「生态」panel or with dsh plugin add <name>.',
          ))
        }
      } else {
        out.push(t(
          '修复：dsh-insights-kit doctor --fix（移出装载清单、文件保留、随时可恢复）',
          'Fix: dsh-insights-kit doctor --fix (drops them from the load list; files kept, reversible)',
        ))
      }
    }
    if (unknown.length > 0) {
      out.push(t(`未能判定（界面包不可读）：${unknown.join(', ')}`, `undecidable (bundle unreadable): ${unknown.join(', ')}`))
    }
    process.stdout.write(`${out.join('\n')}\n`)
  }
  if (broken.length === 0) return 0
  return args.fix && fixFailed.length === 0 ? 0 : 1
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return argv.length === 0 ? 2 : 0
  }
  const [command, ...rest] = argv
  if (command === 'doctor') {
    return runDoctor(parseDoctorArgs(rest))
  }
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
