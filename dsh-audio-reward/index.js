/**
 * dsh-audio-reward — Host half.
 *
 * Plays a short cue in the Web UI when the agent finishes a turn. This half owns
 * everything the browser cannot do:
 *
 *   - watching the Session for `turn/end` and turning it into one cue event;
 *   - listing the audio files in a directory and streaming them back;
 *   - serving both over same-origin JSON/binary routes.
 *
 * Why `session/event` and not a bare `turn/end` listener: the Session event
 * stream is the documented durable channel for exactly this ("wait on durable
 * events such as `turn/end`"), it is what the shipped `dsh-damage-pulse` plugin
 * subscribes to, and it delivers the owning Session alongside the event, which
 * is what makes the burst coalescing below possible.
 *
 * Only Node built-ins are imported, so a profile install needs no dependency
 * tree next to the package.
 *
 * @module dsh-audio-reward
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/** Loader row id; the browser bundle registers its factory under the same id. */
export const name = 'dsh-audio-reward'

/** The Host route table lives on `webServer`; nothing else is required. */
export const inject = ['webServer']

/** Library listing: the tracks the browser half may choose from. */
export const STATE_PATH = '/api/dsh-audio-reward/state'
/** Cue feed: `?since=<id>` returns completed turns newer than that id. */
export const EVENTS_PATH = '/api/dsh-audio-reward/events'
/**
 * Audio streaming prefix. Deliberately has no trailing slash: the route table
 * matches a prefix as `pathname === prefix || pathname.startsWith(prefix + '/')`,
 * so a trailing slash would only ever match a double slash.
 */
export const TRACK_PREFIX = '/api/dsh-audio-reward/track'

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_AUDIO_DIR = 'D:/音频'
/** Clips shipped inside this package, so a fresh install makes a sound. */
const BUNDLED_AUDIO_DIR = fileURLToPath(new URL('./audio', import.meta.url))
/** How the bundled clips combine with the user's directory. */
const BUNDLED_MODES = ['fallback', 'merge', 'off']
const DEFAULT_BUNDLED_MODE = 'fallback'
/** Neutral clip a fresh install plays until the user picks something else. */
const DEFAULT_DEFAULT_TRACK = 'chime.wav'
const MIME_BY_EXTENSION = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.weba': 'audio/webm',
}
const DEFAULT_EXTENSIONS = Object.keys(MIME_BY_EXTENSION)
const DEFAULT_COALESCE_MS = 600
const MIN_COALESCE_MS = 0
const MAX_COALESCE_MS = 10_000
const DEFAULT_MAX_EVENTS = 64
const MAX_FILE_BYTES = 32 * 1024 * 1024

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** Clamp a number into a range, ignoring anything that is not finite. */
function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Accept only extensions this module can name a MIME type for. */
function normalizeExtensions(value) {
  if (!Array.isArray(value)) return [...DEFAULT_EXTENSIONS]
  const accepted = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const extension = entry.trim().toLowerCase()
    if (!extension.startsWith('.')) continue
    if (MIME_BY_EXTENSION[extension] === undefined) continue
    if (!accepted.includes(extension)) accepted.push(extension)
  }
  return accepted.length > 0 ? accepted : [...DEFAULT_EXTENSIONS]
}

/** Accept a `{ filename: label }` map of string pairs. */
function normalizeLabels(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const labels = {}
  for (const [key, label] of Object.entries(value)) {
    if (typeof key !== 'string' || key === '') continue
    if (typeof label !== 'string' || label.trim() === '') continue
    labels[key] = label.trim()
  }
  return labels
}

/**
 * Turn the Loader row's `config` into a total, validated settings object. A
 * malformed value falls back to its default rather than failing activation.
 * @param raw - the row config, or undefined when the patch declares none.
 * @returns validated settings.
 */
export function normalizeSettings(raw) {
  const config = typeof raw === 'object' && raw !== null ? raw : {}
  return {
    audioDir: typeof config.audioDir === 'string' && config.audioDir.trim() !== ''
      ? config.audioDir.trim()
      : DEFAULT_AUDIO_DIR,
    extensions: normalizeExtensions(config.extensions),
    bundledAudio: BUNDLED_MODES.includes(config.bundledAudio) ? config.bundledAudio : DEFAULT_BUNDLED_MODE,
    /* Normally this package's own `audio/` directory; overridable so a test can
       point at a fixture instead of the shipped clips. */
    bundledAudioDir: typeof config.bundledAudioDir === 'string' && config.bundledAudioDir.trim() !== ''
      ? config.bundledAudioDir.trim()
      : BUNDLED_AUDIO_DIR,
    defaultTrack: typeof config.defaultTrack === 'string' && config.defaultTrack.trim() !== ''
      ? config.defaultTrack.trim()
      : DEFAULT_DEFAULT_TRACK,
    coalesceMs: clampNumber(config.coalesceMs, MIN_COALESCE_MS, MAX_COALESCE_MS, DEFAULT_COALESCE_MS),
    maxEvents: clampNumber(config.maxEvents, 4, 512, DEFAULT_MAX_EVENTS),
    labels: normalizeLabels(config.labels),
  }
}

