/**
 * Author self-check: the dsh-plugin-health CLI's --dir capability as a plain
 * library function, driven by the `dsh-insights-kit selfcheck <dir>` CLI
 * (src/cli.ts), for plugin authors before publish.
 *
 * Given a local plugin directory it:
 *
 * 1. reads the on-disk layout (package.json / cordis.patch.yml / lib/ /
 *    README(.zh-CN).md / LICENSE / docs/ / tests / .github/workflows);
 * 2. scores it on the spot with the health-v5 rule table (codes and
 *    severities mirror `src/host/drops.ts`; rules needing GitHub/git
 *    metadata — topics, activity, single-push, batch-import — are not
 *    decidable locally and are reported as `uncovered`, never guessed);
 * 3. runs the read-only-surface security scan (fs writes / child processes /
 *    HTTP write verbs / sanitization references) ported from the CLI;
 * 4. checks npm consistency (published / latest vs local version / release
 *    recency) when a package name is declared — the registry base is
 *    injectable (`DSH_INSIGHTS_NPM_REGISTRY`) so tests never hit the network;
 * 5. returns score + grade (S≥95/A≥90/B≥75/C≥60/D), deductions with
 *    per-code fix guidance, and the scan findings.
 *
 * The scan never influences the score — it is an informational surface for
 * plugins claiming to be read-only.
 *
 * @module dsh-insights-kit/selfcheck
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { DropSeverity } from './drops.ts'

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'

// ── wire shapes ──────────────────────────────────────────────────────────────

export interface SelfcheckDrop {
  code: string
  sev: DropSeverity
  label: { zh: string; en: string }
  /** Per-code fix guidance, shown under each deduction. */
  fix: { zh: string; en: string }
}

export interface ScanHit {
  file: string
  kind: string
  match: string
}

export interface ScanReport {
  srcFiles: number
  /** Files referencing a sanitization mechanism (DOMPurify / marked / …). */
  sanitizedRefs: number
  dangerouslySetInnerHTML: boolean
  hits: ScanHit[]
  /** Total hits before the list cap. */
  totalHits: number
}

export interface NpmReport {
  published: boolean
  latest?: string | null
  versions?: number
  latestTime?: string | null
  error?: string
}

export interface SelfcheckReport {
  dir: string
  pkgName: string | null
  version: string | null
  score: number
  grade: string
  drops: SelfcheckDrop[]
  /**
   * Zero-weight advisory hints (bilingual): things worth improving that are
   * NOT scored — never affect score/grade or the CLI exit code.
   */
  hints: Array<{ code: string; zh: string; en: string }>
  /** health-v5 rules that need GitHub/git metadata and cannot run locally. */
  uncovered: Array<{ code: string; reason: { zh: string; en: string } }>
  scan: ScanReport
  npm: NpmReport | null
}

export class SelfcheckError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// ── fix guidance per rule code (zh first, en mirror) ─────────────────────────

