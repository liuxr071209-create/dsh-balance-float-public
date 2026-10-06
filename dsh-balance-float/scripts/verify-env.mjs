/**
 * Environment verification for dsh-balance-float.
 *
 * Complements `npm test`, which needs no network and no credentials:
 *
 *   1. both halves are intact enough for the loader to accept them;
 *   2. the bundle patch parses as YAML and has the shape the Loader expects;
 *   3. the configured DeepSeek credential really answers `/user/balance`, and
 *      the plugin's own parser accepts the answer;
 *   4. the billing rule's verdict right now, in the schedule's own clock.
 *
 * The API key is read from the credential store and never printed. Run it from
 * the package directory:  node scripts/verify-env.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { nextChangeAt, normalizeSettings, periodAt, selectBalanceInfo } from '../index.js'

const PACKAGE_DIR = new URL('..', import.meta.url)
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const failures = []

/** Report one stage's outcome without aborting the remaining stages. */
function stage(label, run) {
  return Promise.resolve()
    .then(run)
    .then((detail) => console.log(`[ok]   ${label}${detail === undefined ? '' : ` — ${detail}`}`))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${label}: ${message}`)
      console.error(`[fail] ${label} — ${message}`)
    })
}

/* 1 — the two halves the loader will import --------------------------- */

await stage('client bundle shape', async () => {
  const source = await readFile(new URL('client.js', PACKAGE_DIR), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(\{\s*\n\s*id: 'dsh-balance-float',/, 'client.js must register the factory id')
  assert.match(source, /factory\(require\)\s*\{/, 'client.js must expose a factory(require)')
  assert.match(source, /\n\}\)\n?$/, 'client.js must close the loader call')
  assert.match(source, /return \{ name: NS, inject: \['slots'\], apply \}/, 'client.js must return the plugin face')
  const manifest = JSON.parse(await readFile(new URL('package.json', PACKAGE_DIR), 'utf8'))
  assert.equal(manifest.exports['./client'], './client.js', 'the ./client export must point at client.js')
  assert.equal(manifest.exports['.'], './index.js', 'the root export must point at index.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  return `${manifest.name} ${manifest.version}`
})

/* 2 — the bundle patch ------------------------------------------------ */

await stage('bundle patch shape', async () => {
  const source = await readFile(new URL('cordis.patch.yml', PACKAGE_DIR), 'utf8')
  assert.match(source, /- insert:/, 'the patch must declare an insert list')
  assert.match(source, /- id: dsh-balance-float/, 'the patch must insert the plugin row')
  // A parser is optional: DSH's own copy lives in the runtime tree, which this
  // package must not assume. Structural checks above always run.
  const parser = await loadYamlParser()
  if (parser === null) return 'structure checked; no YAML parser reachable for a strict parse'
  const parsed = parser.parse(source)
  assert.ok(Array.isArray(parsed), 'the patch must be a top-level array')
  assert.equal(parsed.length, 1, 'the patch must carry exactly one entry')
  assert.ok(Array.isArray(parsed[0].insert), 'the entry must be an insert list')
  assert.equal(parsed[0].insert.length, 1, 'the insert list must carry exactly one row')
  const row = parsed[0].insert[0]
  assert.equal(row.id, 'dsh-balance-float')
  assert.equal(row.name, 'dsh-balance-float')
  const settings = normalizeSettings(row.config)
  return `row ${row.id}; pollMs ${settings.pollMs}; peak windows ${JSON.stringify(settings.peakWindows)}`
})

/** Resolve a `yaml` module from the Harness runtime when one is reachable. */
async function loadYamlParser() {
  const bases = [
    join(dshHome, 'profiles', 'web', 'package.json'),
    join(dshHome, 'profiles', 'node_modules', 'package.json'),
    join(process.cwd(), 'package.json'),
  ]
  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve('yaml')
      return await import(pathToFileURL(resolved).href)
    } catch {
      // Try the next base.
    }
  }
  return null
}

/* 3 — the live credential and endpoint -------------------------------- */

await stage('live DeepSeek balance endpoint', async () => {
  const credentialsPath = join(dshHome, '.credentials.yaml')
  let stored
  try {
    stored = await readFile(credentialsPath, 'utf8')
  } catch {
    return `skipped: no credential store at ${credentialsPath}`
  }
  /* The `refs` section indents its keys, so match on structure, not on column. */
  const match = /^[ \t]*DEEPSEEK_API_KEY:[ \t]*(\S+)[ \t]*$/m.exec(stored)
  if (match === null) return 'skipped: DEEPSEEK_API_KEY is not configured'
  const apiKey = match[1]
  assert.ok(apiKey.length > 8, 'the stored key looks empty')
  const response = await fetch('https://api.deepseek.com/user/balance', {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  assert.equal(response.status, 200, `the endpoint answered HTTP ${response.status}`)
  const balance = selectBalanceInfo(await response.json())
  return `${balance.currency} ${balance.totalBalance.toFixed(2)} `
    + `(granted ${balance.grantedBalance.toFixed(2)} / topped up ${balance.toppedUpBalance.toFixed(2)})`
})

/* 4 — what the card shows right now ----------------------------------- */

await stage('billing period right now', async () => {
  const settings = normalizeSettings(undefined)
  const schedule = { utcOffsetMinutes: settings.utcOffsetMinutes, peakWindows: settings.peakWindows }
  const now = Date.now()
  const next = nextChangeAt(now, schedule)
  const clock = (timestamp) => new Date(timestamp + schedule.utcOffsetMinutes * 60_000).toISOString().slice(11, 16)
  return `Beijing ${clock(now)} -> ${periodAt(now, schedule)}`
    + (next === null ? '; no further change' : `; changes ${clock(next)} (in ${Math.round((next - now) / 60_000)} min)`)
})

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