/**
 * The directories a track name may resolve in, most specific first. Listing
 * applies the `bundledAudio` mode; resolution only needs the order.
 * @param settings - validated settings.
 * @returns directories.
 */
export function librarySources(settings) {
  return settings.bundledAudio === 'off'
    ? [settings.audioDir]
    : [settings.audioDir, settings.bundledAudioDir]
}

/* ------------------------------------------------------------------ */
/* Library                                                             */
/* ------------------------------------------------------------------ */

/**
 * Display label for one file: a configured override, else the file's own name
 * with the provenance noise sound libraries append stripped off
 * (`…_耳聆网_[声音ID：39642].mp3` reads as `…_耳聆网`).
 * @param fileName - the audio file's name.
 * @param labels - configured overrides.
 * @returns the label to show.
 */
export function labelFor(fileName, labels = {}) {
  const override = labels[fileName]
  /* Trimmed here as well as in normalizeSettings: this is exported, and a
     whitespace-only override must not render as an empty option. */
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const withoutExtension = fileName.replace(/\.[^.]+$/, '')
  /* Drop one trailing bracketed group, then any separator left dangling by it:
     `…_耳聆网_[声音ID：39642].mp3` reads as `…_耳聆网`. */
  const stripped = withoutExtension
    .replace(/[_\-（(\[【][^_\-（(\[【]{0,60}[)）\]】]\s*$/, '')
    .replace(/[_\-\s·]+$/, '')
    .trim()
  /* A name that strips to nothing (a dotfile, say) keeps its own spelling
     rather than rendering an empty option. */
  return stripped === '' ? fileName : stripped
}

/**
 * Resolve one requested track name to a readable file in one directory.
 *
 * Every rejection returns null, and the route answers 404 for all of them: an
 * outside caller learns nothing about the filesystem. Traversal is refused
 * three ways — the decoded name must be one path segment, it must equal its own
 * basename, and the resolved path must sit *directly* in that directory.
 *
 * @param audioDir - one candidate directory.
 * @param requested - the raw (already URL-decoded) name from the request.
 * @param settings - validated settings.
 * @returns `{ path, name, bytes, mime }`, or null.
 */
export function resolveTrackIn(audioDir, requested, settings) {
  if (typeof requested !== 'string' || requested === '') return null
  if (requested.includes('/') || requested.includes('\\') || requested.includes('\0')) return null
  if (requested === '.' || requested === '..') return null
  if (basename(requested) !== requested) return null
  const extension = extname(requested).toLowerCase()
  if (!settings.extensions.includes(extension)) return null
  const root = resolve(audioDir)
  const path = resolve(root, requested)
  /* The strongest form of the same guard: the file must sit directly in the
     library directory, not merely somewhere beneath it. */
  if (dirname(path) !== root) return null
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return null
    if (stats.size === 0 || stats.size > MAX_FILE_BYTES) return null
    return { path, name: requested, bytes: stats.size, mime: MIME_BY_EXTENSION[extension] }
  } catch {
    return null
  }
}

/**
 * Resolve a requested track name against every library source, most specific
 * first, so a name from either the user's directory or the bundled set serves.
 * @param requested - the raw name from the request.
 * @param settings - validated settings.
 * @returns the resolved track, or null.
 */
export function resolveTrack(requested, settings) {
  for (const dir of librarySources(settings)) {
    const track = resolveTrackIn(dir, requested, settings)
    if (track !== null) return track
  }
  return null
}

/**
 * List one directory. A missing or unreadable directory is an empty library,
 * never a failure: the user may not have created it yet.
 * @param audioDir - the directory to read.
 * @param settings - validated settings.
 * @param source - `'user'` or `'bundled'`, recorded on each track.
 * @returns track descriptors.
 */
function listDirectory(audioDir, settings, source) {
  let names
  try {
    names = readdirSync(audioDir)
  } catch {
    return []
  }
  const tracks = []
  for (const entry of names) {
    const track = resolveTrackIn(audioDir, entry, settings)
    if (track === null) continue
    tracks.push({
      name: track.name,
      label: labelFor(track.name, settings.labels),
      bytes: track.bytes,
      mime: track.mime,
      source,
    })
  }
  return tracks
}

/**
 * Build the library the browser chooses from.
 *
 * The bundled clips are what make a fresh install audible, so `bundledAudio`
 * defaults to `fallback`: the user's own directory wins the moment it holds
 * anything usable, and the shipped clips cover the case where it does not exist.
 * `merge` keeps both (the user's copy of a name wins), `off` uses only the
 * user's directory.
 *
 * Ordering is by file name with a plain code-unit comparison, deliberately not
 * `localeCompare`: the first entry is the default selection, and a
 * locale-dependent order would make that differ between machines.
 *
 * @param settings - validated settings.
 * @returns track descriptors, user entries first on a name collision.
 */
export function listTracks(settings) {
  const user = listDirectory(settings.audioDir, settings, 'user')
  if (settings.bundledAudio === 'off') return sortTracks(user)
  const bundled = listDirectory(settings.bundledAudioDir, settings, 'bundled')
  if (settings.bundledAudio === 'merge') {
    const seen = new Set()
    const merged = []
    for (const track of [...user, ...bundled]) {
      if (seen.has(track.name)) continue
      seen.add(track.name)
      merged.push(track)
    }
    return sortTracks(merged)
  }
  return sortTracks(user.length > 0 ? user : bundled)
}

/** Stable, locale-independent ordering shared by every mode. */
function sortTracks(tracks) {
  return [...tracks].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/* ------------------------------------------------------------------ */
/* Cue feed                                                            */
/* ------------------------------------------------------------------ */

/**
 * Collapses a burst of completed turns into one cue.
 *
 * One user-visible task can close several turns (the agent's own turn plus
 * every subagent it spawned), and each one is a genuine `turn/end`. Firing per
 * event would play the cue several times for one completion, so each event
 * re-arms a short trailing timer and only the last one in the window is
 * published. The window is configurable because the right value depends on how
 * much the user uses subagents.
 */
export class CueFeed {
  #settings
  #setTimer
  #clearTimer
  #events = []
  #seq = 0
  #timer = null
  #pending = null

  /**
   * @param settings - validated settings.
   * @param timers - `{ setTimer, clearTimer }`; injectable so the coalescing
   *   window is testable without waiting for it.
   */
  constructor(settings, timers = {}) {
    this.#settings = settings
    this.#setTimer = timers.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.#clearTimer = timers.clearTimer ?? ((handle) => clearTimeout(handle))
  }

  /** Highest published cue id; the browser half's cursor. */
  get latest() {
    return this.#seq
  }

  /** Published cues, oldest first. */
  get events() {
    return [...this.#events]
  }

  /**
   * Record one completed turn and re-arm the coalescing window. A window of
   * zero publishes immediately, so "no coalescing" means exactly that rather
   * than a deferral to the next tick.
   * @param entry - `{ sessionId, turn, reason }`.
   */
  schedule(entry) {
    this.#pending = { ...entry, at: Date.now() }
    if (this.#settings.coalesceMs <= 0) {
      this.publish()
      return
    }
    if (this.#timer !== null) this.#clearTimer(this.#timer)
    this.#timer = this.#setTimer(() => {
      this.#timer = null
      this.publish()
    }, this.#settings.coalesceMs)
  }

  /** Publish whatever the window is holding, if anything. */
  publish() {
    const pending = this.#pending
    if (pending === null) return
    this.#pending = null
    this.#seq += 1
    this.#events.push({ id: this.#seq, ...pending })
    while (this.#events.length > this.#settings.maxEvents) this.#events.shift()
  }

  /**
   * Cues newer than a cursor.
   * @param since - the client's last seen id.
   * @returns matching cues.
   */
  list(since) {
    return this.#events.filter((event) => event.id > since)
  }

  /** Drop the pending window. */
  dispose() {
    if (this.#timer !== null) this.#clearTimer(this.#timer)
    this.#timer = null
    this.#pending = null
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** The library is local content, but only this page has business reading it. */
function sameOrigin(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true
  const host = request.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Request pathname, or null when the URL is unparseable. */
function pathnameOf(request) {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname
  } catch {
    return null
  }
}

/**
 * `GET /state` — the library listing and the current cursor, in one call.
 * @param settings - validated settings.
 * @param feed - the cue feed.
 * @returns the exact-route handler.
 */
export function makeStateHandler(settings, feed) {
  return (request, response) => {
    if (!sameOrigin(request)) {
      json(response, 403, { ok: false, error: 'cross-site-request-rejected' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    json(response, 200, {
      ok: true,
      tracks: listTracks(settings),
      /* Named rather than positional, so the default does not shift when files
         are added or when the sort order changes. */
      defaultTrack: settings.defaultTrack,
      coalesceMs: settings.coalesceMs,
      latest: feed.latest,
      serverTime: Date.now(),
    })
  }
}

/**
 * `GET /events?since=<id>` — cues a client has not seen yet.
 * @param feed - the cue feed.
 * @returns the exact-route handler.
 */
export function makeEventsHandler(feed) {
  return (request, response) => {
    if (!sameOrigin(request)) {
      json(response, 403, { ok: false, error: 'cross-site-request-rejected' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    let since = 0
    try {
      const raw = new URL(request.url ?? EVENTS_PATH, 'http://localhost').searchParams.get('since')
      const parsed = Number(raw)
      if (Number.isFinite(parsed) && parsed >= 0) since = Math.floor(parsed)
    } catch {
      // An unparseable cursor reads from the beginning; the client re-baselines.
    }
    json(response, 200, { ok: true, events: feed.list(since), latest: feed.latest, serverTime: Date.now() })
  }
}

/**
 * Parse one `Range: bytes=start-end` header into a bounded window.
 * @param header - the raw header value.
 * @param size - the file's size.
 * @returns `{ start, end }` inclusive, or null when unsatisfiable/absent.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  let start
  let end
  if (rawStart === '') {
    /* `bytes=-N`: the last N bytes. */
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return null
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start > end || start >= size) return null
  return { start, end }
}

/**
 * `GET /track/<name>` — stream one audio file.
 *
 * Range support is not decoration: an `<audio>` element may open with a range
 * request, and replay after seeking depends on it.
 *
 * @param settings - validated settings.
 * @returns the prefix-route handler.
 */
export function makeTrackHandler(settings) {
  return (request, response) => {
    if (!sameOrigin(request)) {
      response.writeHead(403)
      response.end()
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405)
      response.end()
      return
    }
    const pathname = pathnameOf(request)
    if (pathname === null || !pathname.startsWith(`${TRACK_PREFIX}/`)) {
      response.writeHead(404)
      response.end()
      return
    }
    let requested
    try {
      requested = decodeURIComponent(pathname.slice(TRACK_PREFIX.length + 1))
    } catch {
      response.writeHead(400)
      response.end()
      return
    }
    const track = resolveTrack(requested, settings)
    if (track === null) {
      /* One answer for "missing", "outside the library", and "not audio". */
      response.writeHead(404)
      response.end()
      return
    }
    let body
    try {
      body = readFileSync(track.path)
    } catch {
      response.writeHead(404)
      response.end()
      return
    }
    const range = parseRange(request.headers.range, body.length)
    const common = {
      'content-type': track.mime,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
    }
    if (range === null) {
      response.writeHead(200, { ...common, 'content-length': body.length })
      response.end(request.method === 'HEAD' ? undefined : body)
      return
    }
    const slice = body.subarray(range.start, range.end + 1)
    response.writeHead(206, {
      ...common,
      'content-length': slice.length,
      'content-range': `bytes ${range.start}-${range.end}/${body.length}`,
    })
    response.end(request.method === 'HEAD' ? undefined : slice)
  }
}

/* ------------------------------------------------------------------ */
/* Activation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Watch completed turns and serve the library.
 * @param ctx - Host plugin context.
 * @param config - the Loader row's `config`.
 */
export function apply(ctx, config) {
  const settings = normalizeSettings(config)
  const feed = new CueFeed(settings)

  /* One cue per completed task: every `turn/end` re-arms the window and only the
     last one in it is published, so a subagent burst still plays once. */
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return
      feed.schedule({
        sessionId: typeof session?.id === 'string' ? session.id : null,
        turn: event.data?.turn ?? null,
        reason: event.data?.reason?.kind ?? null,
      })
    })
    return () => {
      off()
      feed.dispose()
    }
  }, 'dsh-audio-reward: completed-turn feed')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: makeStateHandler(settings, feed),
  }), 'dsh-audio-reward: library route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: EVENTS_PATH,
    handler: makeEventsHandler(feed),
  }), 'dsh-audio-reward: cue route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: TRACK_PREFIX,
    handler: makeTrackHandler(settings),
  }), 'dsh-audio-reward: audio route')

  /* Warn only when nothing at all is playable; a missing user directory is the
     normal case for a fresh install, which the bundled clips cover. */
  if (listTracks(settings).length === 0) {
    try {
      ctx.logger?.warn?.(
        `[dsh-audio-reward] 没有可用音频：${settings.audioDir} 不存在或为空，自带的也不可用`,
      )
    } catch {
      // A logger this plugin may not reach is not worth failing activation over.
    }
  }
}
