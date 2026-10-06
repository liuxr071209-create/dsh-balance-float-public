/**
 * Host-half tests: the library, the path guards, the range parser, the cue
 * coalescer, the routes, and the `session/event` filter.
 *
 * The library tests run against a real temporary directory, so the traversal
 * guards are exercised against the filesystem rather than a mock of it.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import {
  CueFeed,
  EVENTS_PATH,
  STATE_PATH,
  TRACK_PREFIX,
  apply,
  labelFor,
  listTracks,
  makeEventsHandler,
  makeStateHandler,
  makeTrackHandler,
  normalizeSettings,
  parseRange,
  resolveTrack,
} from '../index.js'

const AUDIO_DIR = mkdtempSync(join(tmpdir(), 'dsh-audio-test-'))
const MP3_BYTES = Buffer.from('ID3\x03\x00\x00\x00fake-mp3-payload-0123456789', 'latin1')
const CLIP_NAME = '你干嘛哎哟坤坤_耳聆网_[声音ID：39642].mp3'

writeFileSync(join(AUDIO_DIR, 'ciallo.mp3'), MP3_BYTES)
writeFileSync(join(AUDIO_DIR, CLIP_NAME), MP3_BYTES)
writeFileSync(join(AUDIO_DIR, 'notes.txt'), 'not audio')
mkdirSync(join(AUDIO_DIR, 'nested.mp3'))

after(() => {
  rmSync(AUDIO_DIR, { recursive: true, force: true })
})

/** Settings pointed at the fixture library, with the fixture labels. */
function fixtureSettings(overrides = {}) {
  return normalizeSettings({
    audioDir: AUDIO_DIR,
    labels: { 'ciallo.mp3': 'ciallo', [CLIP_NAME]: '爱坤' },
    ...overrides,
  })
}

/* ------------------------------------------------------------------ */
/* Configuration                                                        */
/* ------------------------------------------------------------------ */

test('normalizeSettings defaults, clamps, and filters the extension allowlist', () => {
  const defaults = normalizeSettings(undefined)
  assert.equal(defaults.audioDir, 'D:/音频')
  assert.equal(defaults.coalesceMs, 600)
  assert.equal(defaults.maxEvents, 64)
  assert.ok(defaults.extensions.includes('.mp3'))
  assert.deepEqual(defaults.labels, {})

  const custom = normalizeSettings({
    audioDir: '  E:/clips  ',
    coalesceMs: 99_999,
    maxEvents: 1,
    extensions: ['.mp3', 'mp3', '.exe', '', 7, '.OGG'],
    labels: { 'a.mp3': '  A  ', '': 'x', b: 42 },
  })
  assert.equal(custom.audioDir, 'E:/clips')
  assert.equal(custom.coalesceMs, 10_000)
  assert.equal(custom.maxEvents, 4)
  // Only known audio extensions survive, normalised to lower case.
  assert.deepEqual(custom.extensions, ['.mp3', '.ogg'])
  assert.deepEqual(custom.labels, { 'a.mp3': 'A' })
  // An allowlist that filters to nothing falls back to the full default set.
  assert.deepEqual(normalizeSettings({ extensions: ['.exe'] }).extensions, defaults.extensions)
})

test('labels come from config, else the file name with provenance noise stripped', () => {
  assert.equal(labelFor('ciallo.mp3', { 'ciallo.mp3': 'ciallo' }), 'ciallo')
  assert.equal(labelFor(CLIP_NAME, {}), '你干嘛哎哟坤坤_耳聆网')
  assert.equal(labelFor('plain.mp3', {}), 'plain')
  assert.equal(labelFor('with space.ogg', {}), 'with space')
  assert.equal(labelFor('.mp3', {}), '.mp3')
  // A configured-but-blank label is ignored rather than rendering nothing.
  assert.equal(labelFor('a.mp3', { 'a.mp3': '   ' }), 'a')
})

/* ------------------------------------------------------------------ */
/* Library                                                              */
/* ------------------------------------------------------------------ */

test('the library lists only audio files, in a locale-independent order', () => {
  const tracks = listTracks(fixtureSettings())
  assert.deepEqual(tracks.map((track) => track.label), ['ciallo', '爱坤'])
  assert.deepEqual(tracks.map((track) => track.name), ['ciallo.mp3', CLIP_NAME])
  assert.equal(tracks[0].mime, 'audio/mpeg')
  assert.equal(tracks[0].bytes, MP3_BYTES.length)
  // A directory named like an audio file is not a track.
  assert.equal(tracks.some((track) => track.name === 'nested.mp3'), false)
  // A missing directory is an empty library, not a failure.
  assert.deepEqual(listTracks(normalizeSettings({ audioDir: join(AUDIO_DIR, 'nope') })), [])
})

