/**
 * Standalone smoke test for the host face (no cordis runtime needed, no real
 * upstream). Boots:
 *
 *   1. a fixture server serving small insights/scenarios/dynamics JSON docs,
 *   2. a tiny node:http server that mimics the `ctx.webServer` route contract
 *      and hands matching /dsh-insights requests to the plugin's handler,
 *
 * then exercises trimming, drop enrichment, search matching/ranking/limits,
 * passthrough, cache health, the trust gate, and the upstream-failure → 502
 * path (a second apply pointed at a dead port with an empty cache).
 *
 * Run: npm run build && node scripts/smoke.mjs   (from the plugin directory)
 */

import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { installedPluginNames, npmNameOfModule } from '../src/shared/installed.ts'

// ── fixtures ─────────────────────────────────────────────────────────────────

const INSIGHTS = {
  generatedAt: '2026-09-07T00:00:00.000Z',
  ruleVersion: 'health-v5',
  plugins: [
    {
      full_name: 'aaa/dsh-alpha',
      url: 'https://github.com/aaa/dsh-alpha',
      stars: 100,
      license: 'MIT',
      topics: ['dsh-plugin'],
      pkgName: 'dsh-alpha',
      version: '1.0.0',
      npm: { published: true, latest: '1.2.0' },
      description: 'File explorer for dsh workspaces',
      health: {
        score: 88,
        grade: 'B',
        dimScores: { eng: 88, docs: 100, discover: 100, maint: 100 },
        drops: ['npm.unpublished', 'manifest.not-lib-main'],
      },
    },
    {
      full_name: 'bbb/dsh-beta',
      url: 'https://github.com/bbb/dsh-beta',
      stars: 500,
      pkgName: 'dsh-beta',
      version: '2.1.0',
      description: 'Session archive toolkit',
      health: { score: 97, grade: 'S', dimScores: { eng: 100, docs: 100, discover: 100, maint: 100 }, drops: [] },
    },
    {
      full_name: 'ccc/dsh-gamma',
      url: 'https://github.com/ccc/dsh-gamma',
      stars: 300,
      description: 'Archive your chats safely',
      health: { score: 93, grade: 'A', dimScores: { eng: 95, docs: 90, discover: 90, maint: 95 }, drops: ['docs.zh-missing'] },
    },
    {
      full_name: 'ddd/no-health',
      stars: 5,
      description: 'Fresh repo, not yet scored',
    },
  ],
}

const SCENARIOS = {
  generatedAt: '2026-09-07T00:00:00.000Z',
  scenarios: [
    {
      id: 'session-archive',
      zh: '会话归档',
      en: 'session archive',
      candidates: 2,
      plugins: [
        { full_name: 'bbb/dsh-beta', stars: 500, score: 97, grade: 'S', reasons: ['标签: archive'] },
        { full_name: 'ccc/dsh-gamma', stars: 300, score: 93, grade: 'A', reasons: ['描述/主题词命中'] },
      ],
    },
  ],
}

const DYNAMICS = {
  fetchedAt: '2026-09-07T00:00:00.000Z',
  dsh: {
    repo: 'deepseek-ai/DeepSeek-Harness',
    stars: 213472,
    releases: [
      { tag: 'dsh-v0.1.3-alpha.1', name: 'v0.1.3-alpha.1', prerelease: true, published_at: '2026-09-04T11:34:32Z', breaking: true, summary: 'x', added: 5, fixed: 10 },
    ],
  },
  platform: [{ repo: 'deepseek-ai/DeepSeek-V3', stars: 104436, latestRelease: null }],
}

// ── fixture upstream ─────────────────────────────────────────────────────────

const fixture = createServer((req, res) => {
  const name = (req.url ?? '').replace(/^\//, '')
  const docs = { 'insights.json': INSIGHTS, 'scenarios.json': SCENARIOS, 'dynamics.json': DYNAMICS }
  if (docs[name]) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(docs[name]))
  } else {
    res.writeHead(404)
    res.end('nope')
  }
})
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
const fixturePort = fixture.address().port
process.env.DSH_INSIGHTS_UPSTREAM_BASE = `http://127.0.0.1:${fixturePort}`

