import { expect, test } from 'claude-code/testing'

const usage = (read: number, wrote = 0) => ({
  input_tokens: 10,
  output_tokens: 2,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: wrote,
})

// The engine calls the mod makes besides model.fork
const engine = (on: any) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

test('a ping that hits the cache reports the cached tokens', async ($, on) => {
  engine(on)
  on('model.fork', () => ({ value: { isAnswered: true, text: 'ok', usage: usage(42_000) } }))
  const r = await $.command.run({ command: 'cache-warmer', args: 'ping' })
  expect(r.text).toContain('read 42000 cached tokens')
})

test('a ping that misses the cache stops pinging', async ($, on) => {
  engine(on)
  on('model.fork', () => ({ value: { isAnswered: true, text: 'ok', usage: usage(0, 42_000) } }))
  const r = await $.command.run({ command: 'cache-warmer', args: 'ping' })
  expect(r.text).toContain('missed the cache')
})

test('nothing to fork is reported, not counted as a ping', async ($, on) => {
  engine(on)
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  const r = await $.command.run({ command: 'cache-warmer', args: 'ping' })
  expect(r.text).toContain('nothing-to-fork')
})

test('the status command answers without pinging', async ($, on) => {
  engine(on)
  let forked = false
  on('model.fork', () => { forked = true; return { value: { isAnswered: false, reason: 'nothing-to-fork' } } })
  const r = await $.command.run({ command: 'cache-warmer', args: '' })
  expect(r.text).toContain('pings every 50 min idle')
  expect(forked).toBe(false)
})
