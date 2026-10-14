/**
 * Browser-half tests.
 *
 * `client.js` is a page script: it registers a lazy factory with the module
 * loader. Here a stub loader captures the definition, a stub `react` and a stub
 * `Audio` stand in for the page, and a stub context records what `apply` owns —
 * so the cue path, the autoplay refusal path, and the panel registration into
 * the balance card are all exercised without a browser.
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

const STATE_PATH = '/api/dsh-audio-reward/state'
const EVENTS_PATH = '/api/dsh-audio-reward/events'
const TRACK_PREFIX = '/api/dsh-audio-reward/track'
const HOST_GLOBAL = '__DSH_BALANCE_FLOAT__'
const HOST_READY_EVENT = 'dsh-balance-float:ready'

let importCounter = 0

/** Records every constructed element and every `play()` attempt. */
class FakeAudio {
  static instances = []
  static response = () => Promise.resolve()

  constructor() {
    FakeAudio.instances.push(this)
    this.src = ''
    this.currentTime = 0
    this.playCount = 0
  }

  pause() {}

  play() {
    this.playCount += 1
    return FakeAudio.response()
  }
}

/** A localStorage-shaped store a test can inspect. */
function makeStorage(seed = {}) {
  const entries = new Map(Object.entries(seed))
  return {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
    entries,
  }
}

/** Load a fresh browser-half instance with page stubs installed. */
async function loadPlugin({ storage = makeStorage(), host = null, responses = {} } = {}) {
  const definitions = []
  const windowListeners = new Map()
  const windowStub = {
    __ModuleLoader__: { load: (definition) => definitions.push(definition) },
    localStorage: storage,
    addEventListener: (name, handler) => {
      if (!windowListeners.has(name)) windowListeners.set(name, new Set())
      windowListeners.get(name).add(handler)
    },
    removeEventListener: (name, handler) => {
      windowListeners.get(name)?.delete(handler)
    },
    dispatchEvent: (event) => {
      for (const handler of [...(windowListeners.get(event.type) ?? [])]) handler(event)
      return true
    },
  }
  if (host !== null) windowStub[HOST_GLOBAL] = host

  const documentListeners = new Map()
  const documentStub = {
    visibilityState: 'visible',
    addEventListener: (name, handler) => {
      if (!documentListeners.has(name)) documentListeners.set(name, new Set())
      documentListeners.get(name).add(handler)
    },
    removeEventListener: (name, handler) => {
      documentListeners.get(name)?.delete(handler)
    },
  }

  /** Responses are looked up by pathname so a test can change one mid-run. */
  const state = { responses, requests: [] }
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Audio: globalThis.Audio,
    fetch: globalThis.fetch,
  }
  globalThis.window = windowStub
  globalThis.document = documentStub
  globalThis.Audio = FakeAudio
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'http://host')
    state.requests.push(`${parsed.pathname}${parsed.search}`)
    const body = state.responses[parsed.pathname]
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => (typeof body === 'function' ? body(parsed) : body) }
  }

  importCounter += 1
  await import(`../client.js?instance=${importCounter}`)
  const plugin = definitions[0].factory((id) => {
    assert.equal(id, 'react')
    return makeReactStub()
  })

  const effects = []
  const ctx = {
    effect: (execute, label) => {
      const dispose = execute()
      effects.push({ label, dispose })
      return () => dispose?.()
    },
    inject: () => {},
  }
  FakeAudio.instances = []
  plugin.apply(ctx)

  /** Queue a macrotask so floating `loadLibrary()`/`pollCues()` settle. */
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  let disposed = false
  return {
    plugin,
    storage,
    windowStub,
    documentStub,
    state,
    effects,
    settle,
    audio: () => FakeAudio.instances,
    fireDocument: (name, event = {}) => {
      for (const handler of [...(documentListeners.get(name) ?? [])]) handler(event)
    },
    /** Idempotent, so a test's `finally` is safe after an inline dispose. */
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const entry of effects) entry.dispose()
      globalThis.window = previous.window
      globalThis.document = previous.document
      globalThis.Audio = previous.Audio
      globalThis.fetch = previous.fetch
    },
  }
}

