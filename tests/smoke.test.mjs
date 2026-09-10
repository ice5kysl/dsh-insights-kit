/**
 * Standalone smoke test for the host face (no cordis runtime needed, no real
 * upstream). Boots:
 *
 *   1. a fixture server serving small insights/scenarios/dynamics/compat/
 *      enrich/compat-observed JSON docs (compat-observed is the small
 *      synthetic tests/fixtures/compat-observed.json — never the real 1MB+
 *      matrix),
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
import { disableEntry, parseSimplePatch } from '../src/host/hot.ts'
import { extractRequires, extractSeedWords } from '../src/host/shell.ts'
import { computeUpgradeCheck, createStore, observedAtShell, observedByPkg, NPM_DIST_TAGS_TTL_MS } from '../src/host/upstream.ts'
import { installedPluginNames, npmNameOfModule } from '../src/shared/installed.ts'
import { baseVersion, isOutdated, satisfiesSimpleRange } from '../src/shared/compat.ts'
import { classifyCheckInput, observedFailInstallReason, scenarioInstallBlocked } from '../src/client/api.ts'
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
    {
      // Corpus-known package with a materialized node_modules entry + plain
      // cordis.patch.yml in the mutate profile — exercises the hot-mount path.
      full_name: 'zzz/dsh-hot-ok',
      stars: 1,
      pkgName: 'dsh-hot-ok',
      description: 'Hot-mountable fixture plugin',
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

const DSH_DYNAMICS_CORE = {
  repo: 'deepseek-ai/DeepSeek-Harness',
  stars: 213472,
  releases: [
    { tag: 'dsh-v0.1.3-alpha.1', name: 'v0.1.3-alpha.1', prerelease: true, published_at: '2026-09-04T11:34:32Z', breaking: true, summary: 'x', added: 5, fixed: 10 },
  ],
}

const DYNAMICS = {
  fetchedAt: '2026-09-07T00:00:00.000Z',
  dsh: {
    ...DSH_DYNAMICS_CORE,
    // Stale on purpose: the site snapshot lags the registry fixture above.
    npm: { pkg: '@deepseek-ai/dsh', distTags: { latest: '0.1.2-rc.1', next: '0.1.2-rc.1', alpha: '0.1.2-alpha.5' }, modified: '2026-09-07T00:00:00.000Z' },
  },
  platform: [{ repo: 'deepseek-ai/DeepSeek-V3', stars: 104436, latestRelease: null }],
}

// The legacy fixture serves the pre-matrix site's dynamics WITHOUT dist-tags —
// the upgrade-check degradation path needs "no latest is known".
const DYNAMICS_LEGACY = { ...DYNAMICS, dsh: DSH_DYNAMICS_CORE }

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

// compat-observed.json: the observed load-test matrix (plugin × shell version
// → ok/broken). A small synthetic doc from tests/fixtures/ — statuses seen in
// the real matrix are exactly 'ok' and 'broken'; dsh-sparse exercises the
// sparse-results case (only some shell versions tested).
const COMPAT_OBSERVED = JSON.parse(readFileSync(join(rootDir, 'tests/fixtures/compat-observed.json'), 'utf8'))

// ── fixture upstream ─────────────────────────────────────────────────────────

const fixture = createServer((req, res) => {
  const name = (req.url ?? '').replace(/^\//, '')
  const docs = { 'insights.json': INSIGHTS, 'scenarios.json': SCENARIOS, 'dynamics.json': DYNAMICS, 'compat.json': COMPAT, 'enrich.json': ENRICH, 'compat-observed.json': COMPAT_OBSERVED }
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

// Legacy upstream: the same five documents but NO compat-observed.json (the
// pre-matrix site) — the observed annotations must silently disappear, never
// error. A second plugin instance is pointed at it inside the degradation
// test and disposed there.
const legacyFixture = createServer((req, res) => {
  const name = (req.url ?? '').replace(/^\//, '')
  const docs = { 'insights.json': INSIGHTS, 'scenarios.json': SCENARIOS, 'dynamics.json': DYNAMICS_LEGACY, 'compat.json': COMPAT, 'enrich.json': ENRICH }
  if (docs[name]) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(docs[name]))
  } else {
    res.writeHead(404)
    res.end('nope')
  }
})
await new Promise((resolve) => legacyFixture.listen(0, '127.0.0.1', resolve))
const legacyFixturePort = legacyFixture.address().port

// ── fake npm registry (selfcheck consistency checks + live dist-tags) ────────

const registry = createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? '').replace(/^\//, ''))
  if (name === '@deepseek-ai/dsh') {
    // "Just released" — newer than anything inside the dynamics.json fixture
    // below, so the /dynamics overlay check proves the registry wins.
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      'dist-tags': { latest: '0.1.5-rc.1', next: '0.1.5-rc.1', alpha: '0.1.5-alpha.2' },
      versions: { '0.1.2-rc.1': {}, '0.1.5-alpha.2': {}, '0.1.5-rc.1': {} },
    }))
  } else if (name === 'good-pkg') {
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
  'node_modules/dsh-alpha/package.json': JSON.stringify({ name: 'dsh-alpha', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }),
  // alpha's client bundle requires only seed words + an in-box graph row
  // (dsh-client-ui-foo from the fixture install tree) → compat status ok.
  'node_modules/dsh-alpha/lib/client.js': 'const a = require("react")\nconst b = require("@deepseek-ai/dsh-client-store")\nconst c = require("@deepseek-ai/dsh-client-ui-foo/client")\nconsole.log(a, b, c)\n',
  'node_modules/dsh-beta/package.json': JSON.stringify({ name: 'dsh-beta', version: '2.1.0', cordis: {}, dsh: { client: { platform: 'web' } } }),
  // beta's client bundle still requires the module rc.1 dropped → broken.
  'node_modules/dsh-beta/lib/client.js': 'const a = require("react")\nconst stale = require("@deepseek-ai/dsh-client-runtime/client")\nconsole.log(a, stale)\n',
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
    dependencies: {
      '@deepseek-ai/dsh-base': '0.1.2-rc.1',
      // Reverse-dependency guard pair: consumer depends on shared, so
      // uninstalling shared must 409 until consumer is removed first.
      'dsh-shared': '^1.0.0',
      'dsh-consumer': '^2.0.0',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-shared', 'dsh-consumer'] } },
  }, null, 2),
  'node_modules/dsh-shared/package.json': JSON.stringify({ name: 'dsh-shared', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  'node_modules/dsh-consumer/package.json': JSON.stringify({ name: 'dsh-consumer', version: '2.0.0', dependencies: { 'dsh-shared': '^1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  // Pre-materialized dsh-alpha: the disable→re-enable path needs a version
  // readable from disk (files stay put across a disable, unlike an uninstall).
  'node_modules/dsh-alpha/package.json': JSON.stringify({ name: 'dsh-alpha', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  // Pre-materialized package tree for the hot-mountable fixture plugin: the
  // stub pnpm only edits the manifest, so the patch + pkg.json the hot mount
  // reads must already exist.
  'node_modules/dsh-hot-ok/package.json': JSON.stringify({ name: 'dsh-hot-ok', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  'node_modules/dsh-hot-ok/cordis.patch.yml': '- insert:\n    - id: hot-ok\n      name: dsh-hot-ok\n',
})
// A leftover hot-mount input from a "previous process" — apply() must wipe it.
writeTree(profileFixture, {
  '.dsh-insights/hot-99.yml': "- id: 'dshi-stale'\n  name: 'dsh-stale'\n",
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

// Stub for the harness-vendored include plugin (hot-mount carrier). write()
// is a tripwire — the kit's subclass must suppress it.
writeTree(fixtureRoot, {
  'include-stub.mjs': [
    'export class Include {',
    '  constructor(ctx, config) { this.ctx = ctx; this.config = config }',
    '  write() { throw new Error("write() must be suppressed by the hot subclass") }',
    '  import(name) { return { name, apply() {} } }',
    '}',
  ].join('\n'),
})
process.env.DSH_INSIGHTS_INCLUDE_MODULE = join(fixtureRoot, 'include-stub.mjs')

// Fixture dsh install tree for the shell module-table check: a minified-shape
// shell asset whose seed table is react / react/jsx-runtime / cordis /
// dsh-client-store, an in-box client package (graph-row arm), and the version
// carrier. Pointed to via DSH_INSIGHTS_DSH_ROOT (the /compat route and the
// selfcheck seed guard both resolve it from env).
const dshRoot = join(fixtureRoot, 'dsh-root')
writeTree(dshRoot, {
  'node_modules/@deepseek-ai/dsh-web-app/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-web-app', version: '9.9.9-fixture' }),
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-fake.js':
    '!function(){const q5=1,Y5=2,M5=3,M6=4;function zp(){return{react:q5,"react/jsx-runtime":Y5,"@deepseek-ai/cordis":M5,"@deepseek-ai/dsh-client-store":M6}};boot({staticModules:zp()})}()\n',
  'node_modules/@deepseek-ai/dsh-client-ui-foo/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-client-ui-foo', version: '9.9.9-fixture', dsh: { client: { platform: 'web' } } }),
})
process.env.DSH_INSIGHTS_DSH_ROOT = dshRoot

// 'all'-shape profile (no dsh.profile.bundles field — every dependency
// loads): install must NOT conjure a bundles list (that would flip the shape
// and unload everything else); disable is not expressible there.
const allShapeFixture = join(fixtureRoot, 'profile-all-shape')
writeTree(allShapeFixture, {
  'package.json': JSON.stringify({
    name: 'dsh-profile-all',
    dependencies: { '@deepseek-ai/dsh-base': '0.1.2-rc.1', 'dsh-alpha': '^1.0.0' },
  }, null, 2),
  'node_modules/dsh-alpha/package.json': JSON.stringify({ name: 'dsh-alpha', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
})

// doctor fixture: own copy of the broken-plugin profile so --fix mutations
// never disturb the shared route fixtures.
const doctorFixture = join(fixtureRoot, 'profile-doctor')
writeTree(doctorFixture, {
  'package.json': JSON.stringify({
    name: 'dsh-profile-doctor',
    dependencies: { 'dsh-alpha': '^1.0.0', 'dsh-beta': '^2.1.0' },
    dsh: { profile: { bundles: ['dsh-alpha', 'dsh-beta'] } },
  }, null, 2),
  'node_modules/dsh-alpha/package.json': JSON.stringify({ name: 'dsh-alpha', version: '1.0.0', dsh: { client: { platform: 'web' } } }),
  'node_modules/dsh-alpha/lib/client.js': 'const a = require("react")\nconsole.log(a)\n',
  'node_modules/dsh-beta/package.json': JSON.stringify({ name: 'dsh-beta', version: '2.1.0', dsh: { client: { platform: 'web' } } }),
  'node_modules/dsh-beta/lib/client.js': 'const stale = require("@deepseek-ai/dsh-client-runtime/client")\nconsole.log(stale)\n',
})

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

// Seed-guard fixtures: same well-built shape (npm name reuses the registry
// fixture's good-pkg so the npm rules stay green), differing only in the
// client bundle's requires — one stale (rc.1-dropped) module vs seed-only.
const guardDir = join(fixtureRoot, 'guard-plugin')
writeTree(guardDir, {
  'package.json': JSON.stringify(GOOD_PKG, null, 2),
  'cordis.patch.yml': '- insert:\n    - id: good\n      name: good-pkg\n',
  'lib/index.js': 'export const name = "good"\n',
  'lib/client.js': 'const a = require("react")\nconst stale = require("@deepseek-ai/dsh-client-runtime")\nconsole.log(a, stale)\n',
  'README.md': `# good-pkg\n\n${'A well-documented fixture plugin. '.repeat(20)}\n`,
  'README.zh-CN.md': '# good-pkg\n\n中文文档。\n',
  LICENSE: 'MIT License\n',
  'docs/DESIGN.md': '# design\n',
  'tests/good.test.mjs': 'import test from "node:test"\ntest("ok", () => {})\n',
  '.github/workflows/ci.yml': 'name: ci\non: [push]\n',
  'src/index.ts': 'export function apply(): void {\n  element.textContent = "safe"\n}\n',
})
const guardOkDir = join(fixtureRoot, 'guard-ok-plugin')
writeTree(guardOkDir, {
  'package.json': JSON.stringify(GOOD_PKG, null, 2),
  'cordis.patch.yml': '- insert:\n    - id: good\n      name: good-pkg\n',
  'lib/index.js': 'export const name = "good"\n',
  'lib/client.js': 'const a = require("react")\nconst b = require("react/jsx-runtime")\nconsole.log(a, b)\n',
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
// Hot-mount fakes: `inject` hands over a fake loader (one bundle-layer entry
// named dsh-beta), `plugin` records subtree mounts with a disposable handle.
const pluginMounts = []
const loaderEntry = {
  options: { name: 'dsh-beta', disabled: null },
  fiber: { live: true },
  updates: [],
  async update(opts) { this.updates.push(opts) },
}
const fakeLoader = { entries: () => [loaderEntry] }
const fakeCtx = {
  logger: () => ({ info: () => {} }),
  effect: (fn) => {
    const dispose = fn()
    effects.push(dispose)
    return dispose
  },
  inject(names, cb) {
    if (names.includes('loader')) cb({ loader: fakeLoader })
  },
  plugin(tree, config) {
    const handle = {
      config,
      disposed: false,
      await: async () => {},
      dispose: async () => { handle.disposed = true },
    }
    pluginMounts.push(handle)
    return handle
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
// apply() must have wiped the leftover hot-mount input from the profile dir
if (existsSync(join(profileFixture, '.dsh-insights', 'hot-99.yml'))) {
  throw new Error('stale hot-mount file survived boot cleanup')
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
  // The stub include module is set, so the hot-mount probe must report true.
  if (body.hotMount !== true) throw new Error(`hotMount flag wrong: ${JSON.stringify(body.hotMount)}`)
})

// ── hot mount / live disable ─────────────────────────────────────────────────

await check('hot: parseSimplePatch accepts plain inserts, rejects anything else', async () => {
  const plain = parseSimplePatch('# comment\r\n- insert:\r\n    - id: foo\r\n      name: bar\r\n')
  if (!plain || plain.length !== 1 || plain[0].id !== 'foo' || plain[0].name !== 'bar') {
    throw new Error(`plain patch wrong: ${JSON.stringify(plain)}`)
  }
  for (const bad of [
    '- insert:\n    - id: foo\n      name: bar\n      config:\n        k: 1\n',
    '- insert:\n    - id: foo\n      name: !!js/new Date\n',
    '[]\n',
    '- insert:\n    - id: foo\n',
  ]) {
    if (parseSimplePatch(bad) !== null) throw new Error(`must reject: ${JSON.stringify(bad)}`)
  }
})

await check('hot: disableEntry toggles only the matching loader entry, null-safe', async () => {
  const entries = [
    { options: { name: 'x' }, fiber: {}, updates: [], async update(o) { this.updates.push(o) } },
    { options: { name: 'y' }, fiber: {}, updates: [], async update(o) { this.updates.push(o) } },
  ]
  const loader = { entries: () => entries }
  if (await disableEntry(loader, 'x') !== true) throw new Error('x should be disabled')
  if (entries[0].updates.length !== 1 || entries[0].updates[0].disabled !== true) throw new Error('x update wrong')
  if (entries[1].updates.length !== 0) throw new Error('y must be untouched')
  if (await disableEntry(loader, 'zzz') !== false) throw new Error('unknown name must return false')
  if (await disableEntry(null, 'x') !== false) throw new Error('null loader must return false')
})

await check('mutation: install hot-mounts (hot:true, no restart), uninstall disposes live', async () => {
  const saved = process.env.DSH_INSIGHTS_PROFILE_DIR
  process.env.DSH_INSIGHTS_PROFILE_DIR = mutateFixture
  try {
    const add = await postJson('/install', { name: 'dsh-hot-ok' }, MUTATE_HEADERS)
    if (add.status !== 200 || add.body.ok !== true) throw new Error(`install: ${add.status} ${JSON.stringify(add.body)}`)
    if (add.body.hot !== true || add.body.restartRequired !== false) {
      throw new Error(`hot flags wrong: ${JSON.stringify(add.body)}`)
    }
    // The Include subtree got the mount: one handle, its input file carrying
    // the dshi- prefixed row under the profile's .dsh-insights dir.
    const handle = pluginMounts[pluginMounts.length - 1]
    if (!handle?.config?.path?.includes('.dsh-insights')) throw new Error(`mount path wrong: ${JSON.stringify(handle?.config)}`)
    const hotFile = decodeURIComponent(handle.config.path.replace('file://', ''))
    const yml = readFileSync(hotFile, 'utf8')
    if (!yml.includes("id: 'dshi-hot-ok'") || !yml.includes("name: 'dsh-hot-ok'")) {
      throw new Error(`hot file wrong: ${yml}`)
    }
    const remove = await postJson('/uninstall', { name: 'dsh-hot-ok' }, MUTATE_HEADERS)
    if (remove.status !== 200 || remove.body.hot !== true) throw new Error(`uninstall: ${JSON.stringify(remove.body)}`)
    if (handle.disposed !== true) throw new Error('hot handle not disposed')
  } finally {
    process.env.DSH_INSIGHTS_PROFILE_DIR = saved
  }
})

await check('mutation: uninstall of a bundle-layer plugin live-disables its loader entry', async () => {
  const saved = process.env.DSH_INSIGHTS_PROFILE_DIR
  process.env.DSH_INSIGHTS_PROFILE_DIR = mutateFixture
  try {
    // dsh-beta sits in the fake loader as a bundle-layer entry. It has no
    // node_modules tree in this fixture, so the install above could not
    // hot-mount it (no patch to read) — meaning the uninstall's hotUnmount
    // finds no kit-owned handle and disableEntry must flip the loader entry.
    await postJson('/install', { name: 'dsh-beta' }, MUTATE_HEADERS) // deps row for the not-installed gate
    loaderEntry.updates.length = 0
    const remove = await postJson('/uninstall', { name: 'dsh-beta' }, MUTATE_HEADERS)
    if (remove.status !== 200) throw new Error(`uninstall: ${JSON.stringify(remove.body)}`)
    if (loaderEntry.updates.length !== 1 || loaderEntry.updates[0].disabled !== true) {
      throw new Error(`loader entry not disabled: ${JSON.stringify(loaderEntry.updates)}`)
    }
  } finally {
    process.env.DSH_INSIGHTS_PROFILE_DIR = saved
  }
})

// ── shell module-table compat (升级预检) + uninstall reverse-dependency guard ─

await check('shell: extractSeedWords parses the minified staticModules shape, rejects garbage', async () => {
  const src = '!function(){function $z(){return{react:q5,"react/jsx-runtime":Y5,"@deepseek-ai/cordis":M5}};boot({staticModules:$z()})}()'
  const words = extractSeedWords(src)
  if (!words || words.join(',') !== 'react,react/jsx-runtime,@deepseek-ai/cordis') {
    throw new Error(`words wrong: ${JSON.stringify(words)}`)
  }
  if (extractSeedWords('no shell here') !== null) throw new Error('garbage must yield null')
  if (extractSeedWords('staticModules:zz()') !== null) throw new Error('call without def must yield null')
})

await check('shell: extractRequires collects literal requires (incl. __require), deduped', async () => {
  const got = extractRequires('const a = require("react"); const b = __require("react/jsx-runtime"); const c = require("react"); const d = require(name); const e = require(`${spec}`)')
  if (got.join(',') !== 'react,react/jsx-runtime') throw new Error(`requires wrong: ${JSON.stringify(got)}`)
  if (extractRequires('export {}').length !== 0) throw new Error('empty expected')
})

await check('compat route: broken plugin flagged against the fixture shell', async () => {
  const { status, body } = await getJson('/compat')
  if (status !== 200 || body.ok !== true) throw new Error(`status ${status}`)
  const compat = body.compat
  if (compat.shell?.version !== '9.9.9-fixture') throw new Error(`shell wrong: ${JSON.stringify(compat.shell)}`)
  if (!compat.shell.seedWords.includes('@deepseek-ai/dsh-client-store')) throw new Error('seed words missing')
  const byName = Object.fromEntries(compat.rows.map((r) => [r.name, r]))
  if (byName['dsh-alpha']?.status !== 'ok') throw new Error(`alpha should be ok: ${JSON.stringify(byName['dsh-alpha'])}`)
  const beta = byName['dsh-beta']
  if (beta?.status !== 'broken' || beta.missing.join(',') !== '@deepseek-ai/dsh-client-runtime/client') {
    throw new Error(`beta should be broken on the stale require: ${JSON.stringify(beta)}`)
  }
  if (byName['plain-util']?.status !== 'no-client') throw new Error(`util should be no-client: ${JSON.stringify(byName['plain-util'])}`)
  if (byName['dsh-disabled'] !== undefined) throw new Error('disabled plugins must be skipped')
})

await check('mutation: disable is likewise blocked by dependents (409)', async () => {
  const saved = process.env.DSH_INSIGHTS_PROFILE_DIR
  process.env.DSH_INSIGHTS_PROFILE_DIR = mutateFixture
  try {
    const blocked = await postJson('/disable', { name: 'dsh-shared' }, MUTATE_HEADERS)
    if (blocked.status !== 409 || blocked.body.error?.code !== 'has-dependents') {
      throw new Error(`expected 409 has-dependents: ${blocked.status} ${JSON.stringify(blocked.body)}`)
    }
    const manifest = readManifest(mutateFixture)
    if (!manifest.dsh.profile.bundles.includes('dsh-shared')) throw new Error('refused disable must not touch the bundles list')
  } finally {
    process.env.DSH_INSIGHTS_PROFILE_DIR = saved
  }
})

await check('mutation: disable quarantines (deps kept, bundles dropped); install re-enables without pnpm', async () => {
  const saved = process.env.DSH_INSIGHTS_PROFILE_DIR
  process.env.DSH_INSIGHTS_PROFILE_DIR = mutateFixture
  try {
    const add = await postJson('/install', { name: 'dsh-alpha' }, MUTATE_HEADERS)
    if (add.status !== 200) throw new Error(`install: ${JSON.stringify(add.body)}`)
    const dis = await postJson('/disable', { name: 'dsh-alpha' }, MUTATE_HEADERS)
    if (dis.status !== 200 || dis.body.ok !== true) throw new Error(`disable: ${JSON.stringify(dis.body)}`)
    let manifest = readManifest(mutateFixture)
    if (!('dsh-alpha' in manifest.dependencies)) throw new Error('disable must KEEP the dependency')
    if (manifest.dsh.profile.bundles.includes('dsh-alpha')) throw new Error('disable must drop the bundles row')
    const again = await postJson('/disable', { name: 'dsh-alpha' }, MUTATE_HEADERS)
    if (again.body.note !== 'already-disabled') throw new Error(`re-disable should noop: ${JSON.stringify(again.body)}`)
    // re-enable: the files never left, so install takes the bundles-only path
    const re = await postJson('/install', { name: 'dsh-alpha' }, MUTATE_HEADERS)
    if (re.status !== 200 || re.body.note !== 're-enabled') throw new Error(`re-enable: ${JSON.stringify(re.body)}`)
    manifest = readManifest(mutateFixture)
    if (!manifest.dsh.profile.bundles.includes('dsh-alpha')) throw new Error('re-enable must restore the bundles row')
    const gone = await postJson('/uninstall', { name: 'dsh-alpha' }, MUTATE_HEADERS)
    if (gone.status !== 200) throw new Error(`cleanup uninstall: ${JSON.stringify(gone.body)}`)
  } finally {
    process.env.DSH_INSIGHTS_PROFILE_DIR = saved
  }
})

await check('mutation: all-shape profile — install never conjures a bundles list, disable refused', async () => {
  const saved = process.env.DSH_INSIGHTS_PROFILE_DIR
  process.env.DSH_INSIGHTS_PROFILE_DIR = allShapeFixture
  try {
    const add = await postJson('/install', { name: 'dsh-beta' }, MUTATE_HEADERS)
    if (add.status !== 200 || add.body.ok !== true) throw new Error(`install: ${JSON.stringify(add.body)}`)
    const manifest = readManifest(allShapeFixture)
    if (!('dsh-beta' in manifest.dependencies)) throw new Error('deps not updated')
    if (manifest.dsh !== undefined) throw new Error('install must NOT create dsh.profile.bundles on an all-shape profile')
    const dis = await postJson('/disable', { name: 'dsh-alpha' }, MUTATE_HEADERS)
    if (dis.status !== 400 || dis.body.error?.code !== 'unsupported-profile') {
      throw new Error(`disable on all-shape should 400: ${dis.status} ${JSON.stringify(dis.body)}`)
    }
  } finally {
    process.env.DSH_INSIGHTS_PROFILE_DIR = saved
  }
})

await check('mutation: uninstall blocked while another installed plugin depends on it', async () => {
  const saved = process.env.DSH_INSIGHTS_PROFILE_DIR
  process.env.DSH_INSIGHTS_PROFILE_DIR = mutateFixture
  try {
    const blocked = await postJson('/uninstall', { name: 'dsh-shared' }, MUTATE_HEADERS)
    if (blocked.status !== 409 || blocked.body.error?.code !== 'has-dependents') {
      throw new Error(`expected 409 has-dependents: ${blocked.status} ${JSON.stringify(blocked.body)}`)
    }
    if ((blocked.body.dependents ?? []).join(',') !== 'dsh-consumer') {
      throw new Error(`dependents wrong: ${JSON.stringify(blocked.body)}`)
    }
    // the refused uninstall must not have touched the manifest
    let manifest = readManifest(mutateFixture)
    if (!('dsh-shared' in manifest.dependencies) || !manifest.dsh.profile.bundles.includes('dsh-shared')) {
      throw new Error('refused uninstall must not touch the manifest')
    }
    // removing the dependent first unblocks the shared package
    const first = await postJson('/uninstall', { name: 'dsh-consumer' }, MUTATE_HEADERS)
    if (first.status !== 200 || first.body.ok !== true) throw new Error(`consumer uninstall: ${JSON.stringify(first.body)}`)
    const second = await postJson('/uninstall', { name: 'dsh-shared' }, MUTATE_HEADERS)
    if (second.status !== 200 || second.body.ok !== true) throw new Error(`shared uninstall after dependent removal: ${JSON.stringify(second.body)}`)
    manifest = readManifest(mutateFixture)
    if ('dsh-shared' in manifest.dependencies || 'dsh-consumer' in manifest.dependencies) throw new Error('deps not cleaned')
  } finally {
    process.env.DSH_INSIGHTS_PROFILE_DIR = saved
  }
})

await check('selfcheck: stale shell require scores compat.missing-seed (major, -10)', async () => {
  const r = await runSelfcheck(guardDir)
  const hit = r.drops.find((d) => d.code === 'compat.missing-seed')
  if (!hit || hit.sev !== 'major') throw new Error(`drop missing: ${JSON.stringify(r.drops.map((d) => d.code))}`)
  if (!hit.label.zh.includes('@deepseek-ai/dsh-client-runtime') || !hit.fix.zh) throw new Error('label/fix incomplete')
  if (r.score !== 90) throw new Error(`score ${r.score}, want 90 (one major)`)
})

await check('selfcheck: a seed-only bundle stays clean', async () => {
  const r = await runSelfcheck(guardOkDir)
  if (r.drops.some((d) => d.code === 'compat.missing-seed')) throw new Error('false positive on a seed-only bundle')
  if (r.hints.some((h) => h.code === 'compat.seed-unchecked')) throw new Error('seed table was locatable — no unchecked hint expected')
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

await check('scenarios annotate the observed matrix (verdict + atCurrentShell), observedAt attached', async () => {
  // The annotation join: pick pkgName → observed plugins key (lowercased).
  // atCurrentShell follows the RUNNING dsh version — null in this dev
  // checkout (no @deepseek-ai/dsh-* resolvable), so assert the shape against
  // whatever /runtime reports.
  const { body: runtime } = await getJson('/runtime')
  const running = runtime.dsh?.version ?? null
  const { status, body } = await getJson('/scenarios')
  if (status !== 200) throw new Error(`status ${status}`)
  if (body.scenarios?.observedAt !== '2026-09-08T00:00:00.000Z') {
    throw new Error(`observedAt wrong: ${body.scenarios?.observedAt}`)
  }
  const [beta, gamma] = body.scenarios.scenarios[0].plugins
  if (beta.observed?.verdict !== 'broken-since') throw new Error(`beta verdict wrong: ${JSON.stringify(beta.observed)}`)
  const betaResults = COMPAT_OBSERVED.plugins['dsh-beta'].results
  const expectedAt = running === null || !(running in betaResults)
    ? null
    : betaResults[running].status === 'ok'
      ? 'ok'
      : 'fail'
  if (beta.observed?.atCurrentShell !== expectedAt) {
    throw new Error(`beta atCurrentShell wrong (running ${running}): ${JSON.stringify(beta.observed)}`)
  }
  // gamma has no pkgName → no observed join at all.
  if ('observed' in gamma) throw new Error('observed must be omitted when the pick has no corpus pkgName')
})

await check('observedByPkg indexes by lowercased npm name and tolerates malformed rows', async () => {
  const map = observedByPkg(COMPAT_OBSERVED)
  if (map.size !== 3) throw new Error(`size ${map.size}`)
  const alpha = map.get('dsh-alpha')
  if (alpha?.verdict !== 'ok' || alpha.results['0.1.2-rc.1']?.status !== 'ok') throw new Error(`alpha wrong: ${JSON.stringify(alpha)}`)
  // The measured plugin version is captured for the stale guard.
  if (alpha.version !== '1.0.0') throw new Error(`alpha version wrong: ${JSON.stringify(alpha)}`)
  const beta = map.get('dsh-beta')
  const missing = beta?.results['0.1.3-alpha.2']?.missing
  if (beta?.verdict !== 'broken-since' || beta.version !== '2.0.0' || !Array.isArray(missing) || missing[0] !== '@deepseek-ai/dsh-client-runtime/client') {
    throw new Error(`beta wrong: ${JSON.stringify(beta)}`)
  }
  // Sparse results: only the tested shell versions are kept.
  const sparse = map.get('dsh-sparse')
  if (Object.keys(sparse?.results ?? {}).join(',') !== '0.1.3-alpha.2') throw new Error(`sparse wrong: ${JSON.stringify(sparse)}`)
  // Malformed inputs degrade piecemeal, never throw.
  for (const doc of [null, undefined, [], {}, { plugins: [] }, { plugins: null }]) {
    if (observedByPkg(doc).size !== 0) throw new Error(`malformed doc must yield an empty map: ${JSON.stringify(doc)}`)
  }
  const messy = observedByPkg({
    plugins: {
      // Non-string status dropped, verdict kept; bad rows skipped.
      'Dsh-Mixed': { results: { '1.0.0': { status: 123 }, '1.0.1': { status: 'ok' } }, verdict: { cls: 'ok' } },
      bad: 'not-an-object',
    },
  })
  const mixed = messy.get('dsh-mixed')
  if (messy.size !== 1 || mixed?.verdict !== 'ok' || Object.keys(mixed.results).join(',') !== '1.0.1') {
    throw new Error(`messy doc wrong: ${JSON.stringify([...messy])}`)
  }
})

await check('observedAtShell maps ok/broken/untested to the wire tri-state', async () => {
  const map = observedByPkg(COMPAT_OBSERVED)
  const alpha = map.get('dsh-alpha')
  const beta = map.get('dsh-beta')
  if (observedAtShell(alpha, '0.1.2-rc.1').atCurrentShell !== 'ok') throw new Error('ok case wrong')
  const broken = observedAtShell(beta, '0.1.3-alpha.2')
  // The real matrix calls failures 'broken' — anything non-ok is a fail.
  if (broken.atCurrentShell !== 'fail' || broken.missing?.[0] !== '@deepseek-ai/dsh-client-runtime/client') {
    throw new Error(`broken case wrong: ${JSON.stringify(broken)}`)
  }
  if ('missing' in observedAtShell(alpha, '0.1.2-rc.1')) throw new Error('ok must not carry missing')
  if (observedAtShell(alpha, '0.0.0-untested').atCurrentShell !== null) throw new Error('untested shell must be null')
  if (observedAtShell(alpha, null).atCurrentShell !== null) throw new Error('null shell must be null')
  if (observedAtShell(undefined, '0.1.2-rc.1').atCurrentShell !== null) throw new Error('unknown plugin must be null')
})

await check('computeUpgradeCheck: latest from the dirty dist-tags, per-plugin status at latest', async () => {
  // Fixture tags mirror the real tag-hygiene mess: latest=0.1.1-rc.1
  // (ancient), next=0.1.2-rc.1 (current line), alpha=0.1.3-alpha.2 (never a
  // recommendation) — the winner must be next.
  const res = computeUpgradeCheck(COMPAT_OBSERVED, DYNAMICS, [
    { name: 'dsh-alpha', version: '1.0.0' },
    { name: 'dsh-beta', version: '2.1.0' },
    { name: 'dsh-sparse', version: '0.1.0' },
    { name: 'plain-util', version: '3.2.1' },
  ], '0.1.1-rc.1')
  if (res.available !== true || res.latest !== '0.1.2-rc.1' || res.current !== '0.1.1-rc.1') {
    throw new Error(`head wrong: ${JSON.stringify(res)}`)
  }
  if (res.observedAt !== '2026-09-08T00:00:00.000Z') throw new Error(`observedAt wrong: ${res.observedAt}`)
  const byName = Object.fromEntries(res.rows.map((r) => [r.name, r]))
  // alpha is ok AT latest (measured version matches); sparse was only tested
  // on 0.1.3-alpha.2; plain-util is not in the matrix at all; beta was
  // measured at 2.0.0 but 2.1.0 is installed → stale, not ok/fail.
  if (byName['dsh-alpha']?.status !== 'ok') throw new Error(`alpha wrong: ${JSON.stringify(byName['dsh-alpha'])}`)
  if (byName['dsh-beta']?.status !== 'stale' || byName['dsh-beta']?.measuredVersion !== '2.0.0') {
    throw new Error(`beta should be stale with measuredVersion: ${JSON.stringify(byName['dsh-beta'])}`)
  }
  if (byName['dsh-sparse']?.status !== 'unknown' || byName['plain-util']?.status !== 'unknown') {
    throw new Error(`unknown rows wrong: ${JSON.stringify(byName)}`)
  }
  const { ok, fail, unknown, stale, total } = res.counts
  // Stale counts in neither ok nor fail — the go/no-go gate is fail-only.
  if (ok !== 1 || fail !== 0 || unknown !== 2 || stale !== 1 || total !== 4) {
    throw new Error(`counts wrong: ${JSON.stringify(res.counts)}`)
  }
})

await check('computeUpgradeCheck: latest semantics — newest of latest/next in matrix, alpha excluded', async () => {
  // next newer than latest: next wins.
  const nextWins = computeUpgradeCheck(COMPAT_OBSERVED, null, [], '0.1.1-rc.1')
  if (nextWins.latest !== '0.1.2-rc.1') throw new Error(`next should win: ${nextWins.latest}`)
  // latest newer than next: latest wins (both in matrix).
  const latestWins = computeUpgradeCheck({
    ...COMPAT_OBSERVED,
    shellDistTags: { latest: '0.1.2-rc.1', next: '0.1.1-rc.1' },
  }, null, [], '0.1.1-rc.1')
  if (latestWins.latest !== '0.1.2-rc.1') throw new Error(`latest should win: ${latestWins.latest}`)
  // alpha is the newest tag value but is never picked.
  const alphaIgnored = computeUpgradeCheck({
    ...COMPAT_OBSERVED,
    shellDistTags: { latest: '0.1.1-rc.1', next: '0.1.1-rc.1', alpha: '0.1.3-alpha.2' },
  }, null, [], '0.1.0')
  if (alphaIgnored.latest !== '0.1.1-rc.1') throw new Error(`alpha must be excluded: ${alphaIgnored.latest}`)
  // A tag outside the matrix is skipped even when it is the newest.
  const outside = computeUpgradeCheck({
    ...COMPAT_OBSERVED,
    shellDistTags: { latest: '9.9.9', next: '0.1.1-rc.1' },
  }, null, [], '0.1.0')
  if (outside.latest !== '0.1.1-rc.1') throw new Error(`out-of-matrix tag must be skipped: ${outside.latest}`)
})

await check('computeUpgradeCheck: stale guard — version mismatch is neither ok nor fail', async () => {
  const doc = {
    ...COMPAT_OBSERVED,
    shellDistTags: { latest: '0.1.2-rc.1' },
  }
  const res = computeUpgradeCheck(doc, null, [
    { name: 'dsh-alpha', version: '1.0.0' },   // matches measured → ok
    { name: 'dsh-beta', version: '2.1.0' },    // measured 2.0.0 → stale
  ], '0.1.2-rc.1')
  const byName = Object.fromEntries(res.rows.map((r) => [r.name, r]))
  if (byName['dsh-alpha']?.status !== 'ok') throw new Error(`alpha wrong: ${JSON.stringify(byName['dsh-alpha'])}`)
  if (byName['dsh-beta']?.status !== 'stale' || byName['dsh-beta']?.measuredVersion !== '2.0.0') {
    throw new Error(`beta stale wrong: ${JSON.stringify(byName['dsh-beta'])}`)
  }
  if (res.counts.ok !== 1 || res.counts.fail !== 0 || res.counts.stale !== 1) {
    throw new Error(`stale must not count as ok/fail: ${JSON.stringify(res.counts)}`)
  }
  // Same-version installed reaches the real verdict (beta fails on the alpha
  // line); a null installed version cannot prove staleness → matrix verdict.
  const atAlpha = computeUpgradeCheck({ ...COMPAT_OBSERVED, shellDistTags: { latest: '0.1.3-alpha.2' } }, null, [
    { name: 'dsh-beta', version: '2.0.0' },
    { name: 'dsh-alpha', version: null },
  ], '0.1.2-rc.1')
  const byName2 = Object.fromEntries(atAlpha.rows.map((r) => [r.name, r.status]))
  if (byName2['dsh-beta'] !== 'fail') throw new Error(`matching version must reach the verdict: ${JSON.stringify(byName2)}`)
  if (byName2['dsh-alpha'] !== 'ok') throw new Error(`null version must fall through to the verdict: ${JSON.stringify(byName2)}`)
  if (atAlpha.counts.fail !== 1 || atAlpha.counts.ok !== 1 || atAlpha.counts.stale !== 0) {
    throw new Error(`counts wrong: ${JSON.stringify(atAlpha.counts)}`)
  }
})

await check('computeUpgradeCheck: name join is case-insensitive, broken maps to fail', async () => {
  const atNext = { ...COMPAT_OBSERVED, shellDistTags: { latest: '0.1.3-alpha.2' } }
  const res = computeUpgradeCheck(atNext, null, [
    { name: 'DSH-Alpha', version: '1.0.0' },
    { name: 'dsh-beta', version: '2.0.0' },
  ], '0.1.2-rc.1')
  const byName = Object.fromEntries(res.rows.map((r) => [r.name, r.status]))
  if (res.latest !== '0.1.3-alpha.2' || byName['DSH-Alpha'] !== 'ok' || byName['dsh-beta'] !== 'fail') {
    throw new Error(`rows wrong: ${JSON.stringify(res)}`)
  }
  if (res.counts.fail !== 1 || res.counts.ok !== 1) throw new Error(`counts wrong: ${JSON.stringify(res.counts)}`)
})

await check('computeUpgradeCheck: degradation paths (no current / tag outside matrix / dynamics fallback)', async () => {
  const alpha = [{ name: 'dsh-alpha', version: '1.0.0' }]
  // Unknown running version → unavailable, rows still computed.
  const noCurrent = computeUpgradeCheck(COMPAT_OBSERVED, null, alpha, null)
  if (noCurrent.available !== false || noCurrent.current !== null || noCurrent.latest !== '0.1.2-rc.1') {
    throw new Error(`no-current wrong: ${JSON.stringify(noCurrent)}`)
  }
  // Dist-tags pointing entirely outside the matrix are treated as unknown
  // (the matrix predates them — nothing has observed results there).
  const ahead = computeUpgradeCheck({ ...COMPAT_OBSERVED, shellDistTags: { latest: '9.9.9', next: '9.9.10' } }, null, alpha, '0.1.1-rc.1')
  if (ahead.available !== false || ahead.latest !== null) throw new Error(`ahead wrong: ${JSON.stringify(ahead)}`)
  // No compat-observed doc at all (old site) → dynamics dist-tag fallback;
  // every row is unknown without the matrix, observedAt null.
  const legacy = computeUpgradeCheck(null, { dsh: { npm: { distTags: { latest: '0.1.3-alpha.2' } } } }, alpha, '0.1.2-rc.1')
  if (legacy.available !== true || legacy.latest !== '0.1.3-alpha.2' || legacy.observedAt !== null) {
    throw new Error(`legacy wrong: ${JSON.stringify(legacy)}`)
  }
  if (legacy.rows[0]?.status !== 'unknown' || legacy.counts.unknown !== 1 || legacy.counts.stale !== 0) {
    throw new Error(`legacy rows wrong: ${JSON.stringify(legacy)}`)
  }
  // The matrix's own tags win over the dynamics fallback.
  const legacyAhead = computeUpgradeCheck(COMPAT_OBSERVED, { dsh: { npm: { distTags: { latest: '9.9.9' } } } }, alpha, '0.1.2-rc.1')
  if (legacyAhead.latest !== '0.1.2-rc.1') throw new Error(`priority wrong: ${JSON.stringify(legacyAhead)}`)
})

await check('upgrade-check route: rows/counts/latest from the fixture matrix, stale guard on version mismatch', async () => {
  // dshVersion() is null in this dev checkout, so available tracks it; the
  // rows/counts/latest come from the fixture regardless. Enabled plugins of
  // profileFixture: dsh-alpha, dsh-beta, dsh-pending, plain-util,
  // dsh-bundle-only (dsh-disabled is out of the load list).
  const { status, body } = await getJson('/upgrade-check')
  if (status !== 200 || body.ok !== true) throw new Error(`status ${status}`)
  // The dirty fixture tags (latest=0.1.1-rc.1 ancient, next=0.1.2-rc.1,
  // alpha=0.1.3-alpha.2) must resolve to next.
  if (body.latest !== '0.1.2-rc.1') throw new Error(`latest wrong: ${JSON.stringify(body)}`)
  if (body.available !== (typeof body.current === 'string')) throw new Error(`available wrong: ${JSON.stringify(body)}`)
  if (body.observedAt !== '2026-09-08T00:00:00.000Z') throw new Error(`observedAt wrong: ${body.observedAt}`)
  const byName = Object.fromEntries((body.rows ?? []).map((r) => [r.name, r]))
  if (byName['dsh-alpha']?.status !== 'ok') throw new Error(`alpha wrong: ${JSON.stringify(byName['dsh-alpha'])}`)
  // beta is installed at 2.1.0 but the matrix measured 2.0.0 → stale.
  if (byName['dsh-beta']?.status !== 'stale' || byName['dsh-beta']?.measuredVersion !== '2.0.0') {
    throw new Error(`beta should be stale with measuredVersion: ${JSON.stringify(byName['dsh-beta'])}`)
  }
  for (const name of ['dsh-pending', 'plain-util', 'dsh-bundle-only']) {
    if (byName[name]?.status !== 'unknown') throw new Error(`${name} should be unknown: ${JSON.stringify(byName[name])}`)
  }
  if ('dsh-disabled' in byName) throw new Error('disabled plugins must be excluded')
  const { ok, fail, unknown, stale, total } = body.counts ?? {}
  if (ok !== 1 || fail !== 0 || unknown !== 3 || stale !== 1 || total !== 5) {
    throw new Error(`counts wrong: ${JSON.stringify(body.counts)}`)
  }
})

await check('legacy upstream (no compat-observed.json): scenarios + upgrade-check degrade silently', async () => {
  const saved = process.env.DSH_INSIGHTS_UPSTREAM_BASE
  const effectsBefore = effects.length
  process.env.DSH_INSIGHTS_UPSTREAM_BASE = `http://127.0.0.1:${legacyFixturePort}`
  try {
    apply(fakeCtx)
    // The legacy instance is the newest registration, so these requests hit it.
    const scenarios = await getJson('/scenarios')
    if (scenarios.status !== 200) throw new Error(`/scenarios status ${scenarios.status}`)
    const [beta] = scenarios.body.scenarios.scenarios[0].plugins
    if ('observed' in beta) throw new Error(`observed must be omitted without the matrix: ${JSON.stringify(beta)}`)
    if (scenarios.body.scenarios.observedAt !== null) throw new Error('observedAt must be null without the matrix')
    if (beta.pkgName !== 'dsh-beta') throw new Error('pkgName annotation must survive the missing matrix')
    const upgrade = await getJson('/upgrade-check')
    if (upgrade.status !== 200 || upgrade.body.ok !== true) throw new Error(`/upgrade-check status ${upgrade.status}`)
    // The DYNAMICS fixture carries no dist-tags, so no latest is known.
    if (upgrade.body.available !== false || upgrade.body.latest !== null) {
      throw new Error(`legacy upgrade-check wrong: ${JSON.stringify(upgrade.body)}`)
    }
  } finally {
    process.env.DSH_INSIGHTS_UPSTREAM_BASE = saved
    // Dispose the extra instance so later tests (effects[1] = the dead-port
    // instance) see the same registration indices as before.
    for (const dispose of effects.splice(effectsBefore)) dispose()
  }
})

await check('scenario install gate: observed fail blocks the install entry, ok/untested do not', async () => {
  if (scenarioInstallBlocked(undefined)) throw new Error('no observed data must not block')
  if (scenarioInstallBlocked({ verdict: 'ok', atCurrentShell: 'ok' })) throw new Error('ok must not block')
  if (scenarioInstallBlocked({ verdict: 'never', atCurrentShell: null })) throw new Error('untested (null) must not block')
  if (!scenarioInstallBlocked({ verdict: 'broken-since', atCurrentShell: 'fail', missing: ['m'] })) throw new Error('fail must block')
  // The disabled-entry tooltip names the consequence and the missing modules.
  const reason = observedFailInstallReason({ verdict: 'broken-since', atCurrentShell: 'fail', missing: ['@deepseek-ai/dsh-client-store'] })
  if (!reason.zh.includes('@deepseek-ai/dsh-client-store') || !reason.zh.includes('崩溃')) {
    throw new Error(`reason must name the modules + consequence: ${reason.zh}`)
  }
  if (!reason.en.includes('missing modules: @deepseek-ai/dsh-client-store')) throw new Error(`en reason wrong: ${reason.en}`)
  const noMods = observedFailInstallReason({ verdict: 'never', atCurrentShell: 'fail' })
  if (noMods.zh.includes('缺失模块') || noMods.en.includes('missing modules')) {
    throw new Error('no missing list → no modules clause')
  }
  // The signpost here is the plugin's detail page (the failure is the
  // plugin's own shell incompatibility, not a local environment problem) —
  // and never dsh-why.
  const withLink = observedFailInstallReason({ verdict: 'broken-since', atCurrentShell: 'fail' }, 'bbb/dsh-beta')
  if (!withLink.zh.includes('为什么：https://dsh-insights.com/p/bbb/dsh-beta/')) {
    throw new Error(`details-page pointer missing: ${withLink.zh}`)
  }
  if (withLink.zh.includes('dsh-why') || withLink.en.includes('dsh-why')) {
    throw new Error('dsh-why must NOT be signposted on the discouraged-install tooltip')
  }
})

await check('dsh-why signposts ship in the client bundle (无法加载 rows + upgrade fail branch)', async () => {
  // Presentation-only wiring: assert the built client carries the command
  // and both zh touchpoints. The build escapes non-ASCII as uppercase \uXXXX.
  const bundle = readFileSync(join(rootDir, 'lib/client.js'), 'utf8')
  if (!bundle.includes('npx dsh-why')) throw new Error('npx dsh-why command missing from the client bundle')
  const esc = (text) => [...text].map((c) => c.charCodeAt(0) > 127 ? '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') : c).join('')
  for (const zh of ['复制诊断命令', '跑 npx dsh-why 看本机诊断', '本机完整诊断']) {
    if (!bundle.includes(esc(zh))) throw new Error(`zh signpost missing from the bundle: ${zh}`)
  }
})

await check('dynamics passthrough + live dist-tag overlay', async () => {
  const { status, body } = await getJson('/dynamics')
  if (status !== 200 || body.dynamics?.dsh?.releases?.[0]?.breaking !== true) throw new Error(`status ${status}`)
  // The registry fixture (0.1.5-rc.1) must win over the snapshot's stale
  // 0.1.2-rc.1 — this is the announcement-day freshness path.
  const tags = body.dynamics?.dsh?.npm?.distTags
  if (tags?.latest !== '0.1.5-rc.1' || tags?.alpha !== '0.1.5-alpha.2') throw new Error(`overlay not applied: ${JSON.stringify(tags)}`)
  if (typeof body.dynamics?.dsh?.npm?.distTagsAt !== 'string') throw new Error('distTagsAt missing')
  // Untouched passthrough fields.
  if (body.dynamics.fetchedAt !== DYNAMICS.fetchedAt || body.dynamics.dsh.npm.modified !== DYNAMICS.dsh.npm.modified) throw new Error('snapshot fields clobbered')
})

await check('npmDistTags store: TTL cache, failure and parse guards', async () => {
  let clock = 1_000
  let calls = 0
  const store = createStore({
    ttlMs: 60_000,
    now: () => clock,
    fetchJson: async (url) => {
      if (url.endsWith('/%40deepseek-ai/dsh')) {
        calls++
        return { 'dist-tags': { latest: '0.2.0' } }
      }
      throw new Error(`unexpected url ${url}`)
    },
  })
  const first = await store.npmDistTags()
  const second = await store.npmDistTags()
  if (first?.latest !== '0.2.0' || second !== first || calls !== 1) throw new Error(`cache not honored: ${calls} calls`)
  clock += NPM_DIST_TAGS_TTL_MS + 1
  const third = await store.npmDistTags()
  if (calls !== 2 || third?.latest !== '0.2.0') throw new Error(`TTL expiry did not refetch: ${calls} calls`)
  // Failure resolves null (never throws) — the snapshot keeps its tags.
  const dead = createStore({ ttlMs: 60_000, now: () => clock, fetchJson: async () => { throw new Error('registry down') } })
  if ((await dead.npmDistTags()) !== null) throw new Error('registry failure must resolve null')
  // Garbage bodies resolve null without caching (next call retries).
  let garbageCalls = 0
  const garbage = createStore({
    ttlMs: 60_000,
    now: () => clock,
    fetchJson: async () => {
      garbageCalls++
      return garbageCalls === 1 ? { 'dist-tags': { latest: 42, next: [] } } : { 'dist-tags': { latest: '1.0.0' } }
    },
  })
  if ((await garbage.npmDistTags()) !== null) throw new Error('malformed dist-tags must resolve null')
  if ((await garbage.npmDistTags())?.latest !== '1.0.0') throw new Error('malformed response was cached')
})

await check('health reports cache ages for loaded docs', async () => {
  const { status, body } = await getJson('/health')
  if (status !== 200 || !body.ok) throw new Error(`status ${status}`)
  for (const name of ['insights', 'scenarios', 'dynamics', 'compat', 'enrich', 'compatObserved']) {
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

function runCli(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
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

await check('cli: doctor reports the broken plugin and exits 1 (no --fix)', async () => {
  const { code, out } = runCli(['doctor'], { DSH_INSIGHTS_PROFILE_DIR: doctorFixture })
  if (code !== 1) throw new Error(`exit ${code}: ${out.slice(0, 300)}`)
  if (!out.includes('dsh-beta') || !out.includes('@deepseek-ai/dsh-client-runtime/client')) {
    throw new Error(`broken row missing: ${out.slice(0, 300)}`)
  }
  if (!out.includes('9.9.9-fixture')) throw new Error(`shell version missing: ${out.slice(0, 200)}`)
  // no --fix → the manifest must be untouched
  const manifest = readManifest(doctorFixture)
  if (!manifest.dsh.profile.bundles.includes('dsh-beta')) throw new Error('doctor without --fix must not mutate')
})

await check('cli: doctor --fix disables exactly the broken plugin, exit 0', async () => {
  const { code, out } = runCli(['doctor', '--fix'], { DSH_INSIGHTS_PROFILE_DIR: doctorFixture })
  if (code !== 0) throw new Error(`exit ${code}: ${out.slice(0, 300)}`)
  const manifest = readManifest(doctorFixture)
  if (manifest.dsh.profile.bundles.includes('dsh-beta')) throw new Error('--fix must drop the broken plugin from bundles')
  if (!('dsh-beta' in manifest.dependencies)) throw new Error('--fix must KEEP the dependency (files preserved)')
  if (!manifest.dsh.profile.bundles.includes('dsh-alpha')) throw new Error('healthy plugins must stay loaded')
  // second run: nothing broken left → clean exit 0
  const again = runCli(['doctor'], { DSH_INSIGHTS_PROFILE_DIR: doctorFixture })
  if (again.code !== 0) throw new Error(`post-fix run should be clean: ${again.out.slice(0, 200)}`)
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
await new Promise((resolve) => legacyFixture.close(resolve))
await new Promise((resolve) => registry.close(resolve))

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
