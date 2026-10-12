# cache-warmer

Keeps Claude Code's prompt cache warm while you are away from the session.

The prompt cache expires a fixed time after the last request (1 hour on most
plans, 5 minutes on some). When it goes cold, your next message re-sends the
whole conversation at full input price. This mod watches for idle time and,
just before the cache would expire, sends one tiny tool-less question through
`$.model.fork`. That request reuses the session's cached prefix, which resets
its expiry. **Nothing is added to your conversation.**

## Behaviour

- Each real request of the main thread restarts the idle clock.
- After `intervalMinutes` without a request (default 50), it pings.
- After `maxPings` pings in a row (default 3), it stops, so a session you
  have abandoned does not keep costing money. Your next message re-arms it.
- If a ping finds the cache already cold (0 cached tokens read), it stops at
  once and says so: pinging would only re-buy the cache.
- The status line shows the last ping: tokens read from cache, tokens written.

## Cost

Measured on an ~83k-token session: the ping read 79.5k tokens from the cache
and wrote 3.1k, costing about $0.03. Letting the cache expire costs a full
re-write of the conversation on your next message.

## Commands

- `/cache-warmer`: state (idle time, pings used, last result)
- `/cache-warmer ping`: ping now

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `intervalMinutes` | 50 | Idle minutes before a ping. Keep under the cache TTL (use 4 for a 5-minute cache). |
| `maxPings` | 3 | Pings in a row without activity from you before it gives up. |
