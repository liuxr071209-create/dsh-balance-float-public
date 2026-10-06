/**
 * dsh-balance-float — Host half.
 *
 * Owns everything that must not happen in the browser:
 *
 *   - resolving the DeepSeek API key through the credential seam;
 *   - polling `GET https://api.deepseek.com/user/balance` and caching the last
 *     answer;
 *   - publishing the billing-schedule *rule* the browser half evaluates
 *     against its own clock;
 *   - serving both to the browser half over one same-origin JSON route.
 *
 * The API key never leaves this process: the route exposes the cached snapshot
 * only. This module deliberately imports nothing, so a profile install keeps
 * working without a resolvable Harness dependency tree next to the package.
 *
 * @module dsh-balance-float
 */

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/** Loader row id; the browser bundle registers its factory under the same id. */
export const name = 'dsh-balance-float'

/** `credentials` resolves the account key; `webServer` carries the snapshot route. */
export const inject = ['credentials', 'webServer']

/** Same-origin JSON snapshot consumed by the browser half. */
export const STATE_PATH = '/api/dsh-balance-float/state'

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const DEFAULT_API_KEY_REF = 'DEEPSEEK_API_KEY'
const DEFAULT_POLL_MS = 60_000
const MIN_POLL_MS = 15_000
const MAX_POLL_MS = 3_600_000
const DEFAULT_TIMEOUT_MS = 10_000
/** A page that reloads repeatedly must not turn into an API hammer. */
const FORCED_REFRESH_COOLDOWN_MS = 5_000
const MIN_UTC_OFFSET_MINUTES = -14 * 60
const MAX_UTC_OFFSET_MINUTES = 14 * 60
/** Beijing time (UTC+8, no DST): weekdays 09:00-12:00 and 14:00-18:00. */
const DEFAULT_UTC_OFFSET_MINUTES = 480
const DEFAULT_PEAK_WINDOWS = [[540, 720], [840, 1080]]
const MINUTES_PER_DAY = 1440

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** Clamp a number into a range, ignoring anything that is not finite. */
function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Accept one `[start, end)` pair in minutes-from-midnight, or reject it. */
function normalizeWindow(value) {
  if (!Array.isArray(value) || value.length !== 2) return null
  const [start, end] = value
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 0 || end > MINUTES_PER_DAY || start >= end) return null
  return [start, end]
}

/**
 * Turn the Loader row's `config` into a total, validated settings object.
 * A malformed value falls back to the default rather than failing activation:
 * the plugin is a convenience surface, never a boot dependency.
 * @param raw - the row config, or undefined when the patch declares none.
 * @returns validated settings.
 */
export function normalizeSettings(raw) {
  const config = typeof raw === 'object' && raw !== null ? raw : {}
  const windows = Array.isArray(config.peakWindows)
    ? config.peakWindows.map(normalizeWindow).filter((entry) => entry !== null)
    : []
  return {
    apiKeyRef: typeof config.apiKeyRef === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyRef)
      ? config.apiKeyRef
      : DEFAULT_API_KEY_REF,
    pollMs: clampNumber(config.pollMs, MIN_POLL_MS, MAX_POLL_MS, DEFAULT_POLL_MS),
    timeoutMs: clampNumber(config.timeoutMs, 1_000, 60_000, DEFAULT_TIMEOUT_MS),
    utcOffsetMinutes: clampNumber(
      config.utcOffsetMinutes,
      MIN_UTC_OFFSET_MINUTES,
      MAX_UTC_OFFSET_MINUTES,
      DEFAULT_UTC_OFFSET_MINUTES,
    ),
    peakWindows: windows.length > 0 ? windows : DEFAULT_PEAK_WINDOWS.map((pair) => [...pair]),
  }
}

/* ------------------------------------------------------------------ */
/* Billing schedule                                                    */
/* ------------------------------------------------------------------ */

/**
 * The billing period at one instant.
 *
 * The clock is evaluated in the schedule's own fixed-offset zone by shifting
 * the epoch before reading the UTC fields, so no locale data is involved.
 * Weekend days never bill at the peak rate: the caller's windows describe a
 * weekday only.
 * @param timestamp - epoch milliseconds.
 * @param schedule - `{ utcOffsetMinutes, peakWindows }`.
 * @returns `'peak'` or `'offPeak'`.
 */