// ── fake npm registry (selfcheck consistency checks) ────────────────────────

const registry = createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? '').replace(/^\//, ''))
  if (name === 'good-pkg') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      'dist-tags': { latest: '1.0.0' },
      versions: { '0.9.0': {}, '1.0.0': {} },
      time: { created: '2026-08-01T00:00:00.000Z', '1.0.0': new Date().toISOString() },
    }))
  } else if (name === 'drift-pkg') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      'dist-tags': { latest: '9.9.9' },
      versions: { '9.9.9': {} },
      time: { created: '2025-01-01T00:00:00.000Z', '9.9.9': '2025-06-01T00:00:00.000Z' },
    }))
  } else {
    res.writeHead(404)
    res.end('nope')
  }
})
await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve))
process.env.DSH_INSIGHTS_NPM_REGISTRY = `http://127.0.0.1:${registry.address().port}`

// ── selfcheck fixture plugin directories ─────────────────────────────────────

const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-insights-kit-smoke-'))

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
}

const GOOD_PKG = {
  name: 'good-pkg',
  version: '1.0.0',
  description: 'A well-built dsh plugin used by the smoke fixtures',
  main: 'lib/index.js',
  license: 'MIT',
  keywords: ['dsh', 'deepseek-harness', 'cordis', 'plugin'],
  files: ['lib', 'cordis.patch.yml', 'README.md', 'README.zh-CN.md', 'LICENSE'],
  exports: { '.': { default: './lib/index.js' }, './client': { default: './lib/client.js' } },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
}
const goodDir = join(fixtureRoot, 'good-plugin')
writeTree(goodDir, {
  'package.json': JSON.stringify(GOOD_PKG, null, 2),
  'cordis.patch.yml': '- insert:\n    - id: good\n      name: good-pkg\n',
  'lib/index.js': 'export const name = "good"\n',
  'lib/client.js': 'window.__ModuleLoader__ = window.__ModuleLoader__ || {}\n',
  'README.md': `# good-pkg\n\n${'A well-documented fixture plugin. '.repeat(20)}\n`,
  'README.zh-CN.md': '# good-pkg\n\n中文文档。\n',
  LICENSE: 'MIT License\n',
  'docs/DESIGN.md': '# design\n',
  'tests/good.test.mjs': 'import test from "node:test"\ntest("ok", () => {})\n',
  '.github/workflows/ci.yml': 'name: ci\non: [push]\n',
  'src/index.ts': 'export function apply(): void {\n  element.textContent = "safe"\n}\n',
})

const badDir = join(fixtureRoot, 'bad-plugin')
writeTree(badDir, {
  'package.json': JSON.stringify({ name: 'bad-pkg', version: '0.0.1' }, null, 2),
})

const writingDir = join(fixtureRoot, 'writing-plugin')
writeTree(writingDir, {
  'package.json': JSON.stringify({ ...GOOD_PKG, name: 'writing-pkg' }, null, 2),
  'cordis.patch.yml': '- insert:\n    - id: writing\n      name: writing-pkg\n',
  'lib/index.js': 'export {}\n',
  'lib/client.js': 'export {}\n',
  'README.md': `# writing-pkg\n\n${'Docs. '.repeat(80)}\n`,
  'README.zh-CN.md': '# writing-pkg\n',
  LICENSE: 'MIT License\n',
  'docs/DESIGN.md': '# design\n',
  'tests/w.test.mjs': 'export {}\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  'src/evil.ts': [
    'import { writeFileSync } from "node:fs"',
    'import { exec } from "node:child_process"',
    'writeFileSync("/tmp/x", "y")',
    'exec("rm -rf /tmp/x")',
    'await fetch("https://example.com", { method: "POST" })',
  ].join('\n'),
})

