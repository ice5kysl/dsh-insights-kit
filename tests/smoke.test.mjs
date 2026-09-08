/**
 * Standalone smoke test for the host face (no cordis runtime needed, no real
 * upstream). Boots:
 *
 *   1. a fixture server serving small insights/scenarios/dynamics/compat
 *      JSON docs,
 *   2. a fake npm registry (selfcheck npm-consistency checks),
 *   3. a tiny node:http server that mimics the `ctx.webServer` route contract
 *      and hands matching /dsh-insights requests to the plugin's handler,
 *
 * then exercises trimming, drop enrichment, search matching/ranking/limits,
 * scenarios pkgName annotation, the audit compat slice, the runtime-version
 * probe, the profile-manifest installed inventory (baseline filtering,
 * version resolution, missing-dir degradation), the mutation surface
 * (install/uninstall round-trip against a stub pnpm, header/kill-switch/
 * name-validation gates, failure rollback), passthrough, cache health,
 * the trust gate, and the upstream-failure → 502 path (a second apply
 * pointed at a dead port with an empty cache). The author self-check is
 * tested as a library (runSelfcheck from src/host/selfcheck.ts, imported via
 * node type-stripping) and as a CLI subprocess (lib/cli.js exit codes
 * 0/1/2).
 *
 * Run: npm run build && node tests/smoke.test.mjs   (from the plugin directory)
 */