const FIX: Record<string, { zh: string; en: string }> = {
  'docs.no-readme': { zh: '补一份 README.md：插件是什么 / 功能 / 安装（npm + 手动）/ 截图 / 开发命令。', en: 'Add a README.md: what it is, features, install (npm + manual), screenshots, dev commands.' },
  'docs.tiny-readme': { zh: 'README 小于 400 字节，补齐功能说明与安装步骤。', en: 'README is under 400 bytes — flesh out features and install steps.' },
  'docs.zh-missing': { zh: '补 README.zh-CN.md（生态惯例中英双语）。', en: 'Add README.zh-CN.md (the ecosystem convention is bilingual docs).' },
  'docs.no-description': { zh: '在 package.json 写一句 description（仓库/包页面的第一展示位）。', en: 'Write a one-line description in package.json (the first thing repo/package pages show).' },
  'docs.no-docs-dir': { zh: '建 docs/ 放一份简短架构说明（如 DESIGN.md）。', en: 'Create docs/ with a short architecture note (e.g. DESIGN.md).' },
  'npm.unpublished': { zh: 'npm publish 发布包（无法一键安装是核心可用性）。', en: 'Run npm publish (one-line install is core usability).' },
  'npm.version-drift': { zh: '让仓库 version 与 npm latest 一致（发版前先 bump 再 publish）。', en: 'Align the repo version with npm latest (bump before publish).' },
  'npm.single-release': { zh: 'npm 仅 1 个版本；持续迭代发版即可消除。', en: 'Only one npm release; it clears as you keep shipping.' },
  'npm.release-stale': { zh: 'npm 最近发布超过 90 天；发一个维护版本（哪怕 patch）。', en: 'Latest npm release is over 90 days old; ship a maintenance release (even a patch).' },
  'manifest.no-client-export': { zh: '在 exports 增加 "./client" 指向 lib/client.js（web 形态插件必需；TUI/CLI 形态可忽略）。', en: 'Add exports["./client"] → lib/client.js (required for web-form plugins; TUI/CLI forms may ignore).' },
  'manifest.not-lib-main': { zh: '把 main 改为 lib/index.js（生态约定）。', en: 'Set main to lib/index.js (ecosystem convention).' },
  'manifest.no-files-whitelist': { zh: '在 package.json 加 files 白名单（lib / cordis.patch.yml / README×2 / LICENSE）。', en: 'Add a files whitelist to package.json (lib / cordis.patch.yml / README×2 / LICENSE).' },
  'eng.no-tests': { zh: '补 tests/ 或 scripts/smoke.mjs（node 内置 runner 或 smoke 风格，可在 CI 跑）。', en: 'Add tests/ or scripts/smoke.mjs (node test runner or smoke style, CI-runnable).' },
  'eng.no-ci': { zh: '补 .github/workflows（build + typecheck + smoke）。', en: 'Add .github/workflows (build + typecheck + smoke).' },
  'repo.no-license': { zh: '补 LICENSE 文件（生态惯例 MIT）并在 package.json 声明 license。', en: 'Add a LICENSE file (MIT is the ecosystem norm) and declare license in package.json.' },
  'selfcheck.no-bundle-patch': { zh: '在 package.json 声明 dsh.bundle.patch 并提交对应的 cordis.patch.yml（否则无法以 bundle 形态安装）。', en: 'Declare dsh.bundle.patch in package.json and commit the cordis.patch.yml it points to (otherwise the bundle cannot install).' },
  'selfcheck.lib-missing': { zh: '先 npm run build 产出 lib/index.js + lib/client.js（发布产物）。', en: 'Run the build first so lib/index.js + lib/client.js exist (publish artifacts).' },
  'selfcheck.no-keywords': { zh: '在 package.json 加 keywords（含 dsh / deepseek-harness / cordis / plugin），代理 GitHub topics 的可发现性。', en: 'Add keywords to package.json (dsh / deepseek-harness / cordis / plugin) — the local proxy for GitHub-topic discoverability.' },
}

/** health-v5 rules that need GitHub/git metadata — reported, never guessed. */
const UNCOVERED: SelfcheckReport['uncovered'] = [
  { code: 'repo.no-dsh-topic', reason: { zh: 'GitHub topics 需仓库元数据，本地目录不可判定', en: 'GitHub topics need repo metadata; not decidable from a local directory' } },
  { code: 'repo.sparse-topics', reason: { zh: 'GitHub topics 需仓库元数据，本地目录不可判定', en: 'GitHub topics need repo metadata; not decidable from a local directory' } },
  { code: 'activity.too-young', reason: { zh: '仓库年龄需 GitHub 创建时间', en: 'Repo age needs the GitHub creation time' } },
  { code: 'activity.dormant', reason: { zh: '活跃度需最近 push 时间', en: 'Activity needs the last push time' } },
  { code: 'maint.single-push', reason: { zh: '需 git/GitHub 的创建与 push 时间对比', en: 'Needs git/GitHub created-vs-pushed comparison' } },
  { code: 'discover.batch-import', reason: { zh: '需同账号全量仓库统计', en: 'Needs account-wide repository statistics' } },
]

function drop(code: string, sev: DropSeverity, zh: string, en: string): SelfcheckDrop {
  return { code, sev, label: { zh, en }, fix: FIX[code] ?? { zh: '', en: '' } }
}