test('resolveTrack refuses anything that is not one audio file in the library', () => {
  const settings = fixtureSettings()
  assert.ok(resolveTrack(AUDIO_DIR, 'ciallo.mp3', settings) !== null)
  assert.ok(resolveTrack(AUDIO_DIR, CLIP_NAME, settings) !== null)
  // Traversal, in every form the guard claims to cover.
  for (const attempt of [
    '../ciallo.mp3',
    '..\\ciallo.mp3',
    'nested/../ciallo.mp3',
    'sub/ciallo.mp3',
    '..',
    '.',
    '',
    '/etc/passwd',
    'C:/Windows/System32/drivers/etc/hosts',
    'ciallo.mp3\0.txt',
  ]) {
    assert.equal(resolveTrack(AUDIO_DIR, attempt, settings), null, `must refuse ${JSON.stringify(attempt)}`)
  }
  // Wrong extension, non-file, and absent names.
  assert.equal(resolveTrack(AUDIO_DIR, 'notes.txt', settings), null)
  assert.equal(resolveTrack(AUDIO_DIR, 'nested.mp3', settings), null)
  assert.equal(resolveTrack(AUDIO_DIR, 'missing.mp3', settings), null)
  // A directory outside the library is still inside its own root, so the
  // extension and file checks are what stop it there.
  assert.equal(resolveTrack(AUDIO_DIR, 'notes.txt', normalizeSettings({ audioDir: AUDIO_DIR, extensions: ['.txt'] })), null)
})

/* ------------------------------------------------------------------ */
/* Cue coalescing                                                       */
/* ------------------------------------------------------------------ */

/** A feed with a controllable scheduler, so no test waits a real window. */
function makeFeed(settings = fixtureSettings({ coalesceMs: 600 })) {
  const timers = new Set()
  const feed = new CueFeed(settings, {
    setTimer: (callback) => {
      const handle = { callback }
      timers.add(handle)
      return handle
    },
    clearTimer: (handle) => timers.delete(handle),
  })
  return {
    feed,
    pending: () => timers.size,
    /** Run whatever the window armed, as the event loop would. */
    fire: () => {
      for (const handle of [...timers]) {
        timers.delete(handle)
        handle.callback()
      }
    },
  }
}

test('a burst of completed turns publishes exactly one cue', () => {
  const { feed, pending, fire } = makeFeed()
  assert.equal(feed.latest, 0)
  // One task, three turns: the agent's own plus two subagents.
  feed.schedule({ sessionId: 's1', turn: 1, reason: 'completed' })
  feed.schedule({ sessionId: 'sub-a', turn: 1, reason: 'completed' })
  feed.schedule({ sessionId: 'sub-b', turn: 1, reason: 'completed' })
  assert.equal(pending(), 1, 'each event re-arms the window instead of adding one')
  assert.equal(feed.latest, 0, 'nothing is published before the window closes')
  fire()
  assert.equal(feed.latest, 1, 'the burst collapses to one cue')
  assert.deepEqual(feed.list(0).map((cue) => cue.sessionId), ['sub-b'], 'the last turn wins')
  assert.equal(feed.list(1).length, 0)
  assert.equal(pending(), 0)
})

test('separate tasks produce separate cues, and the log is bounded', () => {
  const { feed, fire } = makeFeed(fixtureSettings({ coalesceMs: 600, maxEvents: 4 }))
  for (let index = 0; index < 6; index += 1) {
    feed.schedule({ sessionId: `s${String(index)}`, turn: index, reason: 'completed' })
    fire()
  }
  assert.equal(feed.latest, 6)
  const cues = feed.list(0)
  assert.equal(cues.length, 4, 'the log keeps only maxEvents')
  assert.deepEqual(cues.map((cue) => cue.id), [3, 4, 5, 6])
  assert.deepEqual(feed.list(5).map((cue) => cue.id), [6])
})

test('a coalescing window with nothing in it publishes nothing, and dispose clears', () => {
  const { feed, pending, fire } = makeFeed()
  fire()
  assert.equal(feed.latest, 0)
  feed.schedule({ sessionId: 's1', turn: 1, reason: 'completed' })
  assert.equal(pending(), 1)
  feed.dispose()
  assert.equal(pending(), 0, 'dispose must clear the pending window')
  fire()
  assert.equal(feed.latest, 0)
  // Zero coalescing means every turn is its own cue.
  const immediate = makeFeed(fixtureSettings({ coalesceMs: 0 }))
  immediate.feed.schedule({ sessionId: 's1', turn: 1, reason: 'completed' })
  immediate.fire()
  assert.equal(immediate.feed.latest, 1)
})

