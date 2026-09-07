/**
 * Drop-code table for the DSH Insights health rule (health-v5, see
 * dsh-insights.com docs/SCHEMA.md §health). The upstream `insights.json`
 * carries drops as bare code strings (`"npm.unpublished"`); this table maps
 * each code to its severity and a bilingual human label so the host face can
 * return self-describing deductions and the client can render them without
 * hardcoding copy.
 *
 * Severities and their score weight: fail −20 / major −10 / warn −5 / minor −2.
 * Codes not in the table (newer rule versions upstream) fall through to
 * `enrichDrop`'s default: sev `warn`, label = the raw code.
 *
 * @module dsh-insights-plugin/drops
 */

export type DropSeverity = 'fail' | 'major' | 'warn' | 'minor'

export interface DropInfo {
  code: string
  sev: DropSeverity
  label: { zh: string; en: string }
}

const TABLE: ReadonlyArray<readonly [string, DropSeverity, string, string]> = [
  ['docs.no-readme', 'fail', '无 README', 'no README'],
  ['npm.unpublished', 'major', '未发布到 npm（无法一键安装）', 'not published to npm (no one-line install)'],
  ['maint.single-push', 'major', '一次性导入后再无维护（创建≈最后 push）', 'imported once, never maintained (created ≈ last push)'],
  ['discover.batch-import', 'warn', '疑似批量模板导入（同账号大量一次性仓库）', 'suspected batch template import'],
  ['manifest.no-client-export', 'warn', 'package.json 缺失 exports["./client"]', 'package.json misses exports["./client"]'],
  ['npm.version-drift', 'warn', 'npm latest ≠ 仓库 version（版本错配）', 'npm latest ≠ repo version (drift)'],
  ['npm.release-stale', 'warn', 'npm 最近发布距今超过 90 天', 'latest npm release older than 90 days'],
  ['docs.zh-missing', 'warn', '无中文/双语文档', 'no Chinese/bilingual docs'],
  ['docs.no-description', 'warn', '仓库无 description', 'repository has no description'],
  ['repo.no-license', 'warn', '无 LICENSE', 'no LICENSE'],
  ['repo.no-dsh-topic', 'warn', 'topics 非空但无 dsh-plugin（可发现性）', 'topics set but missing dsh-plugin (discoverability)'],
  ['activity.too-young', 'warn', '仓库创建不足 1 天', 'repository younger than 1 day'],
  ['activity.dormant', 'warn', '闲置超过 30 天', 'dormant for over 30 days'],
  ['eng.no-tests', 'warn', '无测试目录/测试文件', 'no test directory or test files'],
  ['manifest.not-lib-main', 'minor', 'main 不是 lib/index.js', 'main is not lib/index.js'],
  ['manifest.no-files-whitelist', 'minor', 'package.json 无 files 白名单', 'package.json has no files whitelist'],
  ['repo.sparse-topics', 'minor', 'topics 仅 1 个（可发现面窄）', 'only one topic (narrow discoverability)'],
  ['npm.single-release', 'minor', 'npm 仅 1 个发布版本', 'only one npm release'],
  ['eng.no-ci', 'minor', '无 .github/workflows（无 CI）', 'no .github/workflows (no CI)'],
  ['docs.no-docs-dir', 'minor', '无 docs/ 目录', 'no docs/ directory'],
  ['docs.tiny-readme', 'minor', 'README 小于 400 字节', 'README smaller than 400 bytes'],
]

const BY_CODE: ReadonlyMap<string, DropInfo> = new Map(
  TABLE.map(([code, sev, zh, en]) => [code, { code, sev, label: { zh, en } }]),
)

/** Enrich one bare drop code into a self-describing row (unknown codes pass through). */
export function enrichDrop(code: string): DropInfo {
  return BY_CODE.get(code) ?? { code, sev: 'warn', label: { zh: code, en: code } }
}

/** Enrich a list of bare drop codes (order preserved). */
export function enrichDrops(codes: readonly string[]): DropInfo[] {
  return codes.map(enrichDrop)
}