const SEV_WEIGHT: Record<DropSeverity, number> = { fail: 20, major: 10, warn: 5, minor: 2 }

export function gradeOf(score: number): string {
  return score >= 95 ? 'S' : score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D'
}

// ── npm registry ─────────────────────────────────────────────────────────────

export interface SelfcheckOptions {
  /** Registry base override (DSH_INSIGHTS_NPM_REGISTRY; tests use a fake). */
  npmRegistry?: string
  /** Injectable for tests; defaults to global fetch with a 10s timeout. */
  fetchNpm?: (name: string) => Promise<NpmReport>
}

async function defaultFetchNpm(registryBase: string, name: string): Promise<NpmReport> {
  const url = `${registryBase.replace(/\/+$/, '')}/${name.startsWith('@') ? name.replace('/', '%2f') : name}`
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
  } catch (error) {
    return { published: false, error: `registry unreachable: ${(error as Error).message}` }
  }
  if (res.status === 404) return { published: false }
  if (!res.ok) return { published: false, error: `registry HTTP ${res.status}` }
  try {
    const doc = (await res.json()) as {
      'dist-tags'?: { latest?: string }
      versions?: Record<string, unknown>
      time?: Record<string, string>
    }
    const latest = doc['dist-tags']?.latest ?? null
    return {
      published: true,
      latest,
      versions: Object.keys(doc.versions ?? {}).length,
      latestTime: latest ? (doc.time?.[latest] ?? null) : null,
    }
  } catch {
    return { published: false, error: 'registry returned non-JSON' }
  }
}

// ── read-only surface scan (ported from dsh-plugin-health --dir) ─────────────

