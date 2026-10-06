/**
 * Gesture tests for the floating card.
 *
 * The card's drag surface is the whole window and a press becomes a drag by
 * being held or by travelling past a tolerance. That rule lives in plain
 * functions and a plain state machine so it can be driven here with a fake
 * clock — no React, no DOM, no pointer.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { periodAt } from '../index.js'

/** The Host half's rule, mirrored by the browser half's fallback. */
const BEIJING = { utcOffsetMinutes: 480, peakWindows: [[540, 720], [840, 1080]] }

let importCounter = 0

/** Load a fresh browser-half instance and hand back its plugin. */
async function loadPlugin() {
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
  importCounter += 1
  await import(`../client.js?gesture=${importCounter}`)

  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  for (const name of ['useState', 'useRef', 'useEffect', 'useCallback', 'useSyncExternalStore']) React[name] = () => undefined
  const plugin = definitions[0].factory(() => React)

  const effects = []
  const ctx = {
    effect: (execute, label) => {
      const dispose = execute()
      effects.push({ label, dispose })
      return () => dispose?.()
    },
    inject: () => {},
    slots: { inject: () => {}, register: () => () => {} },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
  plugin.apply(ctx)
  const api = windowStub.__DSH_BALANCE_FLOAT__
  return {
    api,
    storage,
    dispose: () => {
      for (const entry of effects) entry.dispose()
      globalThis.fetch = originalFetch
    },
  }
}

const LAYER = { width: 1000, height: 700 }
const CARD = { width: 200, height: 120 }
/** The legal offsets for a 200x120 card inside a 1000x700 frame. */
const BOUNDS = { maxX: LAYER.width - CARD.width, maxY: LAYER.height - CARD.height }
/** A press inside the card, expressed the way the component measures it. */
const PRESS = {
  pointerId: 7,
  startX: 900,
  startY: 60,
  originX: 800,
  originY: 20,
  bounds: BOUNDS,
}

/**
 * Build a machine with a controllable clock and scheduler, and record its
 * effects. Injecting both is what makes the hold deterministic: no test waits
 * a real 280 ms, and a test can still prove the timer was armed and cleared.
 */
function makeMachine(api, startAt = 1_000) {
  const log = []
  let clock = startAt
  const timers = new Set()
  const machine = api.gesture.createDragMachine({
    holdMs: api.gesture.holdMs,
    moveTolerance: api.gesture.moveTolerance,
    onEngage: (pointerId) => log.push(['engage', pointerId]),
    now: () => clock,
    setTimer: (callback) => {
      const handle = { callback }
      timers.add(handle)
      return handle
    },
    clearTimer: (handle) => timers.delete(handle),
  })
  return {
    machine,
    log,
    advance: (ms) => {
      clock += ms
    },
    /** Run whatever the hold armed, as the event loop would. */
    fire: () => {
      for (const handle of [...timers]) {
        timers.delete(handle)
        handle.callback()
      }
    },
    pending: () => timers.size,
    at: () => clock,
  }
}

test('the card publishes the gesture rule it uses', async () => {
  const { api, dispose } = await loadPlugin()
  try {
    assert.equal(typeof api.gesture, 'object')
    assert.equal(api.gesture.holdMs, 280)
    assert.equal(api.gesture.moveTolerance, 12)
    for (const name of ['isDragGesture', 'clampToFrame', 'measureFrame', 'createDragMachine']) {
      assert.equal(typeof api.gesture[name], 'function', `gesture.${name} must be callable`)
    }
  } finally {
    dispose()
  }
})

test('a press becomes a drag by holding or by travelling, never by accident', async () => {
  const { api, dispose } = await loadPlugin()
  try {
    const { holdMs, moveTolerance, isDragGesture } = api.gesture
    // Holding long enough is a drag, even with the pointer perfectly still.
    assert.equal(isDragGesture(holdMs, 0), true)
    assert.equal(isDragGesture(holdMs - 1, 0), false)
    // So is travelling past the tolerance.
    assert.equal(isDragGesture(0, moveTolerance + 1), true)
    assert.equal(isDragGesture(0, moveTolerance), false)
    // A short press that barely moves stays a click.
    assert.equal(isDragGesture(50, moveTolerance), false)
  } finally {
    dispose()
  }
})

test('holding still on the card engages the drag without any movement', async () => {
  const { api, dispose } = await loadPlugin()
  try {
    const { machine, log, advance, fire, pending } = makeMachine(api)
    assert.equal(machine.down(PRESS), true)
    assert.equal(machine.pressing, true)
    assert.equal(machine.engaged, false)
    assert.equal(pending(), 1, 'the press must arm exactly one hold timer')
    // The pointer never moves; only time passes, then the hold fires.
    advance(api.gesture.holdMs)
    fire()
    assert.deepEqual(log, [['engage', PRESS.pointerId]])
    assert.equal(machine.engaged, true)
    assert.equal(pending(), 0, 'engaging consumes the hold timer')
    // Movement now tracks the pointer from the geometry measured at press time.
    assert.deepEqual(machine.move({ pointerId: PRESS.pointerId, x: 870, y: 80 }), { x: 770, y: 40 })
  } finally {
    dispose()
  }
})

test('a quick drag past the tolerance engages immediately, without waiting', async () => {
  const { api, dispose } = await loadPlugin()
  try {
    const { machine, log } = makeMachine(api)
    machine.down(PRESS)
    // Well under the hold window, but the pointer travelled far enough.
    const position = machine.move({ pointerId: PRESS.pointerId, x: 900 - 40, y: 60 })
    assert.deepEqual(log, [['engage', PRESS.pointerId]])
    assert.deepEqual(position, { x: 760, y: 20 })
  } finally {
    dispose()
  }
})

test('jitter inside the tolerance stays a click and never moves the card', async () => {
  const { api, dispose } = await loadPlugin()
  try {
    const { machine, log, advance, fire, pending } = makeMachine(api)
    machine.down(PRESS)
    // A couple of pixels of hand tremor: not a drag, and no position reported.
    assert.equal(machine.move({ pointerId: PRESS.pointerId, x: PRESS.startX + 3, y: PRESS.startY - 2 }), null)
    assert.deepEqual(log, [])
    assert.equal(machine.engaged, false)
    // Released before the hold elapses: a plain tap, so the control still fires.
    const finished = machine.up(PRESS.pointerId)
    assert.deepEqual(finished, { engaged: false, position: null })
    assert.equal(machine.takeSwallowedClick(), false)
    assert.equal(pending(), 0, 'releasing must clear the pending hold')
    // Even if the loop still ran the callback, nothing may engage afterwards.
    advance(api.gesture.holdMs * 2)
    fire()
    assert.deepEqual(log, [], 'a released press must not engage later')
  } finally {
    dispose()
  }
})

test('a drag swallows exactly one click, and a tap swallows none', async () => {
  const { api, dispose } = await loadPlugin()
  try {
    const drag = makeMachine(api)
    drag.machine.down(PRESS)
    drag.advance(api.gesture.holdMs)
    drag.fire()
    const finished = drag.machine.up(PRESS.pointerId)
    assert.equal(finished.engaged, true)
    assert.deepEqual(finished.position, { x: 800, y: 20 })
    assert.equal(drag.machine.takeSwallowedClick(), true, 'the click after a drag is swallowed')
    assert.equal(drag.machine.takeSwallowedClick(), false, 'and only once')

    const tap = makeMachine(api)
    tap.machine.down(PRESS)
    tap.machine.up(PRESS.pointerId)
    assert.equal(tap.machine.takeSwallowedClick(), false)

    // A drag whose click never arrived must not swallow the next interaction's.
    const stray = makeMachine(api)
    stray.machine.down(PRESS)
    stray.advance(api.gesture.holdMs)
    stray.fire()
    stray.machine.up(PRESS.pointerId)
    stray.machine.down({ ...PRESS, pointerId: 9 })
    assert.equal(stray.machine.takeSwallowedClick(), false)
    stray.machine.abort(9)
  } finally {
    dispose()
  }
})

test('one pointer owns the card, and abort lets the next press in', async () => {
  const { api, dispose } = await loadPlugin()
  try {
    const { machine, log, advance, fire, pending } = makeMachine(api)
    assert.equal(machine.down(PRESS), true)
    // A second finger is ignored while the first owns the card.
    assert.equal(machine.down({ ...PRESS, pointerId: 8 }), false)
    assert.equal(pending(), 1, 'the ignored press must not arm a second hold')
    // A pointer that is not the live press cannot move or finish it.
    assert.equal(machine.move({ pointerId: 8, x: 10, y: 10 }), null)
    assert.equal(machine.up(8), null)
    advance(api.gesture.holdMs)
    fire()
    assert.equal(machine.engaged, true)
    machine.abort(PRESS.pointerId)
    assert.equal(machine.pressing, false)
    assert.equal(machine.engaged, false)
    assert.equal(pending(), 0, 'aborting must clear the hold timer')
    advance(api.gesture.holdMs * 2)
    fire()
    assert.deepEqual(log, [['engage', PRESS.pointerId]])
    assert.equal(machine.down({ ...PRESS, pointerId: 9 }), true)
    machine.abort()
    assert.equal(pending(), 0)
  } finally {
    dispose()
  }
})

test('movement clamps to the frame instead of parking the card off-screen', async () => {
  const { api, dispose } = await loadPlugin()
  try {
    const { clampToFrame } = api.gesture
    // Past the right and bottom edges.
    assert.deepEqual(clampToFrame({ x: 5000, y: 5000 }, BOUNDS), { x: 800, y: 580 })
    // Past the left and top edges.
    assert.deepEqual(clampToFrame({ x: -50, y: -50 }, BOUNDS), { x: 0, y: 0 })
    // A frame smaller than the card pins to the origin rather than going negative.
    assert.deepEqual(clampToFrame({ x: 40, y: 40 }, { maxX: -400, maxY: -300 }), { x: 0, y: 0 })
    // An in-range position is returned unchanged.
    assert.deepEqual(clampToFrame({ x: 300, y: 200 }, BOUNDS), { x: 300, y: 200 })
    // Unusable input reports "no position" rather than collapsing to the origin:
    // zeroing here is exactly the bug that pinned the card at the top-left.
    assert.equal(clampToFrame({ x: 300, y: 200 }, null), null)
    assert.equal(clampToFrame({ x: 300, y: 200 }, { maxX: Number.NaN, maxY: 100 }), null)
    assert.equal(clampToFrame({ x: Number.NaN, y: 200 }, BOUNDS), null)
    assert.equal(clampToFrame(undefined, BOUNDS), null)

    // The same clamp applies to a real drag that runs off the edge.
    const { machine, advance, fire } = makeMachine(api)
    machine.down(PRESS)
    advance(api.gesture.holdMs)
    fire()
    assert.deepEqual(machine.move({ pointerId: PRESS.pointerId, x: 99999, y: 99999 }), { x: 800, y: 580 })
  } finally {
    dispose()
  }
})

test('the frame is measured from the card\'s containing block, not its DOM parent', async () => {
  const { api, dispose } = await loadPlugin()
  try {
    const { measureFrame } = api.gesture

    /*
     * The regression this whole fix exists for. The slot outlet wraps every
     * contribution in `<div data-slot style="display:contents">`, whose box is
     * 0x0. Measuring `parentElement` therefore reported an empty frame, and the
     * clamp pinned the card to the origin on every drag. `offsetParent` is the
     * positioned ancestor the browser resolves `left`/`top` against.
     */
    const anchor = { clientWidth: 0, clientHeight: 0 }
    assert.equal(anchor.clientWidth, 0, 'the anchor really is the degenerate case being guarded')

    const card = {
      offsetParent: { clientWidth: 1400, clientHeight: 900 },
      offsetLeft: 1180,
      offsetTop: 60,
      offsetWidth: 200,
      offsetHeight: 120,
      ownerDocument: { documentElement: { clientWidth: 1400, clientHeight: 900 } },
      getBoundingClientRect: () => ({ left: 1180, top: 60, width: 200, height: 120 }),
    }
    const frame = measureFrame(card)
    assert.equal(frame.source, 'offsetParent')
    assert.equal(frame.originX, 1180)
    assert.equal(frame.originY, 60)
    assert.deepEqual(frame.bounds, { maxX: 1200, maxY: 780 })
    // The measured origin must survive a no-op clamp: a press that does not move
    // must not teleport the card.
    assert.deepEqual(
      api.gesture.clampToFrame({ x: frame.originX, y: frame.originY }, frame.bounds),
      { x: 1180, y: 60 },
    )

    // With no positioned ancestor the viewport is the frame, and the card's own
    // rect is the origin — again never a zeroed frame.
    const orphan = {
      offsetParent: null,
      ownerDocument: { documentElement: { clientWidth: 1200, clientHeight: 800 } },
      getBoundingClientRect: () => ({ left: 900, top: 40, width: 200, height: 120 }),
    }
    const fallback = measureFrame(orphan)
    assert.equal(fallback.source, 'viewport')
    assert.equal(fallback.originX, 900)
    assert.deepEqual(fallback.bounds, { maxX: 1000, maxY: 680 })

    // No measurable box at all is reported as such, so the press is refused
    // instead of being clamped into the corner.
    assert.equal(measureFrame({
      offsetParent: null,
      ownerDocument: { documentElement: { clientWidth: 0, clientHeight: 0 } },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    }), null)
  } finally {
    dispose()
  }
})

test('the gesture does not disturb the billing rule the card shows', async () => {
  const { api, dispose } = await loadPlugin()
  try {
    // A sanity check that both features still read the same rule the Host publishes.
    assert.deepEqual(api.getState().schedule.peakWindows, BEIJING.peakWindows)
    assert.equal(api.periodAt(Date.UTC(2026, 8, 7, 1, 30)), periodAt(Date.UTC(2026, 8, 7, 1, 30), BEIJING))
  } finally {
    dispose()
  }
})