const driftDir = join(fixtureRoot, 'drift-plugin')
writeTree(driftDir, {
  'package.json': JSON.stringify({ ...GOOD_PKG, name: 'drift-pkg', version: '1.0.0' }, null, 2),
  'cordis.patch.yml': '- insert:\n    - id: drift\n      name: drift-pkg\n',
  'lib/index.js': 'export {}\n',
  'lib/client.js': 'export {}\n',
  'README.md': `# drift-pkg\n\n${'Docs. '.repeat(80)}\n`,
  'README.zh-CN.md': '# drift-pkg\n',
  LICENSE: 'MIT License\n',
  'docs/DESIGN.md': '# design\n',
  'tests/d.test.mjs': 'export {}\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  'src/index.ts': 'export const x = 1\n',
})

// ── plugin under test (fake ctx.webServer contract) ─────────────────────────

const registered = []
const effects = []
const fakeCtx = {
  logger: () => ({ info: () => {} }),
  effect: (fn) => {
    const dispose = fn()
    effects.push(dispose)
    return dispose
  },
  webServer: {
    register(route) {
      registered.push(route)
      return () => {
        const index = registered.indexOf(route)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  },
}

apply(fakeCtx)
const route = registered[0]
if (!route || route.kind !== 'prefix' || route.path !== '/dsh-insights') {
  throw new Error('route not registered as expected')
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = [...registered].reverse().find((r) => url.pathname.startsWith(r.path))
  if (match) match.handler(req, res)
  else {
    res.writeHead(404)
    res.end('nope')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}/dsh-insights`

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  [ok] ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  [FAIL] ${name}: ${error.message}`)
  }
}

async function getJson(path, headers) {
  const res = await fetch(base + path, { headers })
  return { status: res.status, body: await res.json() }
}

console.log('dsh-insights-kit host smoke test:')

await check('plugin returns trimmed card with enriched drops', async () => {
  const { status, body } = await getJson('/plugin?full_name=aaa/dsh-alpha')
  if (status !== 200 || !body.ok) throw new Error(`status ${status}`)
  const p = body.plugin
  if (p.full_name !== 'aaa/dsh-alpha' || p.stars !== 100 || p.grade !== 'B' || p.score !== 88) {
    throw new Error('core fields wrong')
  }
  if (p.npm !== 'dsh-alpha' || p.version !== '1.0.0' || p.npmLatest !== '1.2.0' || !p.description || !p.url) throw new Error('trimmed fields wrong')
  if (p.dimScores?.eng !== 88) throw new Error('dimScores missing')
  if (!Array.isArray(p.drops) || p.drops.length !== 2) throw new Error('drops not enriched')
  const [major, minor] = p.drops
  if (major.code !== 'npm.unpublished' || major.sev !== 'major' || !major.label.zh || !major.label.en) {
    throw new Error('drop enrichment wrong (major)')
  }
  if (minor.code !== 'manifest.not-lib-main' || minor.sev !== 'minor') throw new Error('drop enrichment wrong (minor)')
  if (body.generatedAt !== INSIGHTS.generatedAt) throw new Error('generatedAt missing')
})

await check('plugin lookup is case-insensitive on full_name', async () => {
  const { status, body } = await getJson('/plugin?full_name=AAA/DSH-Alpha')
  if (status !== 200 || body.plugin?.full_name !== 'aaa/dsh-alpha') throw new Error(`status ${status}`)
})

await check('plugin without health row still trims (null grade/score)', async () => {
  const { status, body } = await getJson('/plugin?full_name=ddd/no-health')
  if (status !== 200 || body.plugin.grade !== null || body.plugin.score !== null) throw new Error(`status ${status}`)
  if (!Array.isArray(body.plugin.drops) || body.plugin.drops.length !== 0) throw new Error('drops should be empty')
})

await check('unknown plugin -> 404 not-in-corpus', async () => {
  const { status, body } = await getJson('/plugin?full_name=zzz/missing')
  if (status !== 404 || body.error?.code !== 'not-in-corpus') throw new Error(`status ${status}`)
})

