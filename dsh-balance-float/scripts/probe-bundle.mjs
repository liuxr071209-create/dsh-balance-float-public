/**
 * Ask a running DSH whether it has composed this plugin's browser half.
 *
 * The client-module registry advertises every composed entry as a revisioned
 * combo URL and derives that revision from the bundle file's filesystem
 * metadata. Recomputing the same hash here means the answer is decisive:
 *
 *   200 — the running process holds the entry and will hand it to the page, so
 *         a page refresh is enough;
 *   404 — the composition has not caught up (restart DSH), *or* this DSH build
 *         derives the revision differently, in which case this probe cannot
 *         tell the two apart and the page itself remains the authority.
 *
 * The Host half is easier to check and needs no revision: GET
 * `/api/dsh-balance-float/state` answers whenever the plugin is active.
 *
 * Usage:  node scripts/probe-bundle.mjs [baseUrl]
 */
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'

const BASE = (process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').replace(/\/$/, '')
const CLIENT_JS = new URL('../client.js', import.meta.url)
const PACKAGE_NAME = 'dsh-balance-float'
/** Mirrors `HASH_REVISION_LENGTH` in @deepseek-ai/dsh-client-modules. */
const HASH_REVISION_LENGTH = 12

/** sha1 over length-framed parts, truncated the way the registry does it. */
function framedHash(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, HASH_REVISION_LENGTH)
}

/** Mirrors `artifactRevision(baseline)` in @deepseek-ai/dsh-client-modules. */
function artifactRevision(baseline) {
  return framedHash('plugin-artifact', [
    String(baseline.mtimeMs),
    String(baseline.ctimeMs),
    String(baseline.size),
  ])
}

const baseline = statSync(CLIENT_JS)
const rev = artifactRevision(baseline)
const path = `/plugins/??${PACKAGE_NAME}/client.js&rev=${rev}`

console.log(`base url   ${BASE}`)
console.log(`bundle     ${CLIENT_JS.pathname}`)
console.log(`baseline   mtimeMs=${baseline.mtimeMs} ctimeMs=${baseline.ctimeMs} size=${baseline.size}`)
console.log(`revision   ${rev}`)

const response = await fetch(`${BASE}${path}`, { headers: { accept: 'text/javascript' } })
const body = response.ok ? await response.text() : ''
console.log(`\nGET ${path}`)
console.log(`   -> HTTP ${response.status} ${response.headers.get('content-type') ?? ''} ${body.length} bytes`)

if (!response.ok) {
  console.error('   -> not composed (or a different revision scheme). Restart DSH, then retry.')
  process.exit(1)
}

const markers = {
  'loader call': body.includes('window.__ModuleLoader__.load'),
  'factory id': body.includes(`id: '${PACKAGE_NAME}'`),
  'overlay contribution': body.includes("'shell.overlay'"),
  'plugin face': body.includes("inject: ['slots']"),
  /* Behaviour canaries, not just structural ones: these prove the served bytes
     are the current source rather than a composition from before the last edit. */
  'drag machine': body.includes('createDragMachine') && body.includes('isDragGesture'),
  'whole-card surface': body.includes('data-dbf-dragging') && body.includes('onClickCapture'),
  'containing-block frame': body.includes('measureFrame') && body.includes('offsetParent'),
}
for (const [name, present] of Object.entries(markers)) console.log(`   -> ${present ? 'ok  ' : 'MISS'} ${name}`)
process.exit(Object.values(markers).every(Boolean) ? 0 : 1)
