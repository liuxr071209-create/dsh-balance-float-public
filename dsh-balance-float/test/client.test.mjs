/**
 * Browser-half tests.
 *
 * `client.js` is a page script: it registers a lazy factory with the module
 * loader, and its plugin body runs against a real Cordis context in the page.
 * Here a stub loader captures the definition, a stub `react` satisfies the
 * factory's single import, and a stub context records what `apply` registers —
 * enough to exercise the whole contribution path without a browser.
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { nextChangeAt as hostNextChangeAt, periodAt as hostPeriodAt } from '../index.js'

/** The Host half's default rule, which the browser half must mirror. */
const BEIJING = { utcOffsetMinutes: 480, peakWindows: [[540, 720], [840, 1080]] }

/** Epoch milliseconds for a Beijing wall-clock time. */
function beijing(year, month, day, hours, minutes) {
  return Date.UTC(year, month - 1, day, hours, minutes) - 480 * 60_000
}

let importCounter = 0

/** Install the page globals `client.js` expects, then load a fresh instance. */
async function loadClientHalf() {
  const definitions = []
  const storage = new Map()
  const windowStub = {
    __ModuleLoader__: { load: (definition) => definitions.push(definition) },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.window = windowStub
  globalThis.document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} }

  // The query string gives each test its own module instance, so the top-level
  // loader call runs again instead of being served from the import cache.
  importCounter += 1
  await import(`../client.js?instance=${importCounter}`)

  assert.equal(definitions.length, 1, 'the bundle must register exactly one factory')
  const definition = definitions[0]
  assert.equal(definition.id, 'dsh-balance-float')
  assert.equal(typeof definition.factory, 'function')
  return { definition, windowStub, storage }
}

after(() => {
  delete globalThis.window
  delete globalThis.document
})

/** The factory only reads `createElement` and hook names; nothing renders here. */
function makeReactStub() {
  const stub = { createElement: (type, props, ...children) => ({ type, props, children }) }
  for (const name of ['useState', 'useRef', 'useEffect', 'useCallback', 'useSyncExternalStore']) {
    stub[name] = () => undefined
  }
  return stub
}