function makeReactStub() {
  /* Real React flattens nested child arrays; the panel passes its options as
     one array, so the stub must too or the tree it returns is not the tree the
     browser builds. */
  const stub = { createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }) }
  for (const name of ['useState', 'useRef', 'useEffect', 'useCallback', 'useSyncExternalStore']) stub[name] = () => undefined
  return stub
}

/** A stand-in for the balance card's `registerPanel` seat. */
function makeHostSeat() {
  const registrations = []
  const panels = new Map()
  return {
    registrations,
    panels,
    registerPanel(panel) {
      registrations.push(panel)
      panels.set(panel.id, panel)
      return () => panels.delete(panel.id)
    },
  }
}

/** Walk a stubbed element tree looking for a node type. */
function findNode(node, type) {
  if (node === null || typeof node !== 'object') return null
  if (node.type === type) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, type)
    if (found !== null) return found
  }
  return null
}

const TRACKS = {
  tracks: [
    { name: 'ciallo.mp3', label: 'ciallo', bytes: 10, mime: 'audio/mpeg' },
    { name: 'kunkun.mp3', label: '爱坤', bytes: 10, mime: 'audio/mpeg' },
  ],
  latest: 0,
  serverTime: 1,
}
const NO_CUES = { events: [], latest: 0, serverTime: 1 }

after(() => {
  delete globalThis.window
  delete globalThis.document
  delete globalThis.Audio
})

/* ------------------------------------------------------------------ */
/* Panel registration                                                   */
/* ------------------------------------------------------------------ */

test('the chooser registers into the balance card, not a window of its own', async () => {
  const seat = makeHostSeat()
  const harness = await loadPlugin({
    host: seat,
    responses: { [STATE_PATH]: TRACKS, [EVENTS_PATH]: NO_CUES },
  })
  try {
    assert.equal(seat.registrations.length, 1)
    const panel = seat.registrations[0]
    assert.equal(panel.id, 'dsh-audio-reward-chooser')
    assert.equal(typeof panel.render, 'function')
    assert.equal(panel.order, 20)

    await harness.settle()
    await harness.settle()
    // The registration is refreshed once the library arrives, so the rendered
    // panel is the latest one.
    const latest = seat.registrations.at(-1)
    const node = latest.render()
    const select = findNode(node, 'select')
    assert.ok(select !== null, 'the panel must offer a chooser')
    const values = select.children.map((option) => option.props.value)
    assert.deepEqual(values, ['', 'ciallo.mp3', 'kunkun.mp3'])
    assert.deepEqual(select.children.map((option) => option.children[0]), ['关闭', 'ciallo', '爱坤'])
    // Default on, first track selected: the cue is the point of the plugin.
    assert.equal(select.props.value, 'ciallo.mp3')
  } finally {
    harness.dispose()
  }
})

test('a card that loads later is picked up through the ready handshake', async () => {
  const harness = await loadPlugin({ host: null, responses: { [STATE_PATH]: TRACKS, [EVENTS_PATH]: NO_CUES } })
  try {
    await harness.settle()
    const api = harness.windowStub.__DSH_AUDIO_REWARD__
    assert.equal(api.getState().attached, false, 'nothing to attach to yet')

    // The card announces itself.
    const seat = makeHostSeat()
    harness.windowStub[HOST_GLOBAL] = seat
    harness.windowStub.dispatchEvent({ type: HOST_READY_EVENT, detail: seat })
    assert.equal(seat.registrations.length, 1)
    assert.equal(api.getState().attached, true)
  } finally {
    harness.dispose()
  }
})