export function periodAt(timestamp, schedule) {
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
 * The first instant strictly after `timestamp` at which {@link periodAt}
 * actually changes. Candidate boundaries that leave the period unchanged (a
 * weekend window edge, for example) are skipped, so the browser half's
 * "until HH:MM" line always names a real transition.
 * @param timestamp - epoch milliseconds.
 * @param schedule - `{ utcOffsetMinutes, peakWindows }`.
 * @returns epoch milliseconds, or null when the rule declares no windows.
 */
export function nextChangeAt(timestamp, schedule) {
  const offsetMs = schedule.utcOffsetMinutes * 60_000
  const local = new Date(timestamp + offsetMs)
  const year = local.getUTCFullYear()
  const month = local.getUTCMonth()
  const date = local.getUTCDate()
  const boundaries = [...new Set(schedule.peakWindows.flat())].sort((left, right) => left - right)
  if (boundaries.length === 0) return null
  const current = periodAt(timestamp, schedule)
  /* Eight days always covers the longest real gap (Friday evening to Monday
     morning); a fortnight leaves margin for a rule with wider windows. */
  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    for (const minutes of boundaries) {
      const candidate = Date.UTC(year, month, date + dayOffset, Math.floor(minutes / 60), minutes % 60) - offsetMs
      if (candidate > timestamp && periodAt(candidate, schedule) !== current) return candidate
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Balance                                                             */
/* ------------------------------------------------------------------ */

/** Money arrives as decimal strings; anything else is a protocol error. */
function parseAmount(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`balance response has invalid ${field}`)
  const amount = Number(value)
  if (!Number.isFinite(amount)) throw new Error(`balance response has invalid ${field}`)
  return amount
}

/**
 * The granted/topped-up split decorates the total and is not always present in
 * a compatible response, so a missing or unreadable one reads as zero instead
 * of failing the whole snapshot.
 * @param value - the raw field.
 * @returns a finite amount.
 */
function parseOptionalAmount(value) {
  if (typeof value !== 'string' || value.trim() === '') return 0
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : 0
}

function parseEntry(raw) {
  const currency = typeof raw?.currency === 'string' ? raw.currency.trim().toUpperCase() : ''
  if (currency === '') throw new Error('balance response has invalid currency')
  return {
    currency,
    totalBalance: parseAmount(raw.total_balance, 'total_balance'),
    grantedBalance: parseOptionalAmount(raw.granted_balance),
    toppedUpBalance: parseOptionalAmount(raw.topped_up_balance),
  }
}

/**
 * Pick one funded entry when the API returns currencies in arbitrary order:
 * funded first, then CNY, then the largest total, then the currency code.
 * @param response - the decoded `/user/balance` body.
 * @returns the selected entry.
 */
export function selectBalanceInfo(response) {
  const entries = []
  for (const info of Array.isArray(response?.balance_infos) ? response.balance_infos : []) {
    try {
      entries.push(parseEntry(info))
    } catch {
      // One malformed currency must not hide a well-formed sibling.
    }
  }
  if (entries.length === 0) throw new Error('balance response has no valid balance_infos')
  entries.sort((left, right) => {
    const funded = Number(right.totalBalance > 0) - Number(left.totalBalance > 0)
    if (funded !== 0) return funded
    const preferred = Number(right.currency === 'CNY') - Number(left.currency === 'CNY')
    if (preferred !== 0) return preferred
    const total = right.totalBalance - left.totalBalance
    if (total !== 0) return total
    return left.currency.localeCompare(right.currency)
  })
  return entries[0]
}

/**
 * Query the account balance once.
 * @param apiKey - the resolved platform API key.
 * @param timeoutMs - per-request bound.
 * @returns the display-ready balance.
 */
export async function fetchBalance(apiKey, timeoutMs) {
  const response = await fetch(BALANCE_URL, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`balance HTTP ${response.status}`)
  const body = await response.json()
  return {
    ...selectBalanceInfo(body),
    available: body?.is_available !== false,
    updatedAt: Date.now(),
  }
}

/* ------------------------------------------------------------------ */
/* Balance service                                                     */
/* ------------------------------------------------------------------ */

/**
 * Report a contained problem. Logging is diagnostic only, so an unavailable or
 * restricted logger must never turn a handled failure into an unhandled one.
 * @param ctx - Host plugin context.
 * @param message - the line to report.
 */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(message)
  } catch {
    // A logger the plugin may not reach is not worth failing a poll over.
  }
}