/** A context stub recording effects, slot registrations, and service injects. */
function makeCtxStub() {
  const effects = []
  const registrations = []
  const injections = []
  let dictionary = null
  const localeCtx = {
    effect: (execute) => {
      const dispose = execute()
      return () => dispose?.()
    },
    locale: {
      register: (namespace, dicts) => {
        dictionary = { namespace, dicts }
        return () => {}
      },
      bind: (namespace) => (key, params) => {
        const template = dictionary?.dicts?.zh?.[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      },
      subscribe: () => () => {},
    },
  }
  const ctx = {
    effect: (execute, label) => {
      const dispose = execute()
      effects.push({ label, dispose })
      return () => dispose?.()
    },
    inject: (services, callback) => {
      injections.push(services)
      callback(localeCtx)
    },
    slots: {
      inject: (key, callback) => {
        const entry = { key }
        registrations.push(entry)
        entry.contribution = callback()
      },
      register: (options, component) => {
        const entry = registrations.at(-1)
        entry.options = options
        entry.component = component
        return () => {}
      },
    },
  }
  return { ctx, effects, registrations, injections, dictionary: () => dictionary }
}

/** Queue a macrotask boundary so the plugin's floating `load()` settles. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('the bundle contributes one overlay entry with lifecycle-owned resources', async () => {
  const { definition, windowStub } = await loadClientHalf()
  const plugin = definition.factory((id) => {
    assert.equal(id, 'react')
    return makeReactStub()
  })
  assert.equal(plugin.name, 'dsh-balance-float')
  assert.deepEqual(plugin.inject, ['slots'])

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    // The timestamp is appended only by the refresh path; the poll path asks for
    // the cached snapshot, so the browser must not hammer the Host.
    assert.ok(String(url) === '/api/dsh-balance-float/state' || String(url).endsWith('?refresh=1'))
    assert.equal(init.cache, 'no-store')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        status: 'ok',
        balance: {
          currency: 'CNY',
          totalBalance: 42.8,
          grantedBalance: 2.8,
          toppedUpBalance: 40,
          available: true,
          updatedAt: Date.now(),
        },
        error: null,
        schedule: { timeZone: 'fixed-offset', utcOffsetMinutes: 480, peakWindows: [[540, 720], [840, 1080]] },
        period: 'offPeak',
        periodEndsAt: null,
        serverTime: Date.now(),
      }),
    }
  }
  try {
    const harness = makeCtxStub()
    plugin.apply(harness.ctx)

    // Visible text is routed through the Client locale service when it exists.
    assert.deepEqual(harness.injections, [['locale']])
    const dictionary = harness.dictionary()
    assert.equal(dictionary.namespace, 'dsh-balance-float')
    assert.equal(typeof dictionary.dicts.zh.title, 'string')
    assert.equal(typeof dictionary.dicts.en.title, 'string')
    assert.deepEqual(Object.keys(dictionary.dicts.zh).sort(), Object.keys(dictionary.dicts.en).sort())

    // Exactly one contribution, into the frame-wide overlay seat.
    assert.equal(harness.registrations.length, 1)
    const registration = harness.registrations[0]
    assert.equal(registration.key, 'shell.overlay')
    assert.equal(registration.options.name, 'shell.overlay')
    assert.equal(registration.options.id, 'dsh-balance-float')
    assert.equal(typeof registration.component, 'function')
    assert.equal(typeof registration.options.inject, 'function')
    const face = registration.options.inject()
    assert.ok(face.runtime, 'the inject face must hand the component its runtime')
    assert.equal(typeof face.runtime.refresh, 'function')
    assert.equal(typeof face.runtime.schedule, 'function')
    assert.equal(typeof face.runtime.emit, 'function')

    // Plugin-level resources are effects with disposers, not free-floating state.
    assert.deepEqual(harness.effects.map((entry) => entry.label), [
      'dsh-balance-float: snapshot polling and clock',
      'dsh-balance-float: public api',
    ])
    for (const entry of harness.effects) assert.equal(typeof entry.dispose, 'function')

    // The public seam is published and readable.
    const api = windowStub.__DSH_BALANCE_FLOAT__
    assert.ok(api, 'window.__DSH_BALANCE_FLOAT__ must be published')
    assert.equal(api.version, 1)
    assert.equal(typeof api.on, 'function')
    assert.equal(typeof api.setStage, 'function')

    // The clock helpers answer from the Host-published rule.
    assert.equal(api.periodAt(beijing(2026, 9, 7, 9, 30)), 'peak')
    assert.equal(api.periodAt(beijing(2026, 9, 7, 12, 30)), 'offPeak')
    assert.equal(api.periodAt(beijing(2026, 9, 12, 10, 0)), 'offPeak')
    assert.equal(api.nextChangeAt(beijing(2026, 9, 7, 8, 0)), beijing(2026, 9, 7, 9, 0))

    // The polling effect dispatches the first read.
    await settle()
    const state = api.getState()
    assert.equal(state.snapshot.status, 'ok')
    assert.equal(state.snapshot.balance.totalBalance, 42.8)
    assert.deepEqual(state.schedule.peakWindows, [[540, 720], [840, 1080]])

    // Skins drive the root attribute and the reserved art stage through the seam.
    const events = []
    api.on('skin', (payload) => events.push(['skin', payload]))
    api.on('stage', (payload) => events.push(['stage', payload]))
    api.setSkin('orca-link')
    assert.equal(api.getSkin(), 'orca-link')
    assert.equal(windowStub.localStorage.getItem('dsh-balance-float:skin'), 'orca-link')
    api.setStage({ src: 'data:image/gif;base64,R0lGOD', alt: 'whale' })
    assert.deepEqual(api.getStage(), { kind: 'image', src: 'data:image/gif;base64,R0lGOD', alt: 'whale' })
    api.setStage(null)
    assert.equal(api.getStage(), null)
    assert.deepEqual(events.map(([name]) => name), ['skin', 'stage', 'stage'])

    // An unsubscribed handler stops receiving events.
    const unsubscribed = []
    const off = api.on('skin', () => unsubscribed.push(1))
    off()
    api.setSkin('default')
    assert.deepEqual(unsubscribed, [])

    // Disposal withdraws the global; the registration's own cleanup is the
    // slot's business and is exercised by the runtime, not by this stub.
    for (const entry of harness.effects) entry.dispose()
    assert.equal(windowStub.__DSH_BALANCE_FLOAT__, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an unreachable route still leaves peak/valley working', async () => {
  const { definition, windowStub } = await loadClientHalf()
  const plugin = definition.factory(() => makeReactStub())
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })
  try {
    const harness = makeCtxStub()
    plugin.apply(harness.ctx)
    await settle()
    const state = windowStub.__DSH_BALANCE_FLOAT__.getState()
    assert.equal(state.snapshot.status, 'error')
    assert.match(state.snapshot.error, /HTTP 503/)
    // No Host rule arrived, so the built-in default answers.
    assert.deepEqual(state.schedule.peakWindows, [[540, 720], [840, 1080]])
    assert.equal(windowStub.__DSH_BALANCE_FLOAT__.periodAt(beijing(2026, 9, 7, 9, 30)), 'peak')
    for (const entry of harness.effects) entry.dispose()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('both halves classify the same rule identically, a week long', async () => {
  const { definition, windowStub } = await loadClientHalf()
  const plugin = definition.factory(() => makeReactStub())
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
  try {
    const harness = makeCtxStub()
    plugin.apply(harness.ctx)
    const api = windowStub.__DSH_BALANCE_FLOAT__
    // With no Host response the browser half uses the same default rule the
    // Host would publish, so the two implementations are directly comparable.
    assert.equal(api.getState().schedule.utcOffsetMinutes, BEIJING.utcOffsetMinutes)
    assert.deepEqual(api.getState().schedule.peakWindows, BEIJING.peakWindows)

    const weekStart = Date.UTC(2026, 8, 7, 0, 0)
    for (let minute = 0; minute < 7 * 24 * 60; minute += 7) {
      const timestamp = weekStart + minute * 60_000
      assert.equal(api.periodAt(timestamp), hostPeriodAt(timestamp, BEIJING), `period at ${new Date(timestamp).toISOString()}`)
    }
    for (let minute = 0; minute < 7 * 24 * 60; minute += 23) {
      const timestamp = weekStart + minute * 60_000
      assert.equal(
        api.nextChangeAt(timestamp),
        hostNextChangeAt(timestamp, BEIJING),
        `next change at ${new Date(timestamp).toISOString()}`,
      )
    }
    for (const entry of harness.effects) entry.dispose()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('another plugin can put a panel in the card, ordered and replaceable', async () => {
  const { definition, windowStub } = await loadClientHalf()
  const plugin = definition.factory(() => makeReactStub())
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
  try {
    const harness = makeCtxStub()
    plugin.apply(harness.ctx)
    const api = windowStub.__DSH_BALANCE_FLOAT__
    assert.equal(typeof api.registerPanel, 'function')
    assert.deepEqual(api.listPanels(), [])

    /* The panel list the card renders lives in the same store the component
       subscribes to, so read it through the inject face the card was given. */
    const face = harness.registrations.at(-1).options.inject()
    const panels = () => face.runtime.store.getSnapshot().panels

    const disposeChannel = api.registerPanel({ id: 'channel', order: 20, render: () => 'channel' })
    const disposeSkin = api.registerPanel({ id: 'skin', order: 10, render: () => 'skin' })
    // Sorted by order, not by registration sequence.
    assert.deepEqual(panels().map((panel) => panel.id), ['skin', 'channel'])
    assert.deepEqual(api.listPanels().sort(), ['channel', 'skin'])

    // Re-registering an id replaces that panel, which is how a panel with state
    // refreshes itself without the card knowing anything about it.
    const second = () => 'channel-2'
    api.registerPanel({ id: 'channel', order: 20, render: second })
    assert.equal(panels().length, 2)
    assert.equal(panels().find((panel) => panel.id === 'channel').render, second)

    // Unregistering by id removes whatever is currently registered under it.
    disposeChannel()
    assert.equal(panels().length, 1)
    assert.deepEqual(api.listPanels(), ['skin'])

    // Malformed registrations are refused rather than crashing the card.
    for (const bad of [null, undefined, 42, {}, { id: 'x' }, { render: () => null }, { id: '', render: () => null }]) {
      const dispose = api.registerPanel(bad)
      assert.equal(typeof dispose, 'function', 'a refusal still returns a disposer')
      assert.deepEqual(api.listPanels(), ['skin'], `must refuse ${JSON.stringify(bad)}`)
    }

    // Unloading the card withdraws both the global and every panel.
    for (const entry of harness.effects) entry.dispose()
    assert.equal(windowStub.__DSH_BALANCE_FLOAT__, undefined)
    disposeSkin()
    assert.equal(panels().length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
