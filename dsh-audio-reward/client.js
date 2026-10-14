/**
 * dsh-audio-reward — browser half.
 *
 * Two jobs, one file:
 *
 *   1. Poll the Host's cue feed and play the chosen clip when the agent closes
 *      a turn.
 *   2. Put the clip chooser inside `dsh-balance-float`'s card, through the
 *      `registerPanel` seam that card publishes. This half renders no window of
 *      its own.
 *
 * Two constraints shape the playback path:
 *
 *   - **Autoplay policy.** A cue is triggered by a Host event, not by the user,
 *     so `play()` can be refused. A refusal is not an error to hide: the panel
 *     says so, and the next click or keypress retries.
 *   - **Replay.** The first poll adopts the Host's cursor as a baseline instead
 *     of playing the backlog, so opening the page mid-session stays silent.
 *
 * The chooser is registered as a *plain element factory* — no hooks, no state
 * of its own — because the card calls it during its own render. A state change
 * re-registers the same panel id, which replaces it.
 */

window.__ModuleLoader__.load({
  id: 'dsh-audio-reward',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ---------------------------------------------------------------- */
    /* Constants                                                        */
    /* ---------------------------------------------------------------- */

    const NS = 'dsh-audio-reward'
    const STATE_PATH = '/api/dsh-audio-reward/state'
    const EVENTS_PATH = '/api/dsh-audio-reward/events'
    const TRACK_PREFIX = '/api/dsh-audio-reward/track'

    /** How often the cue feed is polled. Cues are not latency-critical. */
    const POLL_MS = 2_000
    /** How often the library is re-read, so a dropped-in file appears. */
    const LIBRARY_REFRESH_MS = 300_000
    /** Panel order inside the card; the balance rows sit above it. */
    const PANEL_ORDER = 20
    /** The float card's public seat, and the event it announces itself with. */
    const HOST_GLOBAL = '__DSH_BALANCE_FLOAT__'
    const HOST_READY_EVENT = 'dsh-balance-float:ready'

    const COPY = {
      zh: {
        title: '完成音效',
        off: '关闭',
        preview: '试听',
        empty: '音频目录里没有可用的音频',
        blocked: '浏览器拦截了自动播放 · 点击页面任意处启用',
      },
      en: {
        title: 'Finish cue',
        off: 'Off',
        preview: 'Preview',
        empty: 'No audio files found in the library',
        blocked: 'Autoplay blocked · click anywhere to enable',
      },
    }

    const STORAGE_KEYS = { track: `${NS}:track`, enabled: `${NS}:enabled` }

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
        // Storage being unavailable costs persistence, never playback.
      }
    }

    /* ---------------------------------------------------------------- */
    /* Styles                                                           */
    /* ---------------------------------------------------------------- */

    /* Token-driven, like the card it lives in: a skin restyles the chooser with
       the same `--dbf-*` variables it already owns. */
    const CSS = `
.dar-panel{display:flex;flex-direction:column;gap:4px;min-width:0}
.dar-row{display:flex;align-items:center;gap:6px;min-width:0}
.dar-label{flex:none;color:var(--dbf-title-label,var(--dsw-alias-label-secondary,#666));
  font:var(--dbf-panel-font,var(--dsw-font-xxs-12,12px/16px system-ui,sans-serif))}
.dar-select{flex:1;min-width:0;max-width:100%;padding:2px 4px;
  border-radius:var(--dsw-radius-xs,4px);
  border:1px solid var(--dbf-border,var(--dsw-alias-border-l2,rgba(0,0,0,.12)));
  background:var(--dbf-control-fill,var(--dsw-alias-bg-layer-1,transparent));
  color:inherit;font:var(--dbf-panel-font,var(--dsw-font-xxs-12,12px/16px system-ui,sans-serif))}
.dar-play{flex:none;padding:2px 6px;border-radius:var(--dsw-radius-xs,4px);cursor:pointer;
  border:1px solid var(--dbf-border,var(--dsw-alias-border-l2,rgba(0,0,0,.12)));
  background:transparent;color:inherit;
  font:var(--dbf-panel-font,var(--dsw-font-xxs-12,12px/16px system-ui,sans-serif))}
.dar-play:disabled{cursor:default;opacity:.5}
.dar-play:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dar-note{color:var(--dbf-note-label,var(--dsw-alias-state-warn-label,var(--dsw-alias-label-tertiary,#888)));
  font:var(--dbf-panel-note-font,var(--dsw-font-xxxs-11,11px/16px system-ui,sans-serif))}
`

    /* ---------------------------------------------------------------- */
    /* Activation                                                       */
    /* ---------------------------------------------------------------- */

    /**
     * Play a cue when the agent closes a turn, and offer the chooser inside the
     * balance card.
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      /* Translation is an enhancement in its own fiber; until (or unless) the
         locale service answers, the built-in copy renders. Assigned below. */
      let translate = null

      /** Resolve one copy key, falling back to the built-in Chinese. */
      const t = (key) => {
        const value = typeof translate === 'function' ? translate(key) : undefined
        if (typeof value === 'string' && value !== key) return value
        return COPY.zh[key] ?? key
      }

      const state = {
        tracks: [],
        /** Selected file name, or null for "off". */
        track: readStored(STORAGE_KEYS.track),
        /** Default on: the cue is the point of this plugin. */
        enabled: readStored(STORAGE_KEYS.enabled) !== '0',
        /** idle | loading | playing | blocked | empty | error */
        status: 'loading',
        error: null,
        /** Highest cue id this page has seen. */
        cursor: 0,
        /** A cue that arrived before the page was allowed to make sound. */
        pendingCue: null,
      }

      /* ---- attachment to the balance card ---------------------------- */

      /** The card's public seat this plugin is registered with, if any. */
      let hostSeat = null
      /** Disposer of the *newest* registration of this plugin's panel. */
      let unregister = () => {}

      /** The panel claim; re-registering the same id replaces it in the card. */
      const panelClaim = () => ({ id: `${NS}-chooser`, order: PANEL_ORDER, render: renderPanel })

      /** Re-register so the card re-renders with the current state. */
      function repaint() {
        if (hostSeat === null) return
        const dispose = hostSeat.registerPanel(panelClaim())
        /* The card replaced the previous registration for this id, so only the
           newest disposer is meaningful for detaching. */
        unregister = typeof dispose === 'function' ? dispose : () => {}
      }

      /** Give up the panel, in the card and locally. */
      function detach() {
        const dispose = unregister
        unregister = () => {}
        hostSeat = null
        try {
          dispose()
        } catch {
          // A card that is already gone has nothing to unregister.
        }
      }

      /**
       * Register with the card if it is present.
       * @returns true when the panel is registered.
       */
      function attach() {
        const seat = window[HOST_GLOBAL]
        if (seat === null || seat === undefined || typeof seat.registerPanel !== 'function') return false
        if (seat === hostSeat) return true
        detach()
        hostSeat = seat
        const dispose = seat.registerPanel(panelClaim())
        unregister = typeof dispose === 'function' ? dispose : () => {}
        return true
      }

      /* ---- chooser view ---------------------------------------------- */

      /**
       * The panel body. Called during the card's render, so it is a plain
       * element factory: no hooks, every value read from `state`.
       * @returns the panel node.
       */
      function renderPanel() {
        const options = [
          h('option', { key: '', value: '' }, t('off')),
          ...state.tracks.map((track) => h('option', { key: track.name, value: track.name }, track.label)),
        ]
        const note = state.status === 'blocked'
          ? t('blocked')
          : state.status === 'empty'
            ? t('empty')
            : state.status === 'error' && state.error !== null
              ? state.error
              : null
        return h('div', { className: 'dar-panel' },
          h('style', { 'data-dar-styles': '' }, CSS),
          h('div', { className: 'dar-row' },
            h('span', { className: 'dar-label' }, t('title')),
            h('select', {
              className: 'dar-select',
              'aria-label': t('title'),
              value: state.enabled ? (state.track ?? '') : '',
              onChange: (event) => selectTrack(event.target.value),
            }, options),
            h('button', {
              type: 'button',
              className: 'dar-play',
              disabled: state.track === null,
              onClick: () => preview(),
            }, t('preview'))),
          note === null ? null : h('div', { className: 'dar-note' }, note))
      }

      /* ---- selection -------------------------------------------------- */

      /**
       * Apply a chooser selection; the empty value means "off".
       * @param name - the chosen file name, or ''.
       */
      function selectTrack(name) {
        const chosen = typeof name === 'string' && name !== '' ? name : null
        const known = chosen !== null && state.tracks.some((track) => track.name === chosen)
        state.track = known ? chosen : null
        state.enabled = state.track !== null
        writeStored(STORAGE_KEYS.track, state.track)
        writeStored(STORAGE_KEYS.enabled, state.enabled ? '1' : '0')
        state.pendingCue = null
        if (state.status === 'blocked') state.status = 'idle'
        repaint()
      }

      /* ---- playback --------------------------------------------------- */

      let element = null
      let armedRetry = null
      /** Whether the Host's cursor has been adopted yet. */
      let baselined = false

      /** One reusable off-document audio element. */
      function audioElement() {
        if (element === null) {
          element = new Audio()
          element.preload = 'auto'
        }
        return element
      }

      /** Absolute URL of one library file. */
      function trackUrl(fileName) {
        return `${TRACK_PREFIX}/${encodeURIComponent(fileName)}`
      }

      /** Remove a pending gesture retry, if one is armed. */
      function disarmRetry() {
        const armed = armedRetry
        armedRetry = null
        if (armed === null) return
        document.removeEventListener('pointerdown', armed, true)
        document.removeEventListener('keydown', armed, true)
      }

      /**
       * Arm a one-shot retry for the next user gesture. Browsers refuse
       * `play()` before the page has been interacted with, and a cue is
       * triggered by a Host event, so this is a normal path rather than an
       * error path.
       */
      function armGestureRetry() {
        if (armedRetry !== null) return
        const retry = () => {
          disarmRetry()
          const cue = state.pendingCue
          state.pendingCue = null
          if (cue !== null) play(cue, true)
        }
        armedRetry = retry
        document.addEventListener('pointerdown', retry, true)
        document.addEventListener('keydown', retry, true)
      }

      /**
       * Play one library file.
       * @param fileName - the file to play.
       * @param isCue - true for a completion cue, false for the preview button.
       *   A cue retried after a refused autoplay is still a cue.
       */
      function play(fileName, isCue) {
        const track = state.tracks.find((entry) => entry.name === fileName)
        if (track === undefined) return
        const audio = audioElement()
        try {
          audio.pause()
          audio.src = trackUrl(track.name)
          audio.currentTime = 0
        } catch (error) {
          state.status = 'error'
          state.error = error instanceof Error ? error.message : String(error)
          repaint()
          return
        }
        let attempt
        try {
          attempt = audio.play()
        } catch (error) {
          state.status = 'error'
          state.error = error instanceof Error ? error.message : String(error)
          repaint()
          return
        }
        if (attempt === undefined || typeof attempt.then !== 'function') {
          /* An engine that returns nothing gives nothing to observe. */
          state.status = isCue ? 'playing' : 'idle'
          repaint()
          return
        }
        attempt.then(() => {
          state.status = isCue ? 'playing' : 'idle'
          state.error = null
          if (isCue) state.pendingCue = null
          repaint()
        }, (error) => {
          const name = error?.name ?? ''
          if (name === 'NotAllowedError') {
            state.status = 'blocked'
            if (isCue) state.pendingCue = fileName
            armGestureRetry()
          } else if (name === 'AbortError') {
            /* A newer cue interrupted this one; not worth showing. */
            state.status = 'idle'
          } else {
            state.status = 'error'
            state.error = error?.message ?? String(error)
          }
          repaint()
        })
      }

      /** User-initiated playback: the click itself satisfies the autoplay rule. */
      function preview() {
        if (state.track === null) return
        state.pendingCue = null
        play(state.track, false)
      }

      /* ---- Host requests ---------------------------------------------- */

      async function requestJson(url) {
        const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      }

      /** Read the library and settle the default selection. */
      async function loadLibrary() {
        try {
          const body = await requestJson(STATE_PATH)
          state.tracks = Array.isArray(body?.tracks) ? body.tracks : []
          if (state.tracks.length === 0) {
            state.status = 'empty'
          } else {
            const names = new Set(state.tracks.map((track) => track.name))
            /* The Host names its preferred default, so the fresh-install choice
               does not shift when files are added or the sort changes; an
               unknown name falls back to the first entry. */
            const preferred = typeof body?.defaultTrack === 'string' && names.has(body.defaultTrack)
              ? body.defaultTrack
              : state.tracks[0].name
            /* Pick a default only while the feature is on and nothing usable is
               selected: a deliberate "off" is never overridden, and a selection
               whose file disappeared falls back to a real one. */
            if (state.track === null) {
              if (state.enabled) {
                state.track = preferred
                writeStored(STORAGE_KEYS.track, state.track)
              }
            } else if (!names.has(state.track)) {
              state.track = preferred
              writeStored(STORAGE_KEYS.track, state.track)
            }
            if (state.status !== 'blocked') state.status = 'idle'
          }
          state.error = null
        } catch (error) {
          state.status = 'error'
          state.error = error instanceof Error ? error.message : String(error)
        }
        repaint()
      }

      /** Fetch cues newer than the cursor, and play one. */
      async function pollCues() {
        try {
          const body = await requestJson(`${EVENTS_PATH}?since=${String(state.cursor)}`)
          const latest = Number(body?.latest)
          if (!baselined) {
            /* First contact: adopt the Host's cursor so history stays silent.
               This is a flag rather than `cursor === 0`, because a freshly
               started Host also reports 0 — the common case. */
            baselined = true
            if (Number.isFinite(latest)) state.cursor = latest
            return
          }
          if (!Number.isFinite(latest)) return
          const events = Array.isArray(body?.events) ? body.events : []
          state.cursor = latest
          if (events.length === 0) return
          /* One cue per poll: the Host already coalesced the burst. */
          if (!state.enabled || state.track === null) return
          play(state.track, true)
        } catch {
          /* A missed poll is not worth reporting; the next one retries. */
        }
      }

      /* ---- owned resources ------------------------------------------- */

      /* Polling and card attachment are plugin-owned, so they survive the card
         remounting and stop when the plugin unloads. */
      ctx.effect(() => {
        attach()
        const onReady = () => {
          attach()
        }
        window.addEventListener(HOST_READY_EVENT, onReady)
        const reattach = setInterval(() => {
          const seat = window[HOST_GLOBAL]
          if (seat === undefined || seat === null) {
            /* The card unloaded; drop the panel rather than hold a stale seat. */
            if (hostSeat !== null) detach()
            return
          }
          if (seat !== hostSeat) attach()
        }, POLL_MS)
        return () => {
          window.removeEventListener(HOST_READY_EVENT, onReady)
          clearInterval(reattach)
          detach()
        }
      }, `${NS}: panel attachment`)

      ctx.effect(() => {
        void loadLibrary().then(() => pollCues())
        const cues = setInterval(() => void pollCues(), POLL_MS)
        const library = setInterval(() => void loadLibrary(), LIBRARY_REFRESH_MS)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void pollCues()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          clearInterval(cues)
          clearInterval(library)
          document.removeEventListener('visibilitychange', onVisibility)
          disarmRetry()
          if (element !== null) {
            try {
              element.pause()
            } catch {
              // A torn-down element cannot be paused; nothing to do.
            }
            element = null
          }
        }
      }, `${NS}: cue polling`)

      /* Locale last: its seat calls repaint(), which needs everything above. */
      ctx.inject(['locale'], (localeCtx) => {
        localeCtx.effect(() => localeCtx.locale.register(NS, { zh: COPY.zh, en: COPY.en }), `${NS}: dictionaries`)
        localeCtx.effect(() => {
          const seat = localeCtx.locale.bind(NS)
          translate = seat
          repaint()
          return () => {
            if (translate === seat) translate = null
          }
        }, `${NS}: locale seat`)
      })

      /* Public seam, mostly so the chooser can be driven from the console. */
      const api = {
        version: 1,
        getState: () => ({
          tracks: state.tracks,
          track: state.track,
          enabled: state.enabled,
          status: state.status,
          error: state.error,
          cursor: state.cursor,
          attached: hostSeat !== null,
        }),
        setTrack: (fileName) => selectTrack(fileName),
        preview,
        /** Re-read the library now, instead of waiting for the refresh tick. */
        reload: () => void loadLibrary(),
        /** Play whatever cue is waiting for a user gesture. */
        flushPending: () => {
          const cue = state.pendingCue
          if (cue === null) return false
          state.pendingCue = null
          play(cue, true)
          return true
        },
      }
      ctx.effect(() => {
        window.__DSH_AUDIO_REWARD__ = api
        return () => {
          if (window.__DSH_AUDIO_REWARD__ === api) delete window.__DSH_AUDIO_REWARD__
        }
      }, `${NS}: public api`)
    }

    return { name: NS, inject: [], apply }
  },
})