await check('malformed full_name -> 400', async () => {
  const { status, body } = await getJson('/plugin?full_name=' + encodeURIComponent('not a repo'))
  if (status !== 400 || body.error?.code !== 'invalid-query') throw new Error(`status ${status}`)
})

await check('search matches description substring, ranked by stars, no dimScores/drops', async () => {
  const { status, body } = await getJson('/search?q=' + encodeURIComponent('Archive'))
  if (status !== 200 || !body.ok) throw new Error(`status ${status}`)
  const names = body.results.map((r) => r.full_name)
  if (names.join(',') !== 'bbb/dsh-beta,ccc/dsh-gamma') throw new Error(`order wrong: ${names}`)
  if (body.total !== 2) throw new Error('total wrong')
  const hit = body.results[0]
  if ('dimScores' in hit || 'drops' in hit) throw new Error('search hits must not carry dimScores/drops')
  if (hit.grade !== 'S' || hit.stars !== 500) throw new Error('hit fields wrong')
})

await check('search matches full_name case-insensitively', async () => {
  const { body } = await getJson('/search?q=GAMMA')
  if (body.results.length !== 1 || body.results[0].full_name !== 'ccc/dsh-gamma') throw new Error('full_name match failed')
})

await check('search limit honored', async () => {
  const { body } = await getJson('/search?q=dsh&limit=1')
  if (body.results.length !== 1 || body.total < 3) throw new Error(`limit not honored (got ${body.results.length}/${body.total})`)
  if (body.results[0].full_name !== 'bbb/dsh-beta') throw new Error('top hit should be highest stars')
})

await check('empty search query -> 400', async () => {
  const { status } = await getJson('/search?q=')
  if (status !== 400) throw new Error(`status ${status}`)
})

await check('audit maps known npm names to cards, unknown to null', async () => {
  const { status, body } = await getJson('/audit?npm=' + encodeURIComponent('dsh-alpha,dsh-beta,unknown-pkg'))
  if (status !== 200 || !body.ok) throw new Error(`status ${status}`)
  const alpha = body.results['dsh-alpha']
  if (!alpha || alpha.full_name !== 'aaa/dsh-alpha' || alpha.grade !== 'B') throw new Error('alpha card wrong')
  if (alpha.npmLatest !== '1.2.0' || !Array.isArray(alpha.drops)) throw new Error('alpha card shape wrong')
  const beta = body.results['dsh-beta']
  if (!beta || beta.full_name !== 'bbb/dsh-beta' || beta.grade !== 'S') throw new Error('beta card wrong')
  if (body.results['unknown-pkg'] !== null) throw new Error('unknown name must map to null')
})

await check('audit is case-insensitive on npm names', async () => {
  const { body } = await getJson('/audit?npm=DSH-Alpha')
  if (!body.results['DSH-Alpha'] || body.results['DSH-Alpha'].full_name !== 'aaa/dsh-alpha') {
    throw new Error('case-insensitive lookup failed')
  }
})

await check('audit without names -> 400', async () => {
  const { status, body } = await getJson('/audit?npm=')
  if (status !== 400 || body.error?.code !== 'invalid-query') throw new Error(`status ${status}`)
})

await check('moduleName -> npm name mapping (npm/scoped/subpath/path)', async () => {
  const cases = [
    ['dsh-file-explorer-kit', 'dsh-file-explorer-kit'],
    ['@dsh-external/dsh-super-injector', '@dsh-external/dsh-super-injector'],
    ['dsh-foo/sub/path', 'dsh-foo'],
    ['/Users/x/Code/Labs/dsh/dsh-insights-kit', 'dsh-insights-kit'],
    ['../relative/dsh-bar', 'dsh-bar'],
    ['C:\\Users\\x\\dsh-baz', 'dsh-baz'],
  ]
  for (const [input, expected] of cases) {
    const got = npmNameOfModule(input)
    if (got !== expected) throw new Error(`npmNameOfModule(${input}) = ${got}, want ${expected}`)
  }
})