/**
 * Polls the balance and keeps the last answer. Every failure is contained and
 * surfaced as a state the card renders, never as a rejected effect.
 */
export class BalanceService {
  #ctx
  #settings
  #timer
  #lastAttemptAt = 0
  #warnedMissingKey = false
  #state = { status: 'pending', balance: null, error: null }

  /**
   * @param ctx - Host plugin context carrying `credentials`.
   * @param settings - validated settings from {@link normalizeSettings}.
   */
  constructor(ctx, settings) {
    this.#ctx = ctx
    this.#settings = settings
  }

  /** Current publishable state. */
  get state() {
    return this.#state
  }

  /**
   * Resolve the API key for this operation only, so a credential change reaches
   * the next poll without a plugin restart.
   * @returns the key, or undefined when it is not configured.
   */
  async #resolveApiKey() {
    const resolved = await this.#ctx.credentials.resolve(this.#settings.apiKeyRef)
    const value = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
    return value === '' ? undefined : value
  }

  /**
   * Fetch once and update the cached state.
   * @param force - bypass the cooldown (used by the interval, not by callers).
   * @returns the updated state.
   */
  async refresh(force = false) {
    const now = Date.now()
    if (!force && now - this.#lastAttemptAt < FORCED_REFRESH_COOLDOWN_MS) return this.#state
    this.#lastAttemptAt = now
    try {
      const apiKey = await this.#resolveApiKey()
      if (apiKey === undefined) {
        if (!this.#warnedMissingKey) {
          this.#warnedMissingKey = true
          warn(this.#ctx, `[dsh-balance-float] 未配置 ${this.#settings.apiKeyRef}，余额卡片将显示未配置状态`)
        }
        this.#state = { status: 'unconfigured', balance: this.#state.balance, error: null }
        return this.#state
      }
      const balance = await fetchBalance(apiKey, this.#settings.timeoutMs)
      this.#state = { status: 'ok', balance, error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#state = { status: 'error', balance: this.#state.balance, error: message }
      warn(this.#ctx, `[dsh-balance-float] 余额查询失败: ${message}`)
    }
    return this.#state
  }

  /** Start polling; the caller owns the returned disposer. */
  start() {
    void this.refresh(true)
    this.#timer = setInterval(() => void this.refresh(true), this.#settings.pollMs)
    return () => {
      if (this.#timer !== undefined) clearInterval(this.#timer)
      this.#timer = undefined
    }
  }
}

/* ------------------------------------------------------------------ */
/* Route                                                              */
/* ------------------------------------------------------------------ */

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** Reject cross-site reads: the snapshot is account data, not public content. */
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

/**
 * The browser half's only data access. `?refresh=1` asks for a fresh API read,
 * rate-limited by the service so a reloading page cannot hammer the endpoint.
 * @param service - the balance service.
 * @param settings - validated settings.
 * @returns the exact-route handler.
 */
export function makeStateHandler(service, settings) {
  return async (request, response) => {
    if (!sameOrigin(request)) {
      json(response, 403, { ok: false, error: 'cross-site-request-rejected' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    let url
    try {
      url = new URL(request.url ?? STATE_PATH, 'http://localhost')
    } catch {
      json(response, 400, { ok: false, error: 'invalid-url' })
      return
    }
    if (url.searchParams.get('refresh') === '1') await service.refresh()
    const serverTime = Date.now()
    const schedule = {
      timeZone: 'fixed-offset',
      utcOffsetMinutes: settings.utcOffsetMinutes,
      peakWindows: settings.peakWindows,
    }
    json(response, 200, {
      ok: true,
      status: service.state.status,
      balance: service.state.balance,
      error: service.state.error,
      schedule,
      period: periodAt(serverTime, schedule),
      periodEndsAt: nextChangeAt(serverTime, schedule),
      serverTime,
    })
  }
}

/* ------------------------------------------------------------------ */
/* Activation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Start polling and register the snapshot route.
 * @param ctx - Host plugin context.
 * @param config - the Loader row's `config`.
 */
export function apply(ctx, config) {
  const settings = normalizeSettings(config)
  const service = new BalanceService(ctx, settings)
  ctx.effect(() => service.start(), 'dsh-balance-float: balance polling')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: makeStateHandler(service, settings),
  }), 'dsh-balance-float: snapshot route')
}