import { createServer, request as httpRequest } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { installedPluginNames, npmNameOfModule } from '../src/shared/installed.ts'
import { baseVersion, isOutdated, satisfiesSimpleRange } from '../src/shared/compat.ts'
import { classifyCheckInput } from '../src/client/api.ts'
import { SelfcheckError, runSelfcheck } from '../src/host/selfcheck.ts'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))

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
    {
      // Corpus-known package whose stub-pnpm install always fails — exercises
      // the mutation failure path (500 + detail, manifest untouched).
      full_name: 'zzz/fail-pkg',
      stars: 1,
      pkgName: 'fail-pkg',
      description: 'Install always fails in the smoke fixtures',
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

const COMPAT = {
  generatedAt: '2026-09-07T00:00:00.000Z',
  officialDsh: { latest: '0.1.2-rc.1', distTags: { latest: '0.1.2-rc.1' }, versions: [] },
  plugins: [
    {
      pkgName: 'dsh-alpha',
      repo: 'aaa/dsh-alpha',
      stars: 100,
      npmLatest: '1.2.0',
      enginesDsh: '^0.1.1',
      engines: [],
      dshPeers: [
        { name: '@deepseek-ai/cordis', range: '^4.0.1' },
        { name: '@deepseek-ai/dsh-client-runtime', range: '^0.1.1-rc.2' },
        { name: '@deepseek-ai/dsh-client-ui-layout', range: '^0.1.1-rc.2' },
        { name: '@deepseek-ai/dsh-extra-peer', range: '^0.1.1' },
      ],
    },
  ],
}

// enrich.json: per-plugin score/grade/category — feeds the similar picks.
// beta and gamma tie on score (97) so the stars tiebreak is exercised.
const ENRICH = [
  { full_name: 'aaa/dsh-alpha', category: '工具 / 效率', score: 88, grade: 'B', stars: 100 },
  { full_name: 'bbb/dsh-beta', category: '工具 / 效率', score: 97, grade: 'S', stars: 500 },
  { full_name: 'ccc/dsh-gamma', category: '工具 / 效率', score: 97, grade: 'S', stars: 300 },
  { full_name: 'ddd/no-health', category: null, score: null, grade: null, stars: 5 },
]

// ── fixture upstream ─────────────────────────────────────────────────────────

const fixture = createServer((req, res) => {
  const name = (req.url ?? '').replace(/^\//, '')
  const docs = { 'insights.json': INSIGHTS, 'scenarios.json': SCENARIOS, 'dynamics.json': DYNAMICS, 'compat.json': COMPAT, 'enrich.json': ENRICH }
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
  engines: { dsh: '^0.1.1' },
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

// Fixture dsh profile for GET /dsh-insights/installed: one in-box bundle in
// deps + one bundles-only (baseline 2), two materialized plugins (dsh vs
// cordis manifest field), one declared-but-not-installed dep (version null),
// one plain utility dep (plugin: false), one disabled dep (not in the
// bundles load list), one bundles-only community row. Read per request from
// DSH_INSIGHTS_PROFILE_DIR.
const profileFixture = join(fixtureRoot, 'profile-web')
writeTree(profileFixture, {
  'package.json': JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {
      '@deepseek-ai/dsh-base': '0.1.2-rc.1',
      'dsh-alpha': '^1.0.0',
      'dsh-beta': '^2.1.0',
      'dsh-pending': '^0.1.0',
      'plain-util': '^3.0.0',
      'dsh-disabled': '^0.4.0',
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          'dsh-alpha',
          'dsh-beta',
          'dsh-pending',
          'plain-util',
          'dsh-bundle-only',
        ],
      },
    },
  }, null, 2),
  'node_modules/dsh-alpha/package.json': JSON.stringify({ name: 'dsh-alpha', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  'node_modules/dsh-beta/package.json': JSON.stringify({ name: 'dsh-beta', version: '2.1.0', cordis: {} }),
  'node_modules/plain-util/package.json': JSON.stringify({ name: 'plain-util', version: '3.2.1' }),
})
process.env.DSH_INSIGHTS_PROFILE_DIR = profileFixture

// Stub pnpm for the mutation routes: `--version` probes ok; `add`/`remove`
// edit the CWD profile manifest's dependencies; `fail-pkg` simulates a
// registry failure. Pointed to via DSH_INSIGHTS_PNPM (set before any /health
// call so the memoized capability probe uses it).
const mutateFixture = join(fixtureRoot, 'profile-mutate')
writeTree(mutateFixture, {
  'package.json': JSON.stringify({
    name: 'dsh-profile-mutate',
    dependencies: { '@deepseek-ai/dsh-base': '0.1.2-rc.1' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2),
})
writeTree(fixtureRoot, {
  'pnpm-stub.sh': '#!/usr/bin/env bash\nexec node "$(dirname "$0")/pnpm-stub.mjs" "$@"\n',
  'pnpm-stub.mjs': [
    'import { readFileSync, writeFileSync } from "node:fs"',
    'import { join } from "node:path"',
    'const args = process.argv.slice(2)',
    'if (args[0] === "--version") { console.log("10.34.5-stub"); process.exit(0) }',
    'const [cmd, name] = args',
    'const file = join(process.cwd(), "package.json")',
    'const manifest = JSON.parse(readFileSync(file, "utf8"))',
    'manifest.dependencies ??= {}',
    'if (cmd === "add") {',
    '  if (name === "fail-pkg") { console.error("stub: simulated registry 404"); process.exit(1) }',
    '  manifest.dependencies[name] = "^9.9.9-stub"',
    '} else if (cmd === "remove") {',
    '  delete manifest.dependencies[name]',
    '} else { console.error("stub: unknown cmd"); process.exit(2) }',
    'writeFileSync(file, JSON.stringify(manifest, null, 2) + "\\n")',
    'console.log(`stub pnpm ${cmd} ${name} ok`)',
  ].join('\n'),
})
chmodSync(join(fixtureRoot, 'pnpm-stub.sh'), 0o755)
process.env.DSH_INSIGHTS_PNPM = join(fixtureRoot, 'pnpm-stub.sh')

// Identical to good-plugin but without engines.dsh — isolates the zero-weight
// hint: the score must stay 100/S and the CLI exit code 0.
const { engines: _omitEngines, ...GOOD_NO_ENGINES } = GOOD_PKG
const hintDir = join(fixtureRoot, 'hint-plugin')
writeTree(hintDir, {
  'package.json': JSON.stringify(GOOD_NO_ENGINES, null, 2),
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

await check('plugin carries pkgName (npm field) + same-category similar picks', async () => {
  const { status, body } = await getJson('/plugin?full_name=aaa/dsh-alpha')
  if (status !== 200 || !body.ok) throw new Error(`status ${status}`)
  if (body.plugin.npm !== 'dsh-alpha') throw new Error(`pkgName passthrough wrong: ${body.plugin.npm}`)
  const similar = body.similar
  if (!Array.isArray(similar)) throw new Error('similar missing')
  // Same category, self excluded, score desc with the stars tiebreak
  // (beta ★500 and gamma ★300 both score 97).
  if (similar.map((p) => p.full_name).join(',') !== 'bbb/dsh-beta,ccc/dsh-gamma') {
    throw new Error(`similar order wrong: ${JSON.stringify(similar)}`)
  }
  const first = similar[0]
  if (first.grade !== 'S' || first.score !== 97 || first.stars !== 500) throw new Error('similar row shape wrong')
  if (similar.some((p) => p.full_name === 'aaa/dsh-alpha')) throw new Error('self must be excluded')
})

await check('plugin without a category gets an empty similar list', async () => {
  const { status, body } = await getJson('/plugin?full_name=ddd/no-health')
  if (status !== 200) throw new Error(`status ${status}`)
  if (!Array.isArray(body.similar) || body.similar.length !== 0) {
    throw new Error(`similar must be []: ${JSON.stringify(body.similar)}`)
  }
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

await check('classifyCheckInput: slash/URL → exact, bare word → search, junk → invalid', async () => {
  const cases = [
    // [input, kind, payload]
    ['aaa/dsh-alpha', 'exact', 'aaa/dsh-alpha'],
    ['  aaa/dsh-alpha  ', 'exact', 'aaa/dsh-alpha'],
    ['https://github.com/aaa/dsh-alpha', 'exact', 'aaa/dsh-alpha'],
    ['github.com/aaa/dsh-alpha.git', 'exact', 'aaa/dsh-alpha'],
    ['market', 'search', 'market'],
    ['session archive', 'search', 'session archive'],
    ['foo/bar/baz', 'invalid', undefined],
    ['https://gitlab.com/aaa/dsh-alpha', 'invalid', undefined],
    ['', 'invalid', undefined],
    ['   ', 'invalid', undefined],
  ]
  for (const [input, kind, payload] of cases) {
    const got = classifyCheckInput(input)
    if (got.kind !== kind) throw new Error(`classifyCheckInput(${JSON.stringify(input)}).kind = ${got.kind}, want ${kind}`)
    if (kind === 'exact' && got.fullName !== payload) throw new Error(`exact payload wrong for ${input}: ${got.fullName}`)
    if (kind === 'search' && got.query !== payload) throw new Error(`search payload wrong for ${input}: ${got.query}`)
  }
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

await check('audit attaches the compat slice (engines.dsh + ≤3 peers), null when unprobed', async () => {
  const { status, body } = await getJson('/audit?npm=' + encodeURIComponent('dsh-alpha,dsh-beta,unknown-pkg'))
  if (status !== 200 || !body.ok) throw new Error(`status ${status}`)
  const alpha = body.results['dsh-alpha']
  if (!alpha?.compat) throw new Error('alpha compat missing')
  if (alpha.compat.enginesDsh !== '^0.1.1') throw new Error(`alpha enginesDsh wrong: ${JSON.stringify(alpha.compat)}`)
  if (!Array.isArray(alpha.compat.dshPeers) || alpha.compat.dshPeers.length !== 3) {
    throw new Error(`dshPeers must be capped at 3: ${JSON.stringify(alpha.compat.dshPeers)}`)
  }
  if (alpha.compat.dshPeers[0].name !== '@deepseek-ai/cordis' || alpha.compat.dshPeers[0].range !== '^4.0.1') {
    throw new Error('peer shape wrong')
  }
  const beta = body.results['dsh-beta']
  if (!beta || beta.compat !== null) throw new Error('unprobed plugin must carry compat: null')
  if (body.results['unknown-pkg'] !== null) throw new Error('unknown name must still map to null')
})

await check('runtime reports the running dsh version shape (null when unresolvable)', async () => {
  const { status, body } = await getJson('/runtime')
  if (status !== 200 || body.ok !== true) throw new Error(`status ${status}`)
  if (!('dsh' in body) || typeof body.dsh !== 'object') throw new Error(`missing dsh: ${JSON.stringify(body)}`)
  const version = body.dsh.version
  // In this dev checkout @deepseek-ai/dsh-web-app / dsh-base are not
  // installed, so resolution must fail cleanly to null; inside a real dsh
  // profile it is a version string. Accept both, assert the shape.
  if (version !== null && typeof version !== 'string') throw new Error(`version wrong: ${JSON.stringify(version)}`)
})

await check('installed reads the profile manifest (baseline filtered, versions resolved, sorted)', async () => {
  const { status, body } = await getJson('/installed')
  if (status !== 200 || body.ok !== true) throw new Error(`status ${status}`)
  if (body.profile !== 'web') throw new Error(`profile wrong: ${body.profile}`)
  if (body.baseline !== 2) throw new Error(`baseline wrong: ${body.baseline}`)
  const rows = body.plugins
  if (!Array.isArray(rows) || rows.length !== 6) throw new Error(`rows wrong: ${JSON.stringify(rows)}`)
  const names = rows.map((r) => r.name).join(',')
  if (names !== 'dsh-alpha,dsh-beta,dsh-bundle-only,dsh-disabled,dsh-pending,plain-util') {
    throw new Error(`rows not sorted/filtered right: ${names}`)
  }
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
  const alpha = byName['dsh-alpha']
  if (alpha.version !== '1.0.0' || alpha.plugin !== true || alpha.spec !== '^1.0.0' || alpha.enabled !== true) {
    throw new Error(`alpha row wrong: ${JSON.stringify(alpha)}`)
  }
  const beta = byName['dsh-beta']
  if (beta.version !== '2.1.0' || beta.plugin !== true || beta.enabled !== true) throw new Error(`beta row wrong: ${JSON.stringify(beta)}`)
  const pending = byName['dsh-pending']
  if (pending.version !== null || pending.plugin !== false || pending.enabled !== true) throw new Error(`pending row wrong: ${JSON.stringify(pending)}`)
  const util = byName['plain-util']
  if (util.version !== '3.2.1' || util.plugin !== false || util.enabled !== true) throw new Error(`util row wrong: ${JSON.stringify(util)}`)
  const bundleOnly = byName['dsh-bundle-only']
  if (bundleOnly.spec !== '' || bundleOnly.enabled !== true) throw new Error(`bundle-only row wrong: ${JSON.stringify(bundleOnly)}`)
  const disabled = byName['dsh-disabled']
  if (disabled.enabled !== false) throw new Error(`disabled row wrong: ${JSON.stringify(disabled)}`)
})

await check('installed degrades to an empty inventory when the profile dir is missing', async () => {
  const saved = process.env.DSH_INSIGHTS_PROFILE_DIR
  process.env.DSH_INSIGHTS_PROFILE_DIR = join(fixtureRoot, 'no-such-profile')
  try {
    const { status, body } = await getJson('/installed')
    if (status !== 200 || body.ok !== true) throw new Error(`status ${status}`)
    if (body.baseline !== 0 || !Array.isArray(body.plugins) || body.plugins.length !== 0) {
      throw new Error(`empty inventory expected: ${JSON.stringify(body)}`)
    }
  } finally {
    process.env.DSH_INSIGHTS_PROFILE_DIR = saved
  }
})

// ── mutations: POST install/uninstall against the mutate fixture profile ────

async function postJson(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const MUTATE_HEADERS = { 'x-dsh-insights-kit': 'mutate' }
const readManifest = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

await check('mutation: GET on install path -> 405', async () => {
  const { status } = await getJson('/install')
  if (status !== 405) throw new Error(`status ${status}`)
})

await check('mutation: POST without the custom header -> 403', async () => {
  const { status, body } = await postJson('/install', { name: 'dsh-alpha' })
  if (status !== 403 || body.error?.code !== 'mutation-header-required') throw new Error(`status ${status} ${JSON.stringify(body)}`)
})

await check('mutation: malformed/official names -> 400 invalid-name', async () => {
  for (const name of ['--help', '; rm -rf /', 'not a name', '@deepseek-ai/dsh-base', '']) {
    const { status, body } = await postJson('/install', { name }, MUTATE_HEADERS)
    if (status !== 400 || body.error?.code !== 'invalid-name') throw new Error(`${JSON.stringify(name)}: status ${status}`)
  }
})

await check('mutation: install name not in the corpus -> 400 not-in-corpus', async () => {
  const { status, body } = await postJson('/install', { name: 'unknown-pkg' }, MUTATE_HEADERS)
  if (status !== 400 || body.error?.code !== 'not-in-corpus') throw new Error(`status ${status} ${JSON.stringify(body)}`)
})

await check('mutation: full install → already-installed → uninstall → not-installed round-trip', async () => {
  const saved = process.env.DSH_INSIGHTS_PROFILE_DIR
  process.env.DSH_INSIGHTS_PROFILE_DIR = mutateFixture
  try {
    // install a corpus plugin package (dsh-alpha): deps + bundles both gain it
    const add = await postJson('/install', { name: 'dsh-alpha' }, MUTATE_HEADERS)
    if (add.status !== 200 || add.body.ok !== true || add.body.restartRequired !== true) {
      throw new Error(`install: ${add.status} ${JSON.stringify(add.body)}`)
    }
    let manifest = readManifest(mutateFixture)
    if (!manifest.dependencies['dsh-alpha']) throw new Error('deps not updated')
    if (!manifest.dsh.profile.bundles.includes('dsh-alpha')) throw new Error('bundles not updated')
    // baseline manifest fields untouched
    if (manifest.dsh.profile.bundles.filter((b) => b.startsWith('@deepseek-ai/')).length !== 2) {
      throw new Error('baseline bundles clobbered')
    }
    // second install is a noop
    const again = await postJson('/install', { name: 'dsh-alpha' }, MUTATE_HEADERS)
    if (again.status !== 200 || again.body.note !== 'already-installed') throw new Error(`reinstall: ${JSON.stringify(again.body)}`)
    // uninstall: bundles + deps both drop it
    const remove = await postJson('/uninstall', { name: 'dsh-alpha' }, MUTATE_HEADERS)
    if (remove.status !== 200 || remove.body.ok !== true) throw new Error(`uninstall: ${JSON.stringify(remove.body)}`)
    manifest = readManifest(mutateFixture)
    if ('dsh-alpha' in manifest.dependencies) throw new Error('deps still carry dsh-alpha')
    if (manifest.dsh.profile.bundles.includes('dsh-alpha')) throw new Error('bundles still carry dsh-alpha')
    // uninstalling again -> 404 not-installed
    const gone = await postJson('/uninstall', { name: 'dsh-alpha' }, MUTATE_HEADERS)
    if (gone.status !== 404 || gone.body.error?.code !== 'not-installed') throw new Error(`gone: ${gone.status} ${JSON.stringify(gone.body)}`)
  } finally {
    process.env.DSH_INSIGHTS_PROFILE_DIR = saved
  }
})

await check('mutation: pnpm failure -> 500 with detail, manifest untouched', async () => {
  const saved = process.env.DSH_INSIGHTS_PROFILE_DIR
  process.env.DSH_INSIGHTS_PROFILE_DIR = mutateFixture
  try {
    const before = readManifest(mutateFixture)
    const res = await postJson('/install', { name: 'fail-pkg' }, MUTATE_HEADERS)
    if (res.status !== 500 || res.body.ok !== false || res.body.status !== 'failed') {
      throw new Error(`expected 500 failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
    if (!res.body.detail || !res.body.detail.includes('simulated registry 404')) {
      throw new Error(`pnpm output tail missing: ${JSON.stringify(res.body)}`)
    }
    const after = readManifest(mutateFixture)
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('manifest mutated on failed install')
  } finally {
    process.env.DSH_INSIGHTS_PROFILE_DIR = saved
  }
})

await check('mutation: kill switch DSH_INSIGHTS_NO_MUTATE -> 403', async () => {
  const saved = process.env.DSH_INSIGHTS_NO_MUTATE
  process.env.DSH_INSIGHTS_NO_MUTATE = '1'
  try {
    const { status, body } = await postJson('/uninstall', { name: 'dsh-alpha' }, MUTATE_HEADERS)
    if (status !== 403 || body.error?.code !== 'mutations-disabled') throw new Error(`status ${status} ${JSON.stringify(body)}`)
  } finally {
    if (saved === undefined) delete process.env.DSH_INSIGHTS_NO_MUTATE
    else process.env.DSH_INSIGHTS_NO_MUTATE = saved
  }
})

await check('health reports mutations: true (stub pnpm probed)', async () => {
  const { body } = await getJson('/health')
  if (body.mutations !== true) throw new Error(`mutations flag wrong: ${JSON.stringify(body.mutations)}`)
})

await check('moduleName -> npm name mapping (npm/scoped/subpath/path)', async () => {
  const cases = [
    ['dsh-file-explorer-kit', 'dsh-file-explorer-kit'],
    ['@dsh-external/dsh-super-injector', '@dsh-external/dsh-super-injector'],
    ['dsh-foo/sub/path', 'dsh-foo'],
    ['/Users/x/Code/Labs/dsh/dsh-insights-kit', 'dsh-insights-kit'],
    ['../relative/dsh-bar', 'dsh-bar'],
    ['C:\\Users\\x\\dsh-baz', 'dsh-baz'],
    ['link:../local/dsh-linked', 'dsh-linked'],
    ['link:/opt/local/dsh-linked2', 'dsh-linked2'],
  ]
  for (const [input, expected] of cases) {
    const got = npmNameOfModule(input)
    if (got !== expected) throw new Error(`npmNameOfModule(${input}) = ${got}, want ${expected}`)
  }
})

await check('installedPluginNames filters official/disabled/pseudo entries, dedupes, sorts', async () => {
  const names = installedPluginNames([
    { moduleName: '@deepseek-ai/dsh-client-runtime', enabled: true },
    { moduleName: 'dsh-file-explorer-kit', enabled: true },
    { moduleName: '/opt/local/dsh-workspace-kit', enabled: true },
    { moduleName: 'dsh-file-explorer-kit', enabled: true },
    { moduleName: 'dsh-disabled-one', enabled: false },
    { moduleName: 'aaa-first', enabled: true },
    // Loader-internal pseudo entries must not leak into the audit batch:
    { moduleName: 'cordis:include', enabled: true },
    { moduleName: 'cordis:loader-internal', enabled: true },
    { moduleName: 'not a package name', enabled: true },
    // link: local installs keep working (basename-ized):
    { moduleName: 'link:../local/dsh-linked', enabled: true },
  ])
  const want = 'aaa-first,dsh-file-explorer-kit,dsh-linked,dsh-workspace-kit'
  if (names.join(',') !== want) throw new Error(`got ${names.join(',')}, want ${want}`)
})

await check('shared/compat: base version + simple ^/~ range satisfaction', async () => {
  if (baseVersion('0.1.1-rc.2')?.join('.') !== '0.1.1') throw new Error('prerelease base wrong')
  if (baseVersion('not.a.version') !== null) throw new Error('unparseable must be null')
  const cases = [
    ['0.1.1-rc.2', '^0.1.1', true],
    ['0.1.2-rc.1', '^0.1.1', true],
    ['0.2.0', '^0.1.1', false],
    ['0.1.0', '^0.1.1', false],
    ['1.4.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.1.5', '~0.1.2', true],
    ['0.2.0', '~0.1.2', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
  ]
  for (const [version, range, expected] of cases) {
    const got = satisfiesSimpleRange(version, range)
    if (got !== expected) throw new Error(`satisfiesSimpleRange(${version}, ${range}) = ${got}, want ${expected}`)
  }
  for (const undecidable of ['>=0.1.0', '0.1.x', '^0.1 || ^0.2', '*']) {
    if (satisfiesSimpleRange('0.1.1', undecidable) !== null) throw new Error(`${undecidable} must be undecidable`)
  }
  if (isOutdated('0.1.1-rc.2', '0.1.2-rc.1') !== true) throw new Error('outdated check wrong')
  if (isOutdated('0.1.2', '0.1.2-rc.1') !== false) throw new Error('same-base check wrong')
})

await check('scenarios passthrough + pkgName annotation from the corpus', async () => {
  const { status, body } = await getJson('/scenarios')
  if (status !== 200 || body.scenarios?.scenarios?.[0]?.id !== 'session-archive') throw new Error(`status ${status}`)
  const [beta, gamma] = body.scenarios.scenarios[0].plugins
  // bbb/dsh-beta has pkgName 'dsh-beta' in the corpus; ccc/dsh-gamma has none.
  if (beta.pkgName !== 'dsh-beta') throw new Error(`pkgName annotation missing: ${JSON.stringify(beta)}`)
  if ('pkgName' in gamma) throw new Error('pkgName must be omitted when the corpus row has none')
  if (beta.grade !== 'S' || beta.reasons?.[0] !== '标签: archive') throw new Error('pick fields not preserved')
})

await check('dynamics passthrough', async () => {
  const { status, body } = await getJson('/dynamics')
  if (status !== 200 || body.dynamics?.dsh?.releases?.[0]?.breaking !== true) throw new Error(`status ${status}`)
})

await check('health reports cache ages for loaded docs', async () => {
  const { status, body } = await getJson('/health')
  if (status !== 200 || !body.ok) throw new Error(`status ${status}`)
  for (const name of ['insights', 'scenarios', 'dynamics', 'compat', 'enrich']) {
    const entry = body.caches?.[name]
    if (!entry?.cached || typeof entry.ageMs !== 'number' || entry.ageMs < 0 || entry.stale) {
      throw new Error(`cache ${name} status wrong: ${JSON.stringify(entry)}`)
    }
  }
})

// ── selfcheck: library-level (runSelfcheck against the fixture dirs) ─────────

async function expectSelfcheckError(code, promise) {
  try {
    await promise
  } catch (error) {
    if (error instanceof SelfcheckError && error.code === code) return
    throw new Error(`expected SelfcheckError ${code}, got ${error?.code ?? error}`)
  }
  throw new Error(`expected SelfcheckError ${code}, but the call resolved`)
}

await check('selfcheck: well-built plugin scores S/100 with no drops', async () => {
  const r = await runSelfcheck(goodDir)
  if (r.score !== 100 || r.grade !== 'S') throw new Error(`score ${r.score} grade ${r.grade}: ${JSON.stringify(r.drops)}`)
  if (r.drops.length !== 0) throw new Error(`unexpected drops: ${r.drops.map((d) => d.code)}`)
  if (r.hints.length !== 0) throw new Error(`unexpected hints: ${r.hints.map((h) => h.code)}`)
  if (r.pkgName !== 'good-pkg' || r.version !== '1.0.0') throw new Error('pkg fields wrong')
  if (r.npm?.published !== true || r.npm.latest !== '1.0.0') throw new Error('npm report wrong')
  if (r.scan.totalHits !== 0) throw new Error(`scan should be clean: ${JSON.stringify(r.scan.hits)}`)
  if (!Array.isArray(r.uncovered) || r.uncovered.length === 0) throw new Error('uncovered list missing')
})

await check('selfcheck: missing engines.dsh yields a zero-weight hint', async () => {
  const r = await runSelfcheck(hintDir)
  if (r.score !== 100 || r.grade !== 'S' || r.drops.length !== 0) {
    throw new Error(`hint must not affect the score: score ${r.score} drops ${r.drops.map((d) => d.code)}`)
  }
  if (r.hints.length !== 1 || r.hints[0].code !== 'manifest.no-engines-dsh') {
    throw new Error(`hints wrong: ${JSON.stringify(r.hints)}`)
  }
  if (!r.hints[0].zh.includes('engines.dsh') || !r.hints[0].en.includes('engines.dsh')) throw new Error('hint text missing')
})

await check('selfcheck: skeletal plugin collects the expected rule codes', async () => {
  const r = await runSelfcheck(badDir)
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
  // bad-pkg declares no engines.dsh → advisory hint, score untouched
  if (!r.hints.some((h) => h.code === 'manifest.no-engines-dsh')) throw new Error('engines.dsh hint missing')
})

await check('selfcheck: write-surface scan flags fs/child-process/http-write', async () => {
  const r = await runSelfcheck(writingDir)
  const kinds = new Set(r.scan.hits.map((h) => h.kind))
  for (const kind of ['文件系统写 fs-write', '子进程执行 child-process', 'HTTP 写动词 http-write']) {
    if (!kinds.has(kind)) throw new Error(`scan kind missing: ${kind} (got ${[...kinds]})`)
  }
  if (r.scan.totalHits < 3) throw new Error('totalHits wrong')
  if (!r.scan.hits[0].file.endsWith('evil.ts')) throw new Error('hit file wrong')
})

await check('selfcheck: npm drift + single-release + stale are scored', async () => {
  const r = await runSelfcheck(driftDir)
  const codes = new Set(r.drops.map((d) => d.code))
  for (const code of ['npm.version-drift', 'npm.single-release', 'npm.release-stale']) {
    if (!codes.has(code)) throw new Error(`missing ${code} (got ${[...codes]})`)
  }
})

await check('selfcheck: relative path rejected (invalid-path)', async () => {
  await expectSelfcheckError('invalid-path', runSelfcheck('some/relative/dir'))
})

await check('selfcheck: .. traversal rejected (invalid-path)', async () => {
  await expectSelfcheckError('invalid-path', runSelfcheck('/tmp/../etc'))
})

await check('selfcheck: nonexistent dir (not-a-directory)', async () => {
  await expectSelfcheckError('not-a-directory', runSelfcheck('/tmp/dsh-no-such-dir-xyz'))
})

await check('selfcheck: dir without package.json (no-package-json)', async () => {
  await expectSelfcheckError('no-package-json', runSelfcheck(fixtureRoot))
})

// ── selfcheck: CLI subprocess (lib/cli.js exit codes) ────────────────────────

// The static import of ../lib/index.js at the top already makes a prior build
// a hard prerequisite; build once more here when only the CLI entry is
// missing (e.g. `npm test` run straight after pulling this change).
const cliPath = join(rootDir, 'lib/cli.js')
if (!existsSync(cliPath)) {
  execFileSync(process.execPath, [join(rootDir, 'scripts/build.mjs')], { cwd: rootDir, stdio: 'inherit' })
}

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
    return { code: 0, out: stdout }
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

await check('cli: selfcheck good fixture exits 0 with S/100 text report', async () => {
  const { code, out } = runCli(['selfcheck', goodDir])
  if (code !== 0) throw new Error(`exit ${code}: ${out.slice(0, 300)}`)
  if (!/100\/100/.test(out) || !/等级 S|Grade S/.test(out)) throw new Error(`unexpected output: ${out.slice(0, 300)}`)
  if (!out.includes('good-pkg@1.0.0')) throw new Error('pkg line missing')
  if (out.includes('manifest.no-engines-dsh')) throw new Error('good fixture must not show the engines.dsh hint')
})

await check('cli: engines.dsh hint prints but keeps exit 0', async () => {
  const { code, out } = runCli(['selfcheck', hintDir])
  if (code !== 0) throw new Error(`exit ${code}: ${out.slice(0, 300)}`)
  if (!out.includes('manifest.no-engines-dsh')) throw new Error('hint missing from output')
  if (!/提示|Hints/.test(out)) throw new Error('hint section header missing')
  if (!/100\/100/.test(out)) throw new Error('hint must not change the score')
})

await check('cli: selfcheck bad fixture exits 1 with grouped deductions', async () => {
  const { code, out } = runCli(['selfcheck', badDir])
  if (code !== 1) throw new Error(`exit ${code}: ${out.slice(0, 300)}`)
  if (!out.includes('docs.no-readme')) throw new Error('docs.no-readme missing from output')
  if (!/Fix:|怎么修：/.test(out)) throw new Error('fix guidance missing')
})

await check('cli: selfcheck --json prints the full report', async () => {
  const { code, out } = runCli(['selfcheck', goodDir, '--json'])
  if (code !== 0) throw new Error(`exit ${code}`)
  const report = JSON.parse(out)
  if (report.score !== 100 || report.grade !== 'S' || report.pkgName !== 'good-pkg') throw new Error('report fields wrong')
})

await check('cli: relative path exits 2 with a friendly error', async () => {
  const { code, out } = runCli(['selfcheck', 'some/relative/dir'])
  if (code !== 2) throw new Error(`exit ${code}`)
  if (!out.includes('invalid-path')) throw new Error(`error code missing: ${out.slice(0, 200)}`)
})

await check('cli: --help prints usage and exits 0', async () => {
  const { code, out } = runCli(['--help'])
  if (code !== 0 || !out.includes('selfcheck <dir>')) throw new Error(`exit ${code}`)
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