await check('installedPluginNames filters official/disabled, dedupes, sorts', async () => {
  const names = installedPluginNames([
    { moduleName: '@deepseek-ai/dsh-client-runtime', enabled: true },
    { moduleName: 'dsh-file-explorer-kit', enabled: true },
    { moduleName: '/opt/local/dsh-workspace-kit', enabled: true },
    { moduleName: 'dsh-file-explorer-kit', enabled: true },
    { moduleName: 'dsh-disabled-one', enabled: false },
    { moduleName: 'aaa-first', enabled: true },
  ])
  const want = 'aaa-first,dsh-file-explorer-kit,dsh-workspace-kit'
  if (names.join(',') !== want) throw new Error(`got ${names.join(',')}, want ${want}`)
})

await check('scenarios passthrough', async () => {  const { status, body } = await getJson('/scenarios')
  if (status !== 200 || body.scenarios?.scenarios?.[0]?.id !== 'session-archive') throw new Error(`status ${status}`)
})

await check('dynamics passthrough', async () => {
  const { status, body } = await getJson('/dynamics')
  if (status !== 200 || body.dynamics?.dsh?.releases?.[0]?.breaking !== true) throw new Error(`status ${status}`)
})

await check('health reports cache ages for loaded docs', async () => {
  const { status, body } = await getJson('/health')
  if (status !== 200 || !body.ok) throw new Error(`status ${status}`)
  for (const name of ['insights', 'scenarios', 'dynamics']) {
    const entry = body.caches?.[name]
    if (!entry?.cached || typeof entry.ageMs !== 'number' || entry.ageMs < 0 || entry.stale) {
      throw new Error(`cache ${name} status wrong: ${JSON.stringify(entry)}`)
    }
  }
})

await check('selfcheck: well-built plugin scores S/100 with no drops', async () => {
  const { status, body } = await getJson('/selfcheck?dir=' + encodeURIComponent(goodDir))
  if (status !== 200 || !body.ok) throw new Error(`status ${status} ${JSON.stringify(body)}`)
  const r = body.report
  if (r.score !== 100 || r.grade !== 'S') throw new Error(`score ${r.score} grade ${r.grade}: ${JSON.stringify(r.drops)}`)
  if (r.drops.length !== 0) throw new Error(`unexpected drops: ${r.drops.map((d) => d.code)}`)
  if (r.pkgName !== 'good-pkg' || r.version !== '1.0.0') throw new Error('pkg fields wrong')
  if (r.npm?.published !== true || r.npm.latest !== '1.0.0') throw new Error('npm report wrong')
  if (r.scan.totalHits !== 0) throw new Error(`scan should be clean: ${JSON.stringify(r.scan.hits)}`)
  if (!Array.isArray(r.uncovered) || r.uncovered.length === 0) throw new Error('uncovered list missing')
})

await check('selfcheck: skeletal plugin collects the expected rule codes', async () => {
  const { status, body } = await getJson('/selfcheck?dir=' + encodeURIComponent(badDir))
  if (status !== 200) throw new Error(`status ${status}`)
  const r = body.report
  const codes = new Set(r.drops.map((d) => d.code))
  const want = [
    'docs.no-readme', 'npm.unpublished', 'selfcheck.no-bundle-patch',
    'manifest.no-client-export', 'manifest.not-lib-main', 'manifest.no-files-whitelist',
    'selfcheck.lib-missing', 'docs.zh-missing', 'docs.no-description', 'docs.no-docs-dir',
    'repo.no-license', 'selfcheck.no-keywords', 'eng.no-tests', 'eng.no-ci',
  ]
  for (const code of want) {
    if (!codes.has(code)) throw new Error(`missing drop ${code} (got ${[...codes]})`)
  }
  if (r.grade !== 'D') throw new Error(`grade ${r.grade}, want D (score ${r.score})`)
  const readme = r.drops.find((d) => d.code === 'docs.no-readme')
  if (readme.sev !== 'fail' || !readme.fix.zh) throw new Error('fail sev or fix guidance missing')
  if (r.npm?.published !== false) throw new Error('npm should be unpublished')
})

