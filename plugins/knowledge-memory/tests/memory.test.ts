import { expect, test } from 'claude-code/testing'
import { autoMemoryFile, parseEpisode, parseVerdict, projectName, settingsPaths } from '../hooks/register'

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const answer = (text: string) => ({ value: { isAnswered: true, text, usage } })

const turn = [
  { role: 'user', text: 'Why does the webhook return 401?', toolUses: [] },
  { role: 'assistant', text: 'The auth middleware was registered before the webhook route, so Stripe calls were rejected. '.repeat(4), toolUses: [] },
]

// Engine calls the mod makes besides the model and the MCP server
// With settings, the session runs in RagBase2\backend and RagBase2\.claude\memory.json holds them
const engine = (on: any, settings?: object) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.status', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: settings ? 'C:\\Dev\\RagBase2\\backend' : 'C:\\Dev\\RagBase2' }))
  on('session.messages', () => ({ value: turn }))
  on('fs.exists', (_$: any, e: any) => ({ value: !!settings && e.path.endsWith('RagBase2\\.claude\\memory.json') }))
  if (settings) on('fs.read', () => ({ value: JSON.stringify(settings) }))
}

test('project names follow the old sync hook', () => {
  expect(projectName('C--Dev-RagBase2')).toBe('Dev-RagBase2') // only lowercase "dev" is stripped, as before
  expect(projectName('C--dev-pai-upgrade-workspace')).toBe('pai-upgrade-workspace')
  expect(projectName('C--Users-chris')).toBe('Users-chris')
})

test('settings are looked for from the folder up', () => {
  expect(settingsPaths('C:\\Dev\\lab')).toEqual(['C:\\Dev\\lab\\.claude\\memory.json', 'C:\\Dev\\.claude\\memory.json', 'C:\\.claude\\memory.json'])
  expect(settingsPaths('/home/x/')).toEqual(['/home/x/.claude/memory.json', '/home/.claude/memory.json', '/.claude/memory.json'])
})

test('auto-memory paths are recognised, the index is not', () => {
  expect(autoMemoryFile('C:\\Users\\x\\.claude\\projects\\C--dev-lab\\memory\\note.md')).toEqual({ dir: 'C--dev-lab', project: 'lab', file: 'note.md' })
  expect(autoMemoryFile('/home/x/.claude/projects/-home-x-app/memory/MEMORY.md')).toBeNull()
  expect(autoMemoryFile('C:\\Dev\\app\\README.md')).toBeNull()
})

test('verdicts and episodes parse', () => {
  expect(parseVerdict('SKIP')).toBeNull()
  expect(parseVerdict('LEARNING: route order matters')).toEqual({ kind: 'LEARNING', what: 'route order matters' })
  expect(parseEpisode('```json\n{"name": "Route order", "body": "Body"}\n```')).toEqual({ name: 'Route order', body: 'Body' })
  expect(parseEpisode('{"name": "", "body": ""}')).toBeNull()
})

test('a learning is written to the learning group', async ($, on) => {
  engine(on)
  const calls: any[] = []
  on('model.complete', () => answer('LEARNING: auth middleware before webhook route blocks Stripe'))
  on('model.fork', () => answer('{"name": "Webhook blocked by auth middleware", "body": "Register the webhook route before auth."}'))
  on('mcp.call', (_$: any, e: any) => { calls.push(e); return { value: { content: [], isError: false } } })
  const r = await $.command.run({ command: 'knowledge-memory', args: 'now' })
  expect(r.text).toContain('saved to learning: Webhook blocked by auth middleware')
  expect(JSON.stringify(calls)).toContain('"group_id":"learning"')
})

test('a project fact goes to project_<name>', async ($, on) => {
  engine(on)
  on('model.complete', () => answer('PROJECT: webhook route registered first'))
  on('model.fork', () => answer('{"name": "Webhook route order", "body": "In RagBase2 the webhook route is registered first."}'))
  on('mcp.call', () => ({ value: { content: [], isError: false } }))
  const r = await $.command.run({ command: 'knowledge-memory', args: 'now' })
  expect(r.text).toContain('saved to project_')
})

test('SKIP never forks or writes', async ($, on) => {
  engine(on)
  let touched = false
  on('model.complete', () => answer('SKIP'))
  on('model.fork', () => { touched = true; return answer('{}') })
  on('mcp.call', () => { touched = true; return { value: { content: [], isError: false } } })
  const r = await $.command.run({ command: 'knowledge-memory', args: 'now' })
  expect(r.text).toContain('skipped')
  expect(touched).toBe(false)
})

test('memory.json names the group and guides the judge', async ($, on) => {
  engine(on, { group: 'project_rag', save: 'chunking decisions', skip: 'UI tweaks' })
  let judged = ''
  on('model.complete', (_$: any, e: any) => { judged = e.prompt; return answer('PROJECT: webhook route registered first') })
  on('model.fork', () => answer('{"name": "Webhook route order", "body": "The webhook route is registered first."}'))
  on('mcp.call', () => ({ value: { content: [], isError: false } }))
  const r = await $.command.run({ command: 'knowledge-memory', args: 'now' })
  expect(r.text).toContain('saved to project_rag')
  expect(judged).toContain('Save: chunking decisions')
  expect(judged).toContain('Skip: UI tweaks')
  const status = await $.command.run({ command: 'knowledge-memory' })
  expect(status.text).toContain('RagBase2\\.claude\\memory.json')
})

test('a memory.json without a group keeps the folder name', async ($, on) => {
  engine(on, { save: 'anything' })
  on('model.complete', () => answer('PROJECT: something lasting'))
  on('model.fork', () => answer('{"name": "Fact", "body": "Body"}'))
  on('mcp.call', () => ({ value: { content: [], isError: false } }))
  const r = await $.command.run({ command: 'knowledge-memory', args: 'now' })
  expect(r.text).toContain('saved to project_Dev-RagBase2-backend')
})
