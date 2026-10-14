/**
 * Environment verification for dsh-audio-reward.
 *
 * Complements `npm test`, which needs no network, no audio directory, and no
 * running DSH:
 *
 *   1. both halves are intact enough for the loader to accept them;
 *   2. the bundle patch parses as YAML and names the row it inserts;
 *   3. the configured audio directory really contains usable tracks;
 *   4. the running DSH serves the plugin's routes, and its bundle is composed.
 *
 * Run it from the package directory:  node scripts/verify-env.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { listTracks, normalizeSettings } from '../index.js'

const PACKAGE_DIR = new URL('..', import.meta.url)
const PACKAGE_NAME = 'dsh-audio-reward'
const BASE = (process.env.DSH_WEB_URL?.trim() || 'http://127.0.0.1:19387').replace(/\/$/, '')
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

/** Resolve a `yaml` module from the Harness runtime when one is reachable. */
async function loadYamlParser() {
  for (const base of [
    join(dshHome, 'profiles', 'web', 'package.json'),
    join(dshHome, 'profiles', 'node_modules', 'package.json'),
    join(process.cwd(), 'package.json'),
  ]) {
    try {
      return await import(pathToFileURL(createRequire(base).resolve('yaml')).href)
    } catch {
      // Try the next base.
    }
  }
  return null
}

/* 1 — the two halves the loader will import --------------------------- */

await stage('client bundle shape', async () => {
  const source = await readFile(new URL('client.js', PACKAGE_DIR), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(\{\s*\n\s*id: 'dsh-audio-reward',/, 'client.js must register the factory id')
  assert.match(source, /factory\(require\)\s*\{/, 'client.js must expose a factory(require)')
  assert.match(source, /\n\}\)\n?$/, 'client.js must close the loader call')
  assert.match(source, /return \{ name: NS, inject: \[\], apply \}/, 'client.js must return the plugin face')
  const manifest = JSON.parse(await readFile(new URL('package.json', PACKAGE_DIR), 'utf8'))
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  // The chooser lives in the balance card, so that card must load first.
  assert.ok(manifest.dsh.client.inject.includes('dsh-balance-float'), 'the card must be listed in dsh.client.inject')
  return `${manifest.name} ${manifest.version}`
})

/* 2 — the bundle patch ------------------------------------------------ */

let settings = normalizeSettings(undefined)
await stage('bundle patch shape', async () => {
  const source = await readFile(new URL('cordis.patch.yml', PACKAGE_DIR), 'utf8')
  assert.match(source, /- insert:/, 'the patch must declare an insert list')
  assert.match(source, /- id: dsh-audio-reward/, 'the patch must insert the plugin row')
  const parser = await loadYamlParser()
  if (parser === null) return 'structure checked; no YAML parser reachable for a strict parse'
  const parsed = parser.parse(source)
  assert.ok(Array.isArray(parsed), 'the patch must be a top-level array')
  assert.equal(parsed.length, 1)
  const row = parsed[0].insert[0]
  assert.equal(row.id, PACKAGE_NAME)
  assert.equal(row.name, PACKAGE_NAME)
  settings = normalizeSettings(row.config)
  return `audioDir ${settings.audioDir}; coalesceMs ${settings.coalesceMs}; ${settings.extensions.length} extensions; ${Object.keys(settings.labels).length} labels`
})

/* 3 — the configured library ------------------------------------------ */

/** Short summary of a track, used by both library lines below. */
const describeTrack = (track) => `${track.label} (${track.mime}, ${String(track.bytes)}B)`

await stage('your audio directory', async () => {
  const user = listTracks({ ...settings, bundledAudio: 'off' })
  if (user.length === 0) return `nothing usable in ${settings.audioDir} — ${settings.bundledAudio} mode decides what plays instead`
  return `${user.length} track(s) in ${settings.audioDir}: ${user.map(describeTrack).join(', ')}`
})

await stage('clips shipped in the package', async () => {
  /* What a fresh install hears, and what `merge` adds on top of the above. */
  const bundled = listTracks({ ...settings, audioDir: join(settings.audioDir, '__absent__') })
  if (bundled.length === 0) throw new Error('the package ships no usable audio')
  const hasDefault = bundled.some((track) => track.name === settings.defaultTrack)
  assert.ok(hasDefault, `defaultTrack "${settings.defaultTrack}" is not among the shipped clips`)
  return `${bundled.length} track(s), mode ${settings.bundledAudio}, default ${settings.defaultTrack}: ${bundled.map(describeTrack).join(', ')}`
})

/* 4 — the running DSH -------------------------------------------------- */

await stage('live Host routes', async () => {
  const state = await fetch(`${BASE}/api/dsh-audio-reward/state`, { headers: { accept: 'application/json' } })
  /* Before this plugin is installed the path falls through to the API gateway,
     which owns the `/api` prefix and answers 401 without page credentials. */
  if (state.status === 404 || state.status === 401) return 'not installed in this profile yet'
  assert.equal(state.status, 200, `state route answered HTTP ${state.status}`)
  const body = await state.json()
  /* A running Host keeps the module it already imported, so a `defaultTrack`
     that is missing here means the process predates this code: restart DSH. */
  const stale = !('defaultTrack' in body)
  assert.equal(body.ok, true)
  const events = await fetch(`${BASE}/api/dsh-audio-reward/events?since=0`, { headers: { accept: 'application/json' } })
  assert.equal(events.status, 200)
  const cue = await events.json()
  assert.equal(typeof cue.latest, 'number')
  if (stale) return `${String(body.tracks.length)} track(s) served, but the running Host is older than this source — restart DSH to load it`
  return `${body.tracks.length} track(s) served, default ${body.defaultTrack}, cursor at ${cue.latest}`
})

await stage('composed browser bundle', async () => {
  const clientJs = new URL('client.js', PACKAGE_DIR)
  const baseline = statSync(clientJs)
  /* Mirrors artifactRevision() in @deepseek-ai/dsh-client-modules. */
  const framed = (domain, parts) => {
    const hash = createHash('sha1').update(domain).update('\0')
    for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
    return hash.digest('hex').slice(0, 12)
  }
  const rev = framed('plugin-artifact', [String(baseline.mtimeMs), String(baseline.ctimeMs), String(baseline.size)])
  const path = `/plugins/??${PACKAGE_NAME}/client.js&rev=${rev}`
  const response = await fetch(`${BASE}${path}`, { headers: { accept: 'text/javascript' } })
  if (response.status === 404) return 'not composed yet (install it, or restart DSH)'
  assert.equal(response.status, 200, `bundle route answered HTTP ${response.status}`)
  const body = await response.text()
  for (const marker of ['window.__ModuleLoader__.load', `id: '${PACKAGE_NAME}'`, 'registerPanel', 'NotAllowedError']) {
    assert.ok(body.includes(marker), `served bundle is missing ${marker}`)
  }
  return `${String(body.length)} bytes at rev ${rev}`
})

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