test('disposal detaches the panel and clears the host global', async () => {
  const seat = makeHostSeat()
  const harness = await loadPlugin({ host: seat, responses: { [STATE_PATH]: TRACKS, [EVENTS_PATH]: NO_CUES } })
  assert.equal(seat.panels.size, 1)
  harness.dispose()
  assert.equal(seat.panels.size, 0)
  assert.equal(harness.windowStub.__DSH_AUDIO_REWARD__, undefined)
})

/* ------------------------------------------------------------------ */
/* Cue path                                                             */
/* ------------------------------------------------------------------ */

test('the first poll adopts the cursor instead of replaying history', async () => {
  const harness = await loadPlugin({
    responses: {
      [STATE_PATH]: TRACKS,
      // The Host already holds 7 cues from earlier in the session.
      [EVENTS_PATH]: { events: [{ id: 7, sessionId: 'old', turn: 1, reason: 'completed', at: 1 }], latest: 7, serverTime: 1 },
    },
  })
  try {
    await harness.settle()
    await harness.settle()
    const api = harness.windowStub.__DSH_AUDIO_REWARD__
    assert.equal(api.getState().cursor, 7, 'the cursor starts where the Host is')
    assert.equal(harness.audio().length, 0, 'opening the page must not make noise')
    assert.ok(harness.state.requests.some((request) => request === `${EVENTS_PATH}?since=0`))
  } finally {
    harness.dispose()
  }
})

test('a new cue plays the selected clip, and an off chooser plays nothing', async () => {
  const responses = { [STATE_PATH]: TRACKS, [EVENTS_PATH]: NO_CUES }
  const harness = await loadPlugin({ responses })
  try {
    await harness.settle()
    await harness.settle()
    const api = harness.windowStub.__DSH_AUDIO_REWARD__
    assert.equal(api.getState().cursor, 0)
    assert.equal(harness.audio().length, 0)

    // The agent finishes a task: one coalesced cue arrives.
    responses[EVENTS_PATH] = { events: [{ id: 1, sessionId: 's1', turn: 2, reason: 'completed', at: 9 }], latest: 1, serverTime: 9 }
    harness.fireDocument('visibilitychange')
    await harness.settle()
    await harness.settle()

    assert.equal(harness.audio().length, 1, 'one audio element is created and reused')
    const element = harness.audio()[0]
    assert.equal(element.src, `${TRACK_PREFIX}/${encodeURIComponent('ciallo.mp3')}`)
    assert.equal(element.playCount, 1)
    assert.equal(api.getState().cursor, 1)

    // The chooser can be turned off, and then a cue stays silent.
    api.setTrack('')
    assert.equal(api.getState().enabled, false)
    responses[EVENTS_PATH] = { events: [{ id: 2, sessionId: 's2', turn: 1, reason: 'completed', at: 10 }], latest: 2, serverTime: 10 }
    harness.fireDocument('visibilitychange')
    await harness.settle()
    await harness.settle()
    assert.equal(element.playCount, 1, 'off means off')
    assert.equal(api.getState().cursor, 2, 'but the cursor still advances')

    // Selecting a different clip persists and plays that one.
    api.setTrack('kunkun.mp3')
    assert.equal(harness.storage.getItem('dsh-audio-reward:track'), 'kunkun.mp3')
    assert.equal(harness.storage.getItem('dsh-audio-reward:enabled'), '1')
    api.preview()
    assert.equal(element.src, `${TRACK_PREFIX}/${encodeURIComponent('kunkun.mp3')}`)
    assert.equal(element.playCount, 2)
  } finally {
    harness.dispose()
  }
})

