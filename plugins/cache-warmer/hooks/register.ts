// cache-warmer: keeps the prompt cache warm while the session sits idle.
//
// The prompt cache expires a fixed time after the last request (5 minutes or
// 1 hour). When the main thread has been quiet for `intervalMinutes`, this mod
// asks one tiny question through $.model.fork: a tool-less request over the
// session's own transcript, served from the cache, which refreshes its TTL.
// Nothing is added to the conversation. After `maxPings` pings in a row with
// no activity from you, it stops, so an abandoned session does not keep paying.

import type { EngineInterface, Register } from 'claude-code'

const MIN = 60_000
const PING = 'Cache keep-alive ping. Reply with exactly: ok'

let interval = 50 * MIN // set from options in register
let maxPings = 3
let lastAt = 0 // when the main thread last sent a request (ms); 0 = nothing to keep warm
let pings = 0 // pings since the last real request
let working = false // a turn is running
let pinging = false // a ping is in flight
let lastResult = 'no ping yet'

async function ping($: EngineInterface): Promise<string> {
  pinging = true
  try {
    const r = await $.model.fork({ prompt: PING })
    const now = await $.clock.now()
    if (!r.isAnswered) {
      if (r.reason === 'nothing-to-fork') lastAt = 0
      else pings++ // count failures too, so a broken API cannot loop us
      lastResult = 'failed: ' + r.reason
      return lastResult
    }
    const read = r.usage.cache_read_input_tokens ?? 0
    const wrote = r.usage.cache_creation_input_tokens ?? 0
    if (read === 0) {
      // The cache was already cold (or the fork missed it); pinging on just re-buys it
      pings = maxPings
      lastResult = `missed the cache (wrote ${wrote} tokens); stopped until your next message`
      $.ui.toast('cache-warmer: ping missed the cache, so it stopped. Your next message restarts it.')
    } else {
      pings++
      lastAt = now
      lastResult = `ping ${pings}/${maxPings}: read ${read} cached tokens, wrote ${wrote}`
    }
    $.ui.status(`cache warm · ${lastResult}`)
    return lastResult
  } finally {
    pinging = false
  }
}

async function tick($: EngineInterface): Promise<void> {
  if (!lastAt || working || pinging || pings >= maxPings) return
  if ((await $.clock.now()) - lastAt < interval) return
  await ping($)
}

export const register: Register = (on, options) => {
  interval = Math.max(1, Number(options.intervalMinutes ?? 50)) * MIN
  maxPings = Math.max(0, Number(options.maxPings ?? 3))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache-warmer',
      description: 'Show the cache-warmer state; "/cache-warmer ping" pings now',
      argumentHint: '[ping]',
    })
    $.clock.every(MIN, () => tick($))
    return next(e)
  })

  // A /clear empties the conversation: nothing left to keep warm
  on('session.end', async ($, e, next) => {
    lastAt = 0
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    working = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    working = false
    return next(e)
  })

  // Each real request of the main thread refreshes the cache: restart the clock
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId && !pinging) {
      lastAt = await $.clock.now()
      pings = 0
      $.ui.status(undefined)
    }
    return yield* next(e)
  })

  on('command.run', { command: 'cache-warmer' }, async ($, e) => {
    if ((e.args ?? '').trim() === 'ping') return { text: 'cache-warmer: ' + (await ping($)) }
    const idle = lastAt ? Math.round(((await $.clock.now()) - lastAt) / MIN) : null
    return {
      text: [
        `cache-warmer: pings every ${interval / MIN} min idle, at most ${maxPings} in a row.`,
        idle === null ? 'No request yet in this conversation.' : `Idle ${idle} min, ${pings}/${maxPings} pings used.`,
        `Last: ${lastResult}`,
      ].join('\n'),
    }
  })
}