/* ------------------------------------------------------------------ */
/* Range parsing                                                        */
/* ------------------------------------------------------------------ */

test('parseRange handles closed, open, suffix, and unusable ranges', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=100-', 1000), { start: 100, end: 999 })
  assert.deepEqual(parseRange('bytes=-50', 1000), { start: 950, end: 999 })
  // An end past the file is clamped rather than refused.
  assert.deepEqual(parseRange('bytes=990-2000', 1000), { start: 990, end: 999 })
  // A suffix longer than the file is the whole file.
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 })
  for (const header of [undefined, '', 'bytes=', 'bytes=-', 'bytes=1000-', 'items=0-1', 'bytes=5-1', 'bytes=a-b']) {
    assert.equal(parseRange(header, 1000), null, `must refuse ${JSON.stringify(header)}`)
  }
})

/* ------------------------------------------------------------------ */
/* Routes                                                               */
/* ------------------------------------------------------------------ */

const SAME_ORIGIN = { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' }

/** Call one handler and collect a minimal response. */
async function call(handler, { method = 'GET', url = '/', headers = SAME_ORIGIN } = {}) {
  const captured = { headers: {}, chunks: [] }
  const response = {
    writeHead: (status, responseHeaders) => {
      captured.status = status
      captured.headers = responseHeaders ?? {}
    },
    end: (body) => {
      captured.ended = true
      if (body !== undefined) captured.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
    },
  }
  await handler({ method, url, headers }, response)
  const raw = Buffer.concat(captured.chunks)
  let json
  if ((captured.headers['content-type'] ?? '').startsWith('application/json') && raw.length > 0) {
    json = JSON.parse(raw.toString('utf8'))
  }
  return { ...captured, body: raw, json }
}

test('the state route reports the library, and refuses other callers', async () => {
  const settings = fixtureSettings()
  const { feed } = makeFeed(settings)
  const handler = makeStateHandler(settings, feed)

  const ok = await call(handler, { url: STATE_PATH })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['cache-control'], 'no-store')
  assert.equal(ok.json.ok, true)
  assert.deepEqual(ok.json.tracks.map((track) => track.label), ['ciallo', '爱坤'])
  assert.equal(ok.json.latest, 0)
  // The absolute library path is deliberately not exposed.
  assert.doesNotMatch(JSON.stringify(ok.json), /dsh-audio-test/)

  assert.equal((await call(handler, { url: STATE_PATH, headers: { host: 'x', 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await call(handler, { url: STATE_PATH, headers: { host: 'x', origin: 'http://evil.test' } })).status, 403)
  assert.equal((await call(handler, { method: 'POST', url: STATE_PATH })).status, 405)
})

test('the cue route returns only what the cursor has not seen', async () => {
  const settings = fixtureSettings()
  const { feed, fire } = makeFeed(settings)
  const handler = makeEventsHandler(feed)

  const empty = await call(handler, { url: EVENTS_PATH })
  assert.deepEqual(empty.json.events, [])
  assert.equal(empty.json.latest, 0)

  feed.schedule({ sessionId: 's1', turn: 3, reason: 'completed' })
  fire()
  const first = await call(handler, { url: `${EVENTS_PATH}?since=0` })
  assert.equal(first.json.events.length, 1)
  assert.equal(first.json.latest, 1)
  const cue = first.json.events[0]
  assert.equal(cue.id, 1)
  assert.equal(cue.sessionId, 's1')
  assert.equal(cue.turn, 3)
  assert.equal(cue.reason, 'completed')
  assert.equal(typeof cue.at, 'number')

  // Re-polling at the cursor yields nothing: the client is up to date.
  const again = await call(handler, { url: `${EVENTS_PATH}?since=1` })
  assert.deepEqual(again.json.events, [])
  assert.equal(again.json.latest, 1)

  // A malformed cursor reads from the beginning rather than failing.
  assert.equal((await call(handler, { url: `${EVENTS_PATH}?since=abc` })).json.events.length, 1)
  assert.equal((await call(handler, { url: EVENTS_PATH, headers: { host: 'x', 'sec-fetch-site': 'cross-site' } })).status, 403)
})

test('the track route streams audio, honours Range, and hides refusals', async () => {
  const handler = makeTrackHandler(fixtureSettings())

  const full = await call(handler, { url: `${TRACK_PREFIX}/${encodeURIComponent(CLIP_NAME)}` })
  assert.equal(full.status, 200)
  assert.equal(full.headers['content-type'], 'audio/mpeg')
  assert.equal(full.headers['content-length'], MP3_BYTES.length)
  assert.equal(full.headers['accept-ranges'], 'bytes')
  assert.deepEqual(full.body, MP3_BYTES)

  // A range request answers 206 with the slice and its content-range.
  const ranged = await call(handler, { url: `${TRACK_PREFIX}/ciallo.mp3`, headers: { ...SAME_ORIGIN, range: 'bytes=0-9' } })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers['content-range'], `bytes 0-9/${String(MP3_BYTES.length)}`)
  assert.equal(ranged.headers['content-length'], 10)
  assert.deepEqual(ranged.body, MP3_BYTES.subarray(0, 10))

  // HEAD carries the headers and no body.
  const head = await call(handler, { method: 'HEAD', url: `${TRACK_PREFIX}/ciallo.mp3` })
  assert.equal(head.status, 200)
  assert.equal(head.body.length, 0)
  assert.equal(head.headers['content-length'], MP3_BYTES.length)

  // Every refusal is the same 404: missing, outside the library, not audio.
  for (const url of [
    `${TRACK_PREFIX}/missing.mp3`,
    `${TRACK_PREFIX}/notes.txt`,
    `${TRACK_PREFIX}/nested.mp3`,
    `${TRACK_PREFIX}/${encodeURIComponent('../ciallo.mp3')}`,
    `${TRACK_PREFIX}/${encodeURIComponent('a/b.mp3')}`,
    TRACK_PREFIX,
    `${TRACK_PREFIX}/`,
  ]) {
    assert.equal((await call(handler, { url })).status, 404, `must 404 ${url}`)
  }
  assert.equal((await call(handler, { method: 'POST', url: `${TRACK_PREFIX}/ciallo.mp3` })).status, 405)
  assert.equal((await call(handler, { url: `${TRACK_PREFIX}/ciallo.mp3`, headers: { host: 'x', 'sec-fetch-site': 'cross-site' } })).status, 403)
})

/* ------------------------------------------------------------------ */
/* Activation                                                           */
/* ------------------------------------------------------------------ */

test('apply watches completed turns and registers all three routes', () => {
  const effects = []
  const routes = []
  const listeners = new Map()
  const ctx = {
    logger: { warn: () => {} },
    effect: (execute, label) => {
      const dispose = execute()
      effects.push({ label, dispose })
      return () => dispose?.()
    },
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx, { audioDir: AUDIO_DIR, coalesceMs: 0, labels: { 'ciallo.mp3': 'ciallo' } })

  assert.deepEqual(routes.map((route) => [route.kind, route.path]), [
    ['exact', STATE_PATH],
    ['exact', EVENTS_PATH],
    ['prefix', TRACK_PREFIX],
  ])
  for (const route of routes) assert.equal(typeof route.handler, 'function')
  assert.deepEqual(effects.map((entry) => entry.label), [
    'dsh-audio-reward: completed-turn feed',
    'dsh-audio-reward: library route',
    'dsh-audio-reward: cue route',
    'dsh-audio-reward: audio route',
  ])

  // Only `turn/end` becomes a cue; nothing else in the Session stream does.
  const onSessionEvent = listeners.get('session/event')
  assert.equal(typeof onSessionEvent, 'function')
  const feed = makeFeed(normalizeSettings({ audioDir: AUDIO_DIR, coalesceMs: 0 }))
  void feed
  for (const event of [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: {} },
    { type: 'tool/result', data: {} },
    { type: 'step/end', data: {} },
  ]) {
    onSessionEvent({ id: 's1' }, event)
  }
  const eventsHandler = routes[1].handler
  return call(eventsHandler, { url: EVENTS_PATH }).then((response) => {
    assert.deepEqual(response.json.events, [], 'only turn/end produces a cue')
    onSessionEvent({ id: 's1' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    return call(eventsHandler, { url: EVENTS_PATH })
  }).then((response) => {
    assert.equal(response.json.events.length, 1)
    assert.equal(response.json.events[0].sessionId, 's1')
    assert.equal(response.json.events[0].turn, 2)
    assert.equal(response.json.events[0].reason, 'completed')
    // A missing Session still records the cue rather than throwing.
    onSessionEvent(undefined, { type: 'turn/end' })
    return call(eventsHandler, { url: EVENTS_PATH })
  }).then((response) => {
    assert.equal(response.json.events.length, 2)
    assert.equal(response.json.events[1].sessionId, null)
    assert.equal(response.json.events[1].turn, null)
    assert.equal(response.json.events[1].reason, null)
    // Disposal removes the listener and drops any pending window.
    for (const entry of effects) entry.dispose()
    assert.equal(listeners.has('session/event'), false)
  })
})