test('a refused autoplay is reported and retried on the next gesture', async () => {
  const responses = { [STATE_PATH]: TRACKS, [EVENTS_PATH]: NO_CUES }
  const harness = await loadPlugin({ responses })
  try {
    await harness.settle()
    await harness.settle()
    const api = harness.windowStub.__DSH_AUDIO_REWARD__

    // The browser refuses sound because the cue came from the Host, not a click.
    const refused = Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
    FakeAudio.response = () => Promise.reject(refused)

    responses[EVENTS_PATH] = { events: [{ id: 1, sessionId: 's1', turn: 1, reason: 'completed', at: 5 }], latest: 1, serverTime: 5 }
    harness.fireDocument('visibilitychange')
    await harness.settle()
    await harness.settle()
    assert.equal(api.getState().status, 'blocked', 'the panel must say autoplay was refused')
    assert.equal(harness.audio()[0].playCount, 1)

    // The user clicks anywhere: the pending cue is retried and now allowed.
    FakeAudio.response = () => Promise.resolve()
    harness.fireDocument('pointerdown')
    await harness.settle()
    assert.equal(harness.audio()[0].playCount, 2, 'the cue is retried once')
    assert.equal(api.getState().status, 'playing', 'a retried cue is still a cue')
    // The retry is one-shot: a later gesture does not replay it.
    harness.fireDocument('pointerdown')
    await harness.settle()
    assert.equal(harness.audio()[0].playCount, 2, 'no replay without a new cue')
  } finally {
    FakeAudio.response = () => Promise.resolve()
    harness.dispose()
  }
})

test('the Host names the default clip, so a fresh install is deliberate', async () => {
  const preferred = await loadPlugin({
    responses: { [STATE_PATH]: { ...TRACKS, defaultTrack: 'kunkun.mp3' }, [EVENTS_PATH]: NO_CUES },
  })
  try {
    await preferred.settle()
    await preferred.settle()
    assert.equal(preferred.windowStub.__DSH_AUDIO_REWARD__.getState().track, 'kunkun.mp3')
  } finally {
    preferred.dispose()
  }

  // A name that is not in the library falls back to the first entry, not to
  // "off" and not to a broken selection.
  const unknown = await loadPlugin({
    responses: { [STATE_PATH]: { ...TRACKS, defaultTrack: 'missing.mp3' }, [EVENTS_PATH]: NO_CUES },
  })
  try {
    await unknown.settle()
    await unknown.settle()
    const state = unknown.windowStub.__DSH_AUDIO_REWARD__.getState()
    assert.equal(state.track, 'ciallo.mp3')
    assert.equal(state.enabled, true)
  } finally {
    unknown.dispose()
  }
})

test('an empty library is reported, and a vanished selection falls back', async () => {
  const responses = {
    [STATE_PATH]: { tracks: [], latest: 0, serverTime: 1 },
    [EVENTS_PATH]: NO_CUES,
  }
  const harness = await loadPlugin({ responses })
  try {
    await harness.settle()
    await harness.settle()
    const api = harness.windowStub.__DSH_AUDIO_REWARD__
    assert.equal(api.getState().status, 'empty')
    assert.equal(api.getState().track, null)

    // Files appear: the next library read picks a default.
    responses[STATE_PATH] = TRACKS
    api.reload()
    await harness.settle()
    assert.equal(api.getState().track, 'ciallo.mp3')
    assert.equal(harness.storage.getItem('dsh-audio-reward:track'), 'ciallo.mp3')

    // The user picks the other one, then that file disappears.
    api.setTrack('kunkun.mp3')
    assert.equal(api.getState().track, 'kunkun.mp3')
    responses[STATE_PATH] = { tracks: [TRACKS.tracks[0]], latest: 0, serverTime: 2 }
    api.reload()
    await harness.settle()
    assert.equal(api.getState().track, 'ciallo.mp3', 'a vanished selection falls back to a real file')
    assert.equal(harness.storage.getItem('dsh-audio-reward:track'), 'ciallo.mp3')

    // A deliberate "off" is never overridden by a library read.
    api.setTrack('')
    assert.equal(harness.storage.getItem('dsh-audio-reward:enabled'), '0')
    api.reload()
    await harness.settle()
    assert.equal(api.getState().enabled, false, 'off stays off')
    assert.equal(api.getState().track, null)
  } finally {
    harness.dispose()
  }
})