const WRITE_PATTERNS: Array<[RegExp, string]> = [
  [/fs\.(writeFile|appendFile|rename|unlink|rm|rmSync|copyFile|mkdir|chmod|createWriteStream)/g, '文件系统写 fs-write'],
  [/\b(writeFileSync|appendFileSync|writeFile|appendFile|rmSync|unlinkSync|mkdirSync|createWriteStream)\s*\(/g, '文件系统写 fs-write'],
  // `(?<!.)` keeps regex literals' `.exec(` calls from self-matching.
  [/(?<!\.)\bexec(Sync)?\s*\(|(?<!\.)\bspawn\(|child_process/g, '子进程执行 child-process'],
  [/(?<!\.)\b(put|post|delete|patch)\s*\(|method:\s*['"](POST|PUT|DELETE|PATCH)['"]/g, 'HTTP 写动词 http-write'],
]
const SANITIZE_RE = /DOMPurify|sanitizeHtml|escape-html|marked\.parse|textContent|setHTML/g
const DANGER_RE = /dangerouslySetInnerHTML/
const SCAN_EXTENSIONS = /\.(ts|tsx|js|mjs|jsx)$/
const SCAN_SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', 'docs'])
const SCAN_HIT_CAP = 12

export function scanSurface(dir: string): ScanReport {
  const hits: ScanHit[] = []
  let totalHits = 0
  let srcFiles = 0
  let sanitizedRefs = 0
  let dangerouslySetInnerHTML = false

  function walk(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SCAN_SKIP_DIRS.has(entry.name)) continue
      const full = join(path, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!SCAN_EXTENSIONS.test(entry.name)) continue
      let text: string
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      srcFiles += 1
      if (SANITIZE_RE.test(text)) sanitizedRefs += 1
      if (DANGER_RE.test(text)) dangerouslySetInnerHTML = true
      for (const [pattern, kind] of WRITE_PATTERNS) {
        pattern.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = pattern.exec(text)) !== null) {
          totalHits += 1
          if (hits.length < SCAN_HIT_CAP) {
            hits.push({ file: relative(dir, full), kind, match: match[0].slice(0, 48) })
          }
        }
      }
    }
  }
  walk(dir)
  return { srcFiles, sanitizedRefs, dangerouslySetInnerHTML, hits, totalHits }
}

// ── the check itself ─────────────────────────────────────────────────────────

interface PkgShape {
  name?: string
  version?: string
  description?: string
  main?: string
  license?: string
  keywords?: string[]
  files?: string[]
  engines?: Record<string, unknown>
  exports?: Record<string, unknown>
  dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
}

/** Validate the ?dir= input (absolute, no `..` segments, existing directory). */
export function resolvePluginDir(raw: string): string {
  if (!raw) throw new SelfcheckError('invalid-path', 'missing ?dir=')
  if (!isAbsolute(raw)) {
    throw new SelfcheckError('invalid-path', 'path must be absolute')
  }
  if (raw.split(/[\\/]/).includes('..')) {
    throw new SelfcheckError('invalid-path', 'path must not contain .. segments')
  }
  const dir = resolve(raw)
  let stat
  try {
    stat = statSync(dir)
  } catch {
    throw new SelfcheckError('not-a-directory', `no such directory: ${dir}`)
  }
  if (!stat.isDirectory()) throw new SelfcheckError('not-a-directory', `not a directory: ${dir}`)
  return dir
}

function hasTests(dir: string): boolean {
  for (const candidate of ['tests', 'test', '__tests__']) {
    if (existsSync(join(dir, candidate))) return true
  }
  if (existsSync(join(dir, 'scripts', 'smoke.mjs'))) return true
  try {
    return readdirSync(dir).some((name) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(name))
  } catch {
    return false
  }
}

function hasCi(dir: string): boolean {
  const workflows = join(dir, '.github', 'workflows')
  try {
    return readdirSync(workflows).some((name) => /\.ya?ml$/.test(name))
  } catch {
    return false
  }
}

function readmeBytes(dir: string): number {
  try {
    return statSync(join(dir, 'README.md')).size
  } catch {
    return -1
  }
}

export async function runSelfcheck(rawDir: string, options: SelfcheckOptions = {}): Promise<SelfcheckReport> {
  const dir = resolvePluginDir(rawDir)
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new SelfcheckError('no-package-json', `no package.json in ${dir} (not a plugin directory?)`)
  }
  let pkg: PkgShape
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PkgShape
  } catch {
    throw new SelfcheckError('bad-package-json', `package.json in ${dir} is not parseable`)
  }

  const drops: SelfcheckDrop[] = []
  const hints: SelfcheckReport['hints'] = []

  // ── manifest ──
  const patchRel = pkg.dsh?.bundle?.patch
  if (!patchRel || !existsSync(join(dir, patchRel))) {
    drops.push(drop('selfcheck.no-bundle-patch', 'major', !patchRel ? '未声明 dsh.bundle.patch' : `patch 文件缺失（${patchRel}）`, !patchRel ? 'dsh.bundle.patch not declared' : `patch file missing (${patchRel})`))
  }
  if (pkg.main !== 'lib/index.js') {
    drops.push(drop('manifest.not-lib-main', 'minor', `main 不是 lib/index.js（当前 ${String(pkg.main ?? '（无）')}）`, `main is not lib/index.js (currently ${String(pkg.main ?? '(none)')})`))
  }
  const clientExport = pkg.exports?.['./client']
  if (typeof clientExport !== 'object' && typeof clientExport !== 'string') {
    drops.push(drop('manifest.no-client-export', 'warn', 'exports["./client"] 缺失', 'exports["./client"] missing'))
  }
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    drops.push(drop('manifest.no-files-whitelist', 'minor', 'package.json 无 files 白名单', 'no files whitelist in package.json'))
  }
  if (!existsSync(join(dir, 'lib', 'index.js')) || !existsSync(join(dir, 'lib', 'client.js'))) {
    drops.push(drop('selfcheck.lib-missing', 'warn', 'lib/index.js 或 lib/client.js 缺失（未构建）', 'lib/index.js or lib/client.js missing (not built)'))
  }

  // ── zero-weight hints (advisory only — never scored) ──
  const enginesDsh = pkg.engines?.dsh
  if (typeof enginesDsh !== 'string' || enginesDsh.trim() === '') {
    hints.push({
      code: 'manifest.no-engines-dsh',
      zh: '未声明 engines.dsh——dsh 版本兼容无从判定；建议加 "engines": {"dsh": "^0.1.1"}（插件声明兼容的 dsh 版本范围；体检面板与 compat.json 会展示）。',
      en: 'engines.dsh is not declared — dsh compatibility cannot be determined; consider adding "engines": {"dsh": "^0.1.1"} (the dsh version range this plugin supports; the audit panel and compat.json display it).',
    })
  }

  // ── docs ──
  const readme = readmeBytes(dir)
  if (readme < 0) {
    drops.push(drop('docs.no-readme', 'fail', '无 README.md', 'no README.md'))
  } else if (readme < 400) {
    drops.push(drop('docs.tiny-readme', 'minor', `README 仅 ${readme} 字节（<400）`, `README is only ${readme} bytes (<400)`))
  }
  if (!existsSync(join(dir, 'README.zh-CN.md'))) {
    drops.push(drop('docs.zh-missing', 'warn', '无中文/双语文档（README.zh-CN.md）', 'no Chinese/bilingual docs (README.zh-CN.md)'))
  }
  if (typeof pkg.description !== 'string' || pkg.description.trim() === '') {
    drops.push(drop('docs.no-description', 'warn', 'package.json 无 description', 'no description in package.json'))
  }
  if (!existsSync(join(dir, 'docs'))) {
    drops.push(drop('docs.no-docs-dir', 'minor', '无 docs/ 目录', 'no docs/ directory'))
  }

  // ── repo ──
  if (!existsSync(join(dir, 'LICENSE')) && !existsSync(join(dir, 'LICENSE.md'))) {
    drops.push(drop('repo.no-license', 'warn', '无 LICENSE 文件', 'no LICENSE file'))
  }
  if (!Array.isArray(pkg.keywords) || pkg.keywords.length === 0) {
    drops.push(drop('selfcheck.no-keywords', 'minor', 'package.json 无 keywords（topics 的本地代理）', 'no keywords in package.json (local proxy for topics)'))
  }

  // ── engineering ──
  if (!hasTests(dir)) {
    drops.push(drop('eng.no-tests', 'warn', '无测试目录/测试文件/smoke 脚本', 'no test directory, test files, or smoke script'))
  }
  if (!hasCi(dir)) {
    drops.push(drop('eng.no-ci', 'minor', '无 .github/workflows', 'no .github/workflows'))
  }

  // ── npm consistency (only when a name is declared) ──
  let npm: NpmReport | null = null
  const name = typeof pkg.name === 'string' && pkg.name ? pkg.name : null
  if (name) {
    npm = options.fetchNpm
      ? await options.fetchNpm(name)
      : await defaultFetchNpm(options.npmRegistry ?? process.env.DSH_INSIGHTS_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY, name)
    if (npm.error) {
      // Registry unreachable: report but do not score npm rules on a guess.
    } else if (!npm.published) {
      drops.push(drop('npm.unpublished', 'major', '未发布到 npm（无法一键安装）', 'not published to npm (no one-line install)'))
    } else {
      if (npm.latest && pkg.version && npm.latest !== pkg.version) {
        drops.push(drop('npm.version-drift', 'warn', `npm latest ${npm.latest} ≠ 仓库 version ${pkg.version}`, `npm latest ${npm.latest} ≠ repo version ${pkg.version}`))
      }
      if ((npm.versions ?? 0) < 2) {
        drops.push(drop('npm.single-release', 'minor', 'npm 仅 1 个发布版本', 'only one npm release'))
      }
      if (npm.latestTime && Date.now() - new Date(npm.latestTime).getTime() > 90 * 86_400_000) {
        drops.push(drop('npm.release-stale', 'warn', `npm 最近发布 ${npm.latestTime.slice(0, 10)} 距今超过 90 天`, `latest npm release ${npm.latestTime.slice(0, 10)} is over 90 days old`))
      }
    }
  }

  const score = Math.max(0, 100 - drops.reduce((acc, d) => acc + SEV_WEIGHT[d.sev], 0))
  return {
    dir,
    pkgName: name,
    version: typeof pkg.version === 'string' ? pkg.version : null,
    score,
    grade: gradeOf(score),
    drops,
    hints,
    uncovered: UNCOVERED,
    scan: scanSurface(dir),
    npm,
  }
}
