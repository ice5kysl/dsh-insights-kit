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
import { apply } from '../lib/index.js'

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
  if (p.npm !== 'dsh-alpha' || p.version !== '1.0.0' || !p.description || !p.url) throw new Error('trimmed fields wrong')
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

await check('scenarios passthrough', async () => {
  const { status, body } = await getJson('/scenarios')
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

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
