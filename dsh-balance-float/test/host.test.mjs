/**
 * Host-half tests: the billing rule, the balance parser, and one end-to-end
 * pass through the registered route with the network and the credential seam
 * replaced by fixtures.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BalanceService,
  STATE_PATH,
  fetchBalance,
  makeStateHandler,
  name,
  nextChangeAt,
  normalizeSettings,
  periodAt,
  selectBalanceInfo,
} from '../index.js'

const BEIJING = { utcOffsetMinutes: 480, peakWindows: [[540, 720], [840, 1080]] }

/** Epoch milliseconds for a Beijing wall-clock time on a fixed UTC date. */
function beijing(year, month, day, hours, minutes) {
  return Date.UTC(year, month - 1, day, hours, minutes) - 480 * 60_000
}

test('identity and route are stable', () => {
  assert.equal(name, 'dsh-balance-float')
  assert.equal(STATE_PATH, '/api/dsh-balance-float/state')
})

test('normalizeSettings defaults, clamps, and rejects malformed windows', () => {
  assert.deepEqual(normalizeSettings(undefined), {
    apiKeyRef: 'DEEPSEEK_API_KEY',
    pollMs: 60_000,
    timeoutMs: 10_000,
    utcOffsetMinutes: 480,
    peakWindows: [[540, 720], [840, 1080]],
  })
  const clamped = normalizeSettings({ pollMs: 10, timeoutMs: 10 ** 9, utcOffsetMinutes: 99_999, apiKeyRef: '9bad' })
  assert.equal(clamped.pollMs, 15_000)
  assert.equal(clamped.timeoutMs, 60_000)
  assert.equal(clamped.utcOffsetMinutes, 840)
  assert.equal(clamped.apiKeyRef, 'DEEPSEEK_API_KEY')
  // A window that is inverted, out of range, or non-integer is dropped, and an
  // all-invalid list falls back to the default rule rather than to "no peak".
  assert.deepEqual(normalizeSettings({ peakWindows: [[720, 540], [-1, 10], [0, 2000], ['a', 'b']] }).peakWindows,
    [[540, 720], [840, 1080]])
  assert.deepEqual(normalizeSettings({ peakWindows: [[600, 660]] }).peakWindows, [[600, 660]])
})

test('the weekday peak windows match Beijing wall-clock time', () => {
  // 2026-09-07 is a Monday; 09-12 and 09-13 are the weekend.
  assert.equal(new Date(Date.UTC(2026, 8, 7)).getUTCDay(), 1)
  assert.equal(periodAt(beijing(2026, 9, 7, 8, 59), BEIJING), 'offPeak')
  assert.equal(periodAt(beijing(2026, 9, 7, 9, 0), BEIJING), 'peak')
  assert.equal(periodAt(beijing(2026, 9, 7, 11, 59), BEIJING), 'peak')
  assert.equal(periodAt(beijing(2026, 9, 7, 12, 0), BEIJING), 'offPeak')
  assert.equal(periodAt(beijing(2026, 9, 7, 13, 59), BEIJING), 'offPeak')
  assert.equal(periodAt(beijing(2026, 9, 7, 14, 0), BEIJING), 'peak')
  assert.equal(periodAt(beijing(2026, 9, 7, 17, 59), BEIJING), 'peak')
  assert.equal(periodAt(beijing(2026, 9, 7, 18, 0), BEIJING), 'offPeak')
  assert.equal(periodAt(beijing(2026, 9, 7, 23, 59), BEIJING), 'offPeak')
  // A weekend keeps the off-peak rate inside the weekday windows.
  assert.equal(periodAt(beijing(2026, 9, 12, 10, 0), BEIJING), 'offPeak')
  assert.equal(periodAt(beijing(2026, 9, 13, 15, 0), BEIJING), 'offPeak')
  // 2026-09-11 is a Friday: the next real transition is Monday morning, not a
  // weekend edge that changes nothing.
  assert.equal(periodAt(beijing(2026, 9, 11, 20, 0), BEIJING), 'offPeak')
})

test('nextChangeAt names real transitions only', () => {
  assert.equal(nextChangeAt(beijing(2026, 9, 7, 8, 0), BEIJING), beijing(2026, 9, 7, 9, 0))
  assert.equal(nextChangeAt(beijing(2026, 9, 7, 12, 30), BEIJING), beijing(2026, 9, 7, 14, 0))
  assert.equal(nextChangeAt(beijing(2026, 9, 7, 14, 30), BEIJING), beijing(2026, 9, 7, 18, 0))
  assert.equal(nextChangeAt(beijing(2026, 9, 7, 20, 0), BEIJING), beijing(2026, 9, 8, 9, 0))
  // Friday evening and the whole weekend resolve to Monday 09:00.
  assert.equal(nextChangeAt(beijing(2026, 9, 11, 20, 0), BEIJING), beijing(2026, 9, 14, 9, 0))
  assert.equal(nextChangeAt(beijing(2026, 9, 12, 10, 0), BEIJING), beijing(2026, 9, 14, 9, 0))
  assert.equal(nextChangeAt(beijing(2026, 9, 13, 23, 0), BEIJING), beijing(2026, 9, 14, 9, 0))
  // A rule with no windows can never change state.
  assert.equal(nextChangeAt(Date.now(), { utcOffsetMinutes: 0, peakWindows: [] }), null)
})