await check('selfcheck: write-surface scan flags fs/child-process/http-write', async () => {
  const { body } = await getJson('/selfcheck?dir=' + encodeURIComponent(writingDir))
  const kinds = new Set(body.report.scan.hits.map((h) => h.kind))
  for (const kind of ['文件系统写 fs-write', '子进程执行 child-process', 'HTTP 写动词 http-write']) {
    if (!kinds.has(kind)) throw new Error(`scan kind missing: ${kind} (got ${[...kinds]})`)
  }
  if (body.report.scan.totalHits < 3) throw new Error('totalHits wrong')
  if (!body.report.scan.hits[0].file.endsWith('evil.ts')) throw new Error('hit file wrong')
})

await check('selfcheck: npm drift + single-release + stale are scored', async () => {
  const { body } = await getJson('/selfcheck?dir=' + encodeURIComponent(driftDir))
  const codes = new Set(body.report.drops.map((d) => d.code))
  for (const code of ['npm.version-drift', 'npm.single-release', 'npm.release-stale']) {
    if (!codes.has(code)) throw new Error(`missing ${code} (got ${[...codes]})`)
  }
})

await check('selfcheck: relative path rejected (400)', async () => {
  const { status, body } = await getJson('/selfcheck?dir=' + encodeURIComponent('some/relative/dir'))
  if (status !== 400 || body.error?.code !== 'invalid-path') throw new Error(`status ${status}`)
})

await check('selfcheck: .. traversal rejected (400)', async () => {
  const { status, body } = await getJson('/selfcheck?dir=' + encodeURIComponent('/tmp/../etc'))
  if (status !== 400 || body.error?.code !== 'invalid-path') throw new Error(`status ${status}`)
})

await check('selfcheck: nonexistent dir -> 404', async () => {
  const { status, body } = await getJson('/selfcheck?dir=' + encodeURIComponent('/tmp/dsh-no-such-dir-xyz'))
  if (status !== 404 || body.error?.code !== 'not-a-directory') throw new Error(`status ${status}`)
})

await check('selfcheck: dir without package.json -> 400', async () => {
  const { status, body } = await getJson('/selfcheck?dir=' + encodeURIComponent(fixtureRoot))
  if (status !== 400 || body.error?.code !== 'no-package-json') throw new Error(`status ${status}`)
})

/** Raw HTTP GET with an explicit Host header (undici fetch forbids it). */
function rawGet(hostHeader, path = '/dsh-insights/health') {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host: hostHeader } },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

await check('trust gate: non-loopback Host rejected (403)', async () => {
  const status = await rawGet('evil.example.com')
  if (status !== 403) throw new Error(`status ${status}`)
})

await check('trust gate: localhost Host passes', async () => {
  const status = await rawGet(`localhost:${port}`)
  if (status !== 200) throw new Error(`status ${status}`)
})

await check('upstream failure -> 502 JSON error', async () => {
  // Second apply with an empty cache pointed at a dead port: any document
  // fetch must surface as 502, not hang or poison the first instance.
  process.env.DSH_INSIGHTS_UPSTREAM_BASE = 'http://127.0.0.1:9'
  apply(fakeCtx)
  const { status, body } = await getJson('/scenarios')
  if (status !== 502 || body.ok !== false || body.error?.code !== 'upstream') {
    throw new Error(`status ${status} body ${JSON.stringify(body)}`)
  }
})

// Unregister the broken second instance; the first (its cache warm) must be
// unaffected — failed fetches never poison a live cache.
await check('first instance cache survives second instance failure', async () => {
  const disposeSecond = effects[1]
  if (typeof disposeSecond !== 'function') throw new Error('second registration disposer missing')
  disposeSecond()
  const { status, body } = await getJson('/plugin?full_name=bbb/dsh-beta')
  if (status !== 200 || body.plugin?.grade !== 'S') throw new Error(`status ${status}`)
})

await new Promise((resolve) => server.close(resolve))
await new Promise((resolve) => fixture.close(resolve))
await new Promise((resolve) => registry.close(resolve))

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
