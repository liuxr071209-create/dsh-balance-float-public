/**
 * dsh-balance-float — browser half.
 *
 * One contribution into the shell's frame-wide overlay seat (`shell.overlay`):
 * a draggable, collapsible card showing the cached account balance and whether
 * the current minute bills at the peak or the off-peak rate.
 *
 * Division of labour with the Host half:
 *   - the Host owns the API key, the polling, and the billing-schedule *rule*;
 *   - this half owns the clock, so the peak/valley pill flips at the boundary
 *     without waiting for the next poll, and so it keeps working when the
 *     balance route is unreachable.
 *
 * Extension seams (see README): every visual value is a `--dbf-*` custom
 * property defaulting to a host theme token, the root carries
 * `data-dbf-skin` / `data-dbf-state` / `data-dbf-status`, and
 * `window.__DSH_BALANCE_FLOAT__` lets a skin or an animated companion drive a
 * reserved art stage and observe state changes.
 */

window.__ModuleLoader__.load({
  id: 'dsh-balance-float',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ---------------------------------------------------------------- */
    /* Copy                                                             */
    /* ---------------------------------------------------------------- */

    /** Locale namespace registered with the Client locale service. */
    const NS = 'dsh-balance-float'

    /** Built-in dictionaries; also the fallback when no locale service exists. */
    const COPY = {
      zh: {
        title: '账户余额',
        peak: '高峰计价',
        offPeak: '低谷计价',
        until: '至 {time}',
        pending: '读取中…',
        unconfigured: '未配置 API Key',
        unavailable: '余额不可用',
        granted: '赠送',
        toppedUp: '充值',
        collapse: '折叠',
        expand: '展开',
        dragHint: '长按浮窗任意位置即可拖动，方向键微调',
        refreshHint: '点击刷新余额',
        stageHint: '点击互动',
      },
      en: {
        title: 'Balance',
        peak: 'Peak rate',
        offPeak: 'Off-peak rate',
        until: 'until {time}',
        pending: 'Loading…',
        unconfigured: 'No API key',
        unavailable: 'Balance unavailable',
        granted: 'Granted',
        toppedUp: 'Topped up',
        collapse: 'Collapse',
        expand: 'Expand',
        dragHint: 'Press and hold anywhere on the card to drag; arrow keys nudge',
        refreshHint: 'Click to refresh',
        stageHint: 'Click to interact',
      },
    }

    /* ---------------------------------------------------------------- */
    /* Billing schedule                                                 */
    /* ---------------------------------------------------------------- */

    /**
     * The Host's default rule, mirrored so the pill is correct before the first
     * response and stays correct when the route never answers.
     */
    const FALLBACK_SCHEDULE = { utcOffsetMinutes: 480, peakWindows: [[540, 720], [840, 1080]] }

    /** Normalize whatever the Host published into a usable rule. */
    function normalizeSchedule(raw) {
      if (raw === null || typeof raw !== 'object') return FALLBACK_SCHEDULE
      const offset = Number.isFinite(raw.utcOffsetMinutes) ? raw.utcOffsetMinutes : FALLBACK_SCHEDULE.utcOffsetMinutes
      const windows = Array.isArray(raw.peakWindows)
        ? raw.peakWindows.filter((pair) => Array.isArray(pair) && pair.length === 2
          && Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[0] < pair[1])
        : []
      return {
        utcOffsetMinutes: offset,
        peakWindows: windows.length > 0 ? windows : FALLBACK_SCHEDULE.peakWindows,
      }
    }

    /**
     * Billing period at one instant: weekends are never peak, and each window is
     * `[start, end)` in minutes from local midnight.
     * @param timestamp - epoch milliseconds.
     * @param schedule - normalized rule.
     * @returns `'peak'` or `'offPeak'`.
     */
    function periodAt(timestamp, schedule) {
      const local = new Date(timestamp + schedule.utcOffsetMinutes * 60_000)
      const day = local.getUTCDay()
      if (day === 0 || day === 6) return 'offPeak'
      const minutes = local.getUTCHours() * 60 + local.getUTCMinutes()
      for (const [start, end] of schedule.peakWindows) {
        if (minutes >= start && minutes < end) return 'peak'
      }
      return 'offPeak'
    }

    /**
     * First instant strictly after `timestamp` at which the period actually
     * changes; edges that leave the rate unchanged are skipped.
     * @param timestamp - epoch milliseconds.
     * @param schedule - normalized rule.
     * @returns epoch milliseconds, or null when the rule has no windows.
     */
    function nextChangeAt(timestamp, schedule) {
      const offsetMs = schedule.utcOffsetMinutes * 60_000
      const local = new Date(timestamp + offsetMs)
      const year = local.getUTCFullYear()
      const month = local.getUTCMonth()
      const date = local.getUTCDate()
      const boundaries = [...new Set(schedule.peakWindows.flat())].sort((left, right) => left - right)
      if (boundaries.length === 0) return null
      const current = periodAt(timestamp, schedule)
      for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
        for (const minutes of boundaries) {
          const candidate = Date.UTC(year, month, date + dayOffset, Math.floor(minutes / 60), minutes % 60) - offsetMs
          if (candidate > timestamp && periodAt(candidate, schedule) !== current) return candidate
        }
      }
      return null
    }

    /* ---------------------------------------------------------------- */
    /* Formatting                                                       */
    /* ---------------------------------------------------------------- */

    const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥' }

    /** Two-decimal money text, tolerating a missing value. */
    function formatAmount(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : null
    }

    /** `HH:MM` in the schedule's own zone, read from shifted UTC fields. */
    function formatClock(timestamp, utcOffsetMinutes) {
      const local = new Date(timestamp + utcOffsetMinutes * 60_000)
      const hours = String(local.getUTCHours()).padStart(2, '0')
      const minutes = String(local.getUTCMinutes()).padStart(2, '0')
      return `${hours}:${minutes}`
    }

    /* ---------------------------------------------------------------- */
    /* Persistence                                                      */
    /* ---------------------------------------------------------------- */

    const STORAGE_KEYS = {
      position: `${NS}:position`,
      collapsed: `${NS}:collapsed`,
      skin: `${NS}:skin`,
    }

    /**
     * Stored-position schema. Bumping this discards positions written by an
     * older build: a bad geometry pinned the card at the origin, and that value
     * outlives the bug in the browser, so it has to be ignored rather than
     * clamped, or the fix would look like it did nothing.
     */
    const POSITION_SCHEMA = 2

    function readStored(key) {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    }

    function writeStored(key, value) {
      try {
        if (value === null) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, value)
      } catch {
        // A browser refusing storage costs persistence, never the window.
      }
    }

    /** Persist a resting position, or clear it when there is none. */
    function writePosition(position) {
      if (position === null || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
        writeStored(STORAGE_KEYS.position, null)
        return
      }
      writeStored(STORAGE_KEYS.position, JSON.stringify({
        v: POSITION_SCHEMA,
        x: Math.round(position.x),
        y: Math.round(position.y),
      }))
    }

    function readPosition() {
      const raw = readStored(STORAGE_KEYS.position)
      if (raw === null) return null
      try {
        const parsed = JSON.parse(raw)
        /* An older schema is ignored, not migrated and not cleared: reading runs
           during render, and the next drag overwrites it anyway. */
        if (parsed?.v !== POSITION_SCHEMA) return null
        if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return { x: parsed.x, y: parsed.y }
      } catch {
        // Fall through to the anchored default.
      }
      return null
    }

    /* ---------------------------------------------------------------- */
    /* Store                                                            */
    /* ---------------------------------------------------------------- */

    /**
     * Minimal external store shaped for `React.useSyncExternalStore`: the
     * snapshot identity changes exactly when published state changes.
     */
    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        publish(patch) {
          const next = { ...state, ...patch }
          let changed = false
          for (const key of Object.keys(patch)) {
            if (state[key] !== next[key]) {
              changed = true
              break
            }
          }
          if (!changed) return false
          state = next
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch {
              // One broken listener must not stop the others.
            }
          }
          return true
        },
      }
    }

    /* ---------------------------------------------------------------- */
    /* Styles                                                           */
    /* ---------------------------------------------------------------- */

    /*
     * Every value is a `--dbf-*` variable with a host-token fallback, so a skin
     * is a variable override (or a `[data-dbf-skin='…']` block) and never a
     * source edit. `--dbf-stage-*` sizes the reserved animated-art area.
     */
    const CSS = `
.dbf-root{position:absolute;z-index:1;box-sizing:border-box;display:flex;flex-direction:column;
  min-width:150px;max-width:240px;padding:8px 10px 10px;
  border-radius:var(--dbf-radius,var(--dsw-radius-lg,16px));
  background:var(--dbf-surface,var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,#fff)));
  border:1px solid var(--dbf-border,var(--dsw-alias-border-l2,rgba(0,0,0,.08)));
  box-shadow:var(--dbf-shadow,var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.1)));
  color:var(--dbf-label,var(--dsw-alias-label-primary,#111));
  font:var(--dbf-font,var(--dsw-font-s-14,14px/20px system-ui,sans-serif));
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;
  cursor:grab;touch-action:none}
.dbf-root:active{cursor:grabbing}
.dbf-root[data-dbf-dragging]{cursor:grabbing;
  box-shadow:var(--dbf-shadow-drag,0 0 0 2px var(--dsw-alias-brand-primary,#4d6bfe),
    var(--dbf-shadow,var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.1))))}
.dbf-root:focus-visible{outline:none;
  box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4d6bfe))}
.dbf-root[data-dbf-collapsed]{min-width:0;padding:6px 10px;border-radius:var(--dbf-radius-pill,999px)}
.dbf-head{display:flex;align-items:center;gap:6px}
.dbf-grip{flex:none;width:10px;height:10px;border-radius:50%;
  background:var(--dbf-grip,var(--dsw-alias-label-tertiary,currentColor));opacity:.5}
.dbf-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dbf-title-label,var(--dsw-alias-label-secondary,#666));
  font:var(--dbf-title-font,var(--dsw-font-xxs-12,12px/16px system-ui,sans-serif))}
.dbf-icon{flex:none;display:grid;place-items:center;width:18px;height:18px;padding:0;
  border:0;border-radius:var(--dsw-radius-xs,4px);background:transparent;cursor:pointer;
  color:var(--dbf-title-label,var(--dsw-alias-label-tertiary,#888));font-size:10px;line-height:1}
.dbf-icon:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dbf-body{display:flex;flex-direction:column;gap:4px;margin-top:4px}
.dbf-amount{display:flex;align-items:baseline;gap:2px;cursor:pointer;
  font:var(--dbf-amount-font,var(--dsw-font-l-20,20px/28px system-ui,sans-serif))}
.dbf-currency{font:var(--dbf-amount-currency-font,var(--dsw-font-s-14,14px/20px system-ui,sans-serif));
  color:var(--dbf-amount-label,var(--dsw-alias-label-secondary,#666))}
.dbf-number{font-weight:600;font-variant-numeric:tabular-nums;
  color:var(--dbf-amount-label,var(--dsw-alias-label-primary,#111))}
.dbf-note{font:var(--dbf-note-font,var(--dsw-font-xxs-12,12px/16px system-ui,sans-serif));
  color:var(--dbf-note-label,var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary,#666)))}
.dbf-state{display:flex;align-items:center;gap:5px;
  font:var(--dbf-state-font,var(--dsw-font-xs-13,13px/20px system-ui,sans-serif))}
.dbf-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dbf-state-fill,currentColor)}
.dbf-period{color:var(--dbf-state-fill,currentColor);font-weight:500}
.dbf-until{color:var(--dbf-until-label,var(--dsw-alias-label-tertiary,#888));
  font:var(--dbf-until-font,var(--dsw-font-xxs-12,12px/16px system-ui,sans-serif))}
.dbf-root[data-dbf-state='peak']{--dbf-state-fill:var(--dbf-peak,var(--dsw-alias-state-warn-primary,#d97706))}
.dbf-root[data-dbf-state='offPeak']{--dbf-state-fill:var(--dbf-valley,var(--dsw-alias-state-success-primary,#16a34a))}
.dbf-root[data-dbf-status='error']{--dbf-state-fill:var(--dbf-error,var(--dsw-alias-state-error-primary,#dc2626))}
.dbf-detail{display:flex;flex-wrap:wrap;gap:2px 8px;
  font:var(--dbf-detail-font,var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif));
  color:var(--dbf-detail-label,var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary,#999)))}
.dbf-detail b{font-weight:500;color:var(--dbf-detail-strong,var(--dsw-alias-label-secondary,#666))}
.dbf-stage{display:flex;justify-content:center;margin-top:2px;cursor:pointer}
.dbf-stage-art{display:block;max-width:100%;height:auto;
  width:var(--dbf-stage-width,auto);max-height:var(--dbf-stage-max-height,96px);
  pointer-events:none}
.dbf-panels{display:flex;flex-direction:column;gap:6px;margin-top:6px;padding-top:6px;
  border-top:1px solid var(--dbf-divider,var(--dsw-alias-border-l3,rgba(0,0,0,.08)))}
.dbf-panel{min-width:0}
`

    /* ---------------------------------------------------------------- */
    /* Card                                                             */
    /* ---------------------------------------------------------------- */

    const POSITION_MARGIN = 12
    const KEYBOARD_STEP = 8
    const KEYBOARD_STEP_FAST = 32

    /** Resolve one copy key through the live translate function. */
    function text(t, key, params) {
      const value = typeof t === 'function' ? t(key, params) : undefined
      if (typeof value === 'string' && value !== key) return value
      const template = COPY.zh[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /**
     * Run one registered panel's render. A panel is another plugin's code, so a
     * failure in it must cost that panel's row and nothing else — a throwing
     * render would otherwise blank the whole card.
     * @param panel - a `{ id, render }` registration.
     * @returns the panel's node, or null when it failed.
     */
    function renderPanel(panel) {
      try {
        return panel.render()
      } catch {
        return null
      }
    }

    /*
     * Gesture rule. The whole card is the drag surface: a press anywhere on it
     * becomes a drag either by being held (HOLD_MS) or by travelling past
     * MOVE_TOLERANCE, so a hold-to-drag and an ordinary drag both work, while a
     * tap still reaches whatever control sits under the pointer. Once a press
     * becomes a drag the trailing click is swallowed, so dragging never also
     * toggles the collapse button or refreshes.
     */

    /** How long a press must last to become a drag. */
    const HOLD_MS = 280
    /** Pointer travel that counts as a deliberate drag before the hold elapses. */
    const MOVE_TOLERANCE = 12

    /**
     * Whether a press has become a drag.
     * @param heldMs - milliseconds since the press began.
     * @param distance - pointer travel in pixels since the press began.
     * @returns true once either threshold is met.
     */
    function isDragGesture(heldMs, distance) {
      return heldMs >= HOLD_MS || distance > MOVE_TOLERANCE
    }

    /**
     * The card's own coordinate system: the offsets it may legally take,
     * relative to the box its `left`/`top` are resolved against.
     *
     * This reads `offsetParent` / `offsetLeft` / `offsetTop`, never
     * `parentElement`. The slot outlet wraps every contribution in a
     * `display: contents` anchor, whose box is empty, so the DOM parent is *not*
     * the containing block: measuring it reports a 0x0 frame, and clamping then
     * pins the card to the origin. `offsetParent` is the positioned ancestor the
     * browser actually resolves `left`/`top` against, and its `clientWidth` /
     * `clientHeight` are the padding box those offsets live in.
     *
     * @param card - the card element.
     * @returns `{ originX, originY, bounds, source }`, or null when there is no
     *   usable box to measure.
     */
    function measureFrame(card) {
      const parent = card.offsetParent
      if (parent != null && parent.clientWidth > 0 && parent.clientHeight > 0) {
        return {
          originX: card.offsetLeft,
          originY: card.offsetTop,
          bounds: {
            maxX: parent.clientWidth - card.offsetWidth,
            maxY: parent.clientHeight - card.offsetHeight,
          },
          source: 'offsetParent',
        }
      }
      /* With no positioned ancestor an absolutely positioned box resolves
         against the initial containing block, so the viewport is the frame. */
      const rect = card.getBoundingClientRect()
      const view = card.ownerDocument?.documentElement
      if (view != null && view.clientWidth > 0 && view.clientHeight > 0) {
        return {
          originX: rect.left,
          originY: rect.top,
          bounds: { maxX: view.clientWidth - rect.width, maxY: view.clientHeight - rect.height },
          source: 'viewport',
        }
      }
      return null
    }

    /**
     * Clamp a card position into measured bounds, so a dragged card can never be
     * parked off-screen.
     * @param position - candidate `{ x, y }` in the frame's coordinate system.
     * @param bounds - `{ maxX, maxY }` from {@link measureFrame}.
     * @returns the clamped position, or null when either input is unusable —
     *   null rather than a zeroed position, because collapsing to the origin is
     *   the exact failure this guards against.
     */
    function clampToFrame(position, bounds) {
      if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return null
      if (!Number.isFinite(bounds?.maxX) || !Number.isFinite(bounds?.maxY)) return null
      return {
        x: Math.min(Math.max(position.x, 0), Math.max(0, bounds.maxX)),
        y: Math.min(Math.max(position.y, 0), Math.max(0, bounds.maxY)),
      }
    }

    /**
     * Press-to-drag state machine, independent of React and the DOM.
     *
     * The caller supplies the geometry it measured at press time and the three
     * effects to run; this owns the hold timer, the engage decision, and the
     * click-swallow flag. Keeping it plain is what makes the gesture testable
     * with a fake clock instead of a rendered card.
     *
     * @param options - `{ holdMs, moveTolerance, onEngage, now, setTimer, clearTimer }`.
     *   The clock and the scheduler are injectable so the hold can be driven
     *   deterministically by a test instead of by a real 280 ms wait.
     * @returns the machine's transitions.
     */
    function createDragMachine(options) {
      const now = options.now ?? (() => Date.now())
      const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
      const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
      let press = null
      let holdTimer = null
      let swallowed = false

      /** Drop a pending hold so it can never fire after the press ended. */
      const clearHold = () => {
        if (holdTimer !== null) {
          clearTimer(holdTimer)
          holdTimer = null
        }
      }

      /** Promote the live press into a drag, exactly once. */
      const engage = () => {
        if (press === null || press.engaged) return
        press.engaged = true
        clearHold()
        swallowed = true
        options.onEngage(press.pointerId)
      }

      /** Clamp the pointer against the bounds measured at press time. */
      const project = (target, x, y) => clampToFrame(
        { x: target.originX + (x - target.startX), y: target.originY + (y - target.startY) },
        target.bounds,
      )

      return {
        /** True while a pointer owns the card, drag or not. */
        get pressing() {
          return press !== null
        },
        /** True once the live press became a drag. */
        get engaged() {
          return press !== null && press.engaged
        },
        /**
         * Record a press and arm the hold.
         * @param input - `{ pointerId, startX, startY, originX, originY, bounds }`,
         *   where `bounds` is a measured `{ maxX, maxY }`.
         * @returns true when the press was accepted.
         */
        down(input) {
          if (press !== null) return false
          /* A press that never delivered its click must not swallow the next
             one, so each interaction starts with a clean flag. */
          swallowed = false
          press = {
            ...input,
            engaged: false,
            startedAt: now(),
            lastX: input.startX,
            lastY: input.startY,
          }
          const { startedAt } = press
          holdTimer = setTimer(() => {
            holdTimer = null
            if (press !== null && isDragGesture(now() - startedAt, 0)) engage()
          }, options.holdMs)
          return true
        },
        /**
         * Follow a pointer.
         * @param input - `{ pointerId, x, y }`.
         * @returns the clamped position when the card should move, else null.
         */
        move(input) {
          if (press === null || press.pointerId !== input.pointerId) return null
          const distance = Math.hypot(input.x - press.startX, input.y - press.startY)
          if (!press.engaged) {
            if (!isDragGesture(now() - press.startedAt, distance)) return null
            engage()
          }
          press.lastX = input.x
          press.lastY = input.y
          return project(press, input.x, input.y)
        },
        /**
         * Release a pointer.
         * @param pointerId - the pointer being released.
         * @returns null when the pointer is not the live press; otherwise
         *   `{ engaged, position }`, where a plain tap carries `engaged: false`.
         */
        up(pointerId) {
          if (press === null || press.pointerId !== pointerId) return null
          const finished = press
          press = null
          clearHold()
          return finished.engaged
            ? { engaged: true, position: project(finished, finished.lastX, finished.lastY) }
            : { engaged: false, position: null }
        },
        /** Forget the live press without completing a drag. */
        abort(pointerId) {
          if (press === null || (pointerId !== undefined && press.pointerId !== pointerId)) return
          press = null
          clearHold()
        },
        /** Whether a drag happened since the last read, consuming the flag. */
        takeSwallowedClick() {
          const value = swallowed
          swallowed = false
          return value
        },
      }
    }

    /**
     * The floating card. Position, collapse state, and the live press are
     * per-mount UI state; everything data-shaped comes from the plugin's store.
     * @param props - `{ runtime }` supplied by the registration's inject face.
     */
    function FloatingCard(props) {
      const { runtime } = props
      const state = React.useSyncExternalStore(runtime.store.subscribe, runtime.store.getSnapshot, runtime.store.getSnapshot)
      const { t, snapshot, period, periodEndsAt, skin, stage, panels } = state

      const [position, setPosition] = React.useState(readPosition)
      const [collapsed, setCollapsed] = React.useState(() => readStored(STORAGE_KEYS.collapsed) === '1')
      /** True from the moment a press becomes a drag until that drag ends. */
      const [dragging, setDragging] = React.useState(false)
      const cardRef = React.useRef(null)
      /** Latest committed position, so drag end needs no state-updater side effect. */
      const positionRef = React.useRef(position)
      positionRef.current = position

      /*
       * One machine for the mount. Its callbacks only touch stable things
       * (refs, state setters, the plugin runtime), so no dependency can go
       * stale behind it.
       */
      const machineRef = React.useRef(null)
      if (machineRef.current === null) {
        machineRef.current = createDragMachine({
          holdMs: HOLD_MS,
          moveTolerance: MOVE_TOLERANCE,
          onEngage: (pointerId) => {
            setDragging(true)
            try {
              cardRef.current?.setPointerCapture(pointerId)
            } catch {
              // Capture is an optimization; the card still receives the moves.
            }
            runtime.emit('drag', { phase: 'start' })
          },
        })
      }
      const machine = machineRef.current

      /** Abandon a hold left pending by an unmount. */
      React.useEffect(() => () => machine.abort(), [machine])

      /** Keep a dragged card inside the frame after a window resize. */
      React.useEffect(() => {
        const onResize = () => {
          const current = positionRef.current
          const card = cardRef.current
          if (current === null || !card) return
          const frame = measureFrame(card)
          if (frame === null) return
          const next = clampToFrame(current, frame.bounds)
          if (next !== null && (next.x !== current.x || next.y !== current.y)) setPosition(next)
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      /** Persist the current collapse flag. */
      const toggleCollapsed = React.useCallback(() => {
        setCollapsed((current) => {
          const next = !current
          writeStored(STORAGE_KEYS.collapsed, next ? '1' : '0')
          runtime.emit('collapse', { collapsed: next })
          return next
        })
      }, [runtime])

      /**
       * Press anywhere on the card. The machine owns the hold; the card only
       * measures, moves, and commits. Capture happens on engage rather than on
       * pointerdown, because a captured pointer would redirect the click away
       * from the control under it and break the collapse button.
       */
      const onPointerDown = React.useCallback((event) => {
        if (event.button !== undefined && event.button !== 0) return
        const card = cardRef.current
        if (!card) return
        const frame = measureFrame(card)
        /* Without a usable box there is nothing to clamp against; dragging
           would be a guess, so the press is ignored instead. */
        if (frame === null) {
          runtime.note({ kind: 'measure-failed', source: null })
          return
        }
        runtime.note({ kind: 'press', source: frame.source, originX: frame.originX, originY: frame.originY, bounds: frame.bounds })
        machine.down({
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originX: frame.originX,
          originY: frame.originY,
          bounds: frame.bounds,
        })
      }, [machine, runtime])

      /** Follow the pointer once the press is a drag. */
      const onPointerMove = React.useCallback((event) => {
        const next = machine.move({ pointerId: event.pointerId, x: event.clientX, y: event.clientY })
        if (next === null) return
        setPosition(next)
        runtime.emit('drag', { phase: 'move', position: next })
      }, [machine, runtime])

      /** Release the press: a drag persists its resting place, a tap falls through. */
      const onPointerUp = React.useCallback((event) => {
        const finished = machine.up(event.pointerId)
        if (finished === null || !finished.engaged) return
        setDragging(false)
        try {
          cardRef.current?.releasePointerCapture(event.pointerId)
        } catch {
          // The pointer may already be gone.
        }
        if (finished.position === null) return
        writePosition(finished.position)
        runtime.note({ kind: 'drag-end', position: finished.position })
        runtime.emit('drag', { phase: 'end', position: finished.position })
      }, [machine, runtime])

      /** Swallow exactly one click once a drag has engaged. */
      const onClickCapture = React.useCallback((event) => {
        if (!machine.takeSwallowedClick()) return
        event.stopPropagation()
        event.preventDefault()
      }, [machine])

      /** Keyboard nudging, so the card is reachable without a pointer. */
      const onKeyDown = React.useCallback((event) => {
        const step = event.shiftKey ? KEYBOARD_STEP_FAST : KEYBOARD_STEP
        const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key]
        if (delta === undefined) return
        const card = cardRef.current
        if (!card) return
        const frame = measureFrame(card)
        if (frame === null) return
        event.preventDefault()
        const base = position ?? { x: frame.originX, y: frame.originY }
        const next = clampToFrame({ x: base.x + delta[0], y: base.y + delta[1] }, frame.bounds)
        if (next === null) return
        setPosition(next)
        writePosition(next)
      }, [position])

      const balance = snapshot?.balance ?? null
      const status = snapshot?.status ?? 'pending'
      const amount = formatAmount(balance?.totalBalance)
      const symbol = CURRENCY_SYMBOLS[balance?.currency] ?? ''
      const currencyLabel = balance === null ? '' : `${symbol || `${balance.currency} `}`
      const periodKey = period === 'peak' ? 'peak' : 'offPeak'
      const endsAtText = periodEndsAt === null ? null : formatClock(periodEndsAt, runtime.schedule().utcOffsetMinutes)

      const note = status === 'unconfigured'
        ? text(t, 'unconfigured')
        : status === 'error' && balance === null
          ? text(t, 'unavailable')
          : null

      const amountText = amount ?? (status === 'pending' ? text(t, 'pending') : '—')

      const rootStyle = position === null
        ? { right: POSITION_MARGIN, top: 'var(--dsh-frame-overlay-top,20px)' }
        : { left: position.x, top: position.y }

      const head = h('div', { className: 'dbf-head' },
      h('span', { className: 'dbf-grip', 'aria-hidden': true }),
      h('span', { className: 'dbf-title' }, collapsed ? `${currencyLabel}${amountText}` : text(t, 'title')),
      h('button', {
        type: 'button',
        className: 'dbf-icon',
        'aria-label': text(t, collapsed ? 'expand' : 'collapse'),
        'aria-expanded': !collapsed,
        onClick: toggleCollapsed,
      }, collapsed ? '▸' : '▾'))

      const body = collapsed ? null : h('div', { className: 'dbf-body' },
        h('div', {
          className: 'dbf-amount',
          role: 'button',
          tabIndex: 0,
          title: text(t, 'refreshHint'),
          onClick: () => {
            runtime.emit('activate', { source: 'amount' })
            runtime.refresh()
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              runtime.emit('activate', { source: 'amount' })
              runtime.refresh()
            }
          },
        },
        currencyLabel === '' ? null : h('span', { className: 'dbf-currency' }, currencyLabel),
        h('span', { className: 'dbf-number' }, amountText)),
        note === null ? null : h('div', { className: 'dbf-note' }, note),
        h('div', { className: 'dbf-state' },
        h('span', { className: 'dbf-dot', 'aria-hidden': true }),
        h('span', { className: 'dbf-period' }, text(t, periodKey)),
        endsAtText === null ? null : h('span', { className: 'dbf-until' }, text(t, 'until', { time: endsAtText }))),
        balance === null ? null : h('div', { className: 'dbf-detail' },
        h('span', null, text(t, 'granted'), ' ', h('b', null, formatAmount(balance.grantedBalance) ?? '—')),
        h('span', null, text(t, 'toppedUp'), ' ', h('b', null, formatAmount(balance.toppedUpBalance) ?? '—'))),
        stage === null ? null : h('div', {
          className: 'dbf-stage',
          'data-dbf-stage': stage.kind,
          title: text(t, 'stageHint'),
          onClick: () => runtime.emit('activate', { source: 'stage' }),
        }, stage.kind === 'image'
          ? h('img', { className: 'dbf-stage-art', src: stage.src, alt: stage.alt ?? '', draggable: false })
          : null),
        /* Panels registered by other plugins through `registerPanel`. Each
           `render()` is called during this render, so a panel is a plain
           element factory: no hooks, no own state — re-register to update. */
        panels.length === 0 ? null : h('div', { className: 'dbf-panels' },
        panels.map((panel) => h('div', {
          key: panel.id,
          className: 'dbf-panel',
          'data-dbf-panel': panel.id,
        }, renderPanel(panel)))))

      return h('div', {
        ref: cardRef,
        className: 'dbf-root',
        'data-dbf-skin': skin,
        'data-dbf-state': periodKey,
        'data-dbf-status': status,
        'data-dbf-collapsed': collapsed ? '' : undefined,
        'data-dbf-dragging': dragging ? '' : undefined,
        /* The whole card is the drag surface: press and hold anywhere on it, or
           just drag past the tolerance. Focus lives here too, so the arrow keys
           can nudge the card without a pointer. */
        role: 'group',
        tabIndex: 0,
        'aria-label': text(t, 'title'),
        title: text(t, 'dragHint'),
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        onClickCapture,
        onKeyDown,
        style: rootStyle,
      },
      h('style', { 'data-dbf-styles': '' }, CSS),
      head,
      body)
    }

    /* ---------------------------------------------------------------- */
    /* Activation                                                       */
    /* ---------------------------------------------------------------- */

    /** Same-origin snapshot route registered by the Host half. */
    const STATE_PATH = '/api/dsh-balance-float/state'
    /** Re-evaluate the clock often enough to flip the pill promptly. */
    const CLOCK_TICK_MS = 15_000
    /** Re-read the Host's cached balance; the Host polls the API on its own cadence. */
    const DATA_POLL_MS = 60_000

    /**
     * Contribute the card into the frame-wide overlay seat.
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      const store = createStore({
        snapshot: null,
        t: null,
        skin: readStored(STORAGE_KEYS.skin) ?? 'default',
        stage: null,
        /* Panels other plugins register into this card, in `order` sequence. */
        panels: [],
        period: periodAt(Date.now(), FALLBACK_SCHEDULE),
        periodEndsAt: nextChangeAt(Date.now(), FALLBACK_SCHEDULE),
      })

      const listeners = new Set()

      /*
       * A small bounded trace of the gesture path — the measured frame, the
       * press, and the commits. A puppeteer-free environment cannot see the
       * page, so when a gesture misbehaves this is what turns a guess into a
       * reading: `__DSH_BALANCE_FLOAT__.getDiagnostics()`.
       */
      const trace = []
      const note = (entry) => {
        trace.push({ at: Date.now(), ...entry })
        if (trace.length > 12) trace.shift()
      }

      /** Publish an extension event, containing listener failures. */
      const emit = (event, payload) => {
        for (const listener of [...listeners]) {
          try {
            listener(event, payload)
          } catch {
            // A skin must never be able to break the card.
          }
        }
      }

      /** The rule currently in force: the Host's after the first response. */
      const schedule = () => normalizeSchedule(store.getSnapshot().snapshot?.schedule)

      /** Recompute period and boundary from the page clock. */
      const tickClock = () => {
        const now = Date.now()
        const rule = schedule()
        const period = periodAt(now, rule)
        const periodEndsAt = nextChangeAt(now, rule)
        const previous = store.getSnapshot()
        if (previous.period === period && previous.periodEndsAt === periodEndsAt) return
        if (store.publish({ period, periodEndsAt })) {
          if (previous.period !== period) emit('period', { period, periodEndsAt })
        }
      }

      /** Read the Host snapshot, optionally forcing a fresh upstream read. */
      const load = async (refresh) => {
        try {
          const response = await fetch(`${STATE_PATH}${refresh ? '?refresh=1' : ''}`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json()
          const previous = store.getSnapshot()
          const previousBalance = previous.snapshot?.balance ?? null
          store.publish({ snapshot: body })
          tickClock()
          if (previous.snapshot !== body) emit('state', { snapshot: body })
          const nextBalance = body?.balance ?? null
          if (JSON.stringify(previousBalance) !== JSON.stringify(nextBalance)) emit('balance', { balance: nextBalance })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const previous = store.getSnapshot()
          store.publish({ snapshot: { ...(previous.snapshot ?? {}), ok: false, status: 'error', error: message } })
          emit('state', { snapshot: store.getSnapshot().snapshot })
        }
      }

      const runtime = {
        store,
        schedule,
        emit,
        note,
        refresh: () => void load(true),
      }

      /*
       * Panel registry: the seam other plugins use to put their own controls in
       * this card. Registration is by id, so re-registering one replaces it —
       * which is how a panel with state updates itself without this card having
       * to know anything about it.
       */
      const panels = new Map()
      const publishPanels = () => {
        store.publish({
          panels: [...panels.values()].sort((left, right) => (left.order ?? 0) - (right.order ?? 0)),
        })
      }
      const registerPanel = (panel) => {
        if (panel === null || typeof panel !== 'object') return () => {}
        if (typeof panel.id !== 'string' || panel.id === '' || typeof panel.render !== 'function') return () => {}
        panels.set(panel.id, panel)
        publishPanels()
        return () => {
          if (!panels.has(panel.id)) return
          panels.delete(panel.id)
          publishPanels()
        }
      }

      /* Text: registered with the Client locale service when the composition
         provides one, so the card follows the interface language and a
         dictionary edit. Absent, the built-in copy still renders. */
      ctx.inject(['locale'], (localeCtx) => {
        localeCtx.effect(() => localeCtx.locale.register(NS, { zh: COPY.zh, en: COPY.en }), `${NS}: dictionaries`)
        localeCtx.effect(() => {
          const seat = localeCtx.locale.bind(NS)
          store.publish({ t: seat })
          const unsubscribe = localeCtx.locale.subscribe(() => store.publish({ t: localeCtx.locale.bind(NS) }))
          return () => unsubscribe()
        }, `${NS}: locale seat`)
      })

      /* Data and clock: plugin-owned, so a collapsed or remounted card keeps
         the same polling and does not restart it. */
      ctx.effect(() => {
        void load(false)
        const clock = setInterval(tickClock, CLOCK_TICK_MS)
        const polling = setInterval(() => void load(false), DATA_POLL_MS)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void load(false)
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          clearInterval(clock)
          clearInterval(polling)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, `${NS}: snapshot polling and clock`)

      /* Public seam for skins and animated companions. */
      const api = {
        version: 1,
        getState: () => {
          const state = store.getSnapshot()
          return {
            snapshot: state.snapshot,
            period: state.period,
            periodEndsAt: state.periodEndsAt,
            schedule: schedule(),
            skin: state.skin,
            stage: state.stage,
          }
        },
        periodAt: (timestamp) => periodAt(timestamp ?? Date.now(), schedule()),
        nextChangeAt: (timestamp) => nextChangeAt(timestamp ?? Date.now(), schedule()),
        getSkin: () => store.getSnapshot().skin,
        setSkin: (name) => {
          const skin = typeof name === 'string' && name !== '' ? name : 'default'
          writeStored(STORAGE_KEYS.skin, skin)
          if (store.publish({ skin })) emit('skin', { skin })
        },
        getStage: () => store.getSnapshot().stage,
        setStage: (stage) => {
          /* A stage is one image today; a future skin may add kinds, and an
             unknown kind renders an empty stage rather than throwing. */
          const next = stage !== null && typeof stage === 'object' && typeof stage.src === 'string'
            ? { kind: typeof stage.kind === 'string' ? stage.kind : 'image', src: stage.src, alt: stage.alt }
            : null
          if (store.publish({ stage: next })) emit('stage', { stage: next })
        },
        refresh: () => void load(true),
        /* The gesture the card uses, so a skin's own affordance can mirror it
           and a test can assert it without a pointer. `createDragMachine` is the
           exact machine the card runs, reachable so its transitions stay under
           test rather than only under a mouse. */
        gesture: {
          holdMs: HOLD_MS,
          moveTolerance: MOVE_TOLERANCE,
          isDragGesture,
          clampToFrame,
          measureFrame,
          createDragMachine,
        },
        /** Last measured geometry and the recent gesture trace, for diagnosis. */
        getDiagnostics: () => ({
          positionSchema: POSITION_SCHEMA,
          storedPosition: readStored(STORAGE_KEYS.position),
          renderPosition: readPosition(),
          trace: [...trace],
        }),
        /**
         * Put another plugin's controls in this card.
         * @param panel - `{ id, order?, render }`. `render` is a plain element
         *   factory called during this card's render: it must not use hooks, and
         *   a panel that should follow its own state re-registers.
         * @returns the unregister function.
         */
        registerPanel,
        /** Ids of the currently registered panels. */
        listPanels: () => [...panels.keys()],
        on: (event, handler) => {
          if (typeof handler !== 'function') return () => {}
          const entry = (name, payload) => {
            if (name === event) handler(payload)
          }
          listeners.add(entry)
          return () => listeners.delete(entry)
        },
      }
      ctx.effect(() => {
        window.__DSH_BALANCE_FLOAT__ = api
        /* Announce the seat so a plugin that loaded first can attach without
           polling for the global. `detail` is the same api object. */
        try {
          window.dispatchEvent(new CustomEvent(`${NS}:ready`, { detail: api }))
        } catch {
          // No CustomEvent (or a frozen window) costs the handshake, not the card.
        }
        return () => {
          if (window.__DSH_BALANCE_FLOAT__ !== api) return
          delete window.__DSH_BALANCE_FLOAT__
          panels.clear()
          publishPanels()
        }
      }, `${NS}: public api`)

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: NS.replace(/[^a-z0-9-]/g, '-'),
        order: 60,
        inject: () => ({ runtime }),
      }, FloatingCard))
    }

    return { name: NS, inject: ['slots'], apply }
  },
})