test('selectBalanceInfo prefers the funded entry and tolerates junk', () => {
  assert.deepEqual(selectBalanceInfo({
    balance_infos: [
      { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
      { currency: 'CNY', total_balance: '42.80', granted_balance: '2.80', topped_up_balance: '40.00' },
    ],
  }), { currency: 'CNY', totalBalance: 42.8, grantedBalance: 2.8, toppedUpBalance: 40 })
  // A malformed sibling is skipped rather than failing the whole response.
  assert.equal(selectBalanceInfo({
    balance_infos: [{ currency: 'CNY', total_balance: 'oops' }, { currency: 'CNY', total_balance: '1.00' }],
  }).totalBalance, 1)
  assert.throws(() => selectBalanceInfo({ balance_infos: [] }), /no valid balance_infos/)
  assert.throws(() => selectBalanceInfo({}), /no valid balance_infos/)
})

test('fetchBalance surfaces the HTTP status and normalizes the body', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/user/balance')
      assert.equal(init.headers.authorization, 'Bearer sk-test')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: '7.50', granted_balance: '0.00', topped_up_balance: '7.50' }],
        }),
      }
    }
    const balance = await fetchBalance('sk-test', 1_000)
    assert.equal(balance.totalBalance, 7.5)
    assert.equal(balance.currency, 'CNY')
    assert.equal(balance.available, true)
    assert.ok(Number.isFinite(balance.updatedAt))

    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) })
    await assert.rejects(() => fetchBalance('sk-bad', 1_000), /balance HTTP 401/)
  } finally {
    globalThis.fetch = original
  }
})

/** Poll-free service harness: no timers, injected credential answers. */
function makeService(key) {
  const warnings = []
  const ctx = {
    credentials: { resolve: async () => (key === undefined ? undefined : { value: key, source: 'file' }) },
    logger: { warn: (message) => warnings.push(message) },
  }
  return { service: new BalanceService(ctx, normalizeSettings(undefined)), warnings }
}

test('the service reports ok, unconfigured, and error states without throwing', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '42.80', granted_balance: '2.80', topped_up_balance: '40.00' }],
      }),
    })
    const ok = makeService('sk-test')
    assert.equal((await ok.service.refresh(true)).status, 'ok')
    assert.equal(ok.service.state.balance.totalBalance, 42.8)

    const missing = makeService(undefined)
    const missingState = await missing.service.refresh(true)
    assert.equal(missingState.status, 'unconfigured')
    assert.equal(missingState.balance, null)
    assert.match(missing.warnings[0], /未配置 DEEPSEEK_API_KEY/)

    globalThis.fetch = async () => {
      throw new Error('network down')
    }
    const failing = makeService('sk-test')
    assert.equal((await failing.service.refresh(true)).status, 'error')
    assert.equal(failing.service.state.balance, null)
    assert.match(failing.service.state.error, /network down/)
  } finally {
    globalThis.fetch = original
  }
})

test('the route answers the browser half and refuses other callers', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' }],
      }),
    })
    const { service } = makeService('sk-test')
    const handler = makeStateHandler(service, normalizeSettings(undefined))
    const call = async (overrides = {}) => {
      const request = { method: 'GET', url: STATE_PATH, headers: { host: '127.0.0.1:19387' }, ...overrides }
      const captured = {}
      const response = {
        writeHead: (status, headers) => {
          captured.status = status
          captured.headers = headers
        },
        end: (body) => {
          captured.body = JSON.parse(body)
        },
      }
      await handler(request, response)
      return captured
    }

    const ok = await call({ url: `${STATE_PATH}?refresh=1` })
    assert.equal(ok.status, 200)
    assert.equal(ok.headers['cache-control'], 'no-store')
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.status, 'ok')
    assert.equal(ok.body.balance.totalBalance, 12.34)
    assert.equal(ok.body.schedule.utcOffsetMinutes, 480)
    assert.deepEqual(ok.body.schedule.peakWindows, [[540, 720], [840, 1080]])
    assert.ok(['peak', 'offPeak'].includes(ok.body.period))
    assert.equal(typeof ok.body.serverTime, 'number')
    // The published period must agree with the published rule at the published time.
    assert.equal(ok.body.period, periodAt(ok.body.serverTime, ok.body.schedule))
    assert.equal(ok.body.periodEndsAt, nextChangeAt(ok.body.serverTime, ok.body.schedule))

    const crossSite = await call({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } })
    assert.equal(crossSite.status, 403)
    assert.equal(crossSite.body.error, 'cross-site-request-rejected')

    const foreignOrigin = await call({ headers: { host: '127.0.0.1:19387', origin: 'http://evil.test' } })
    assert.equal(foreignOrigin.status, 403)

    const sameOrigin = await call({ headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' } })
    assert.equal(sameOrigin.status, 200)

    const posted = await call({ method: 'POST' })
    assert.equal(posted.status, 405)

    // The key itself never appears in any payload.
    assert.doesNotMatch(JSON.stringify(ok.body), /sk-test/)
  } finally {
    globalThis.fetch = original
  }
})

test('apply registers the polling effect and the exact route', () => {
  const effects = []
  const routes = []
  const ctx = {
    credentials: { resolve: async () => undefined },
    logger: { warn: () => {} },
    effect: (execute, label) => {
      const dispose = execute()
      effects.push({ label, dispose })
      return () => dispose?.()
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  // Import lazily so the test file's own imports stay side-effect free.
  return import('../index.js').then(({ apply }) => {
    apply(ctx, { pollMs: 1 })
    assert.equal(routes.length, 1)
    assert.equal(routes[0].kind, 'exact')
    assert.equal(routes[0].path, STATE_PATH)
    assert.equal(typeof routes[0].handler, 'function')
    assert.deepEqual(effects.map((entry) => entry.label), [
      'dsh-balance-float: balance polling',
      'dsh-balance-float: snapshot route',
    ])
    for (const entry of effects) assert.equal(typeof entry.dispose, 'function')
    // The polling effect must own a timer the disposer can stop.
    assert.doesNotThrow(() => effects[0].dispose())
  })
})
