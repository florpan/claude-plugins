import { expect, test } from 'claude-code/testing'
import { autoMemoryFile, episodeUuid, parseEpisode, parseVerdict, projectName, projectRoot, settingsPaths, withKnowledgeId } from '../hooks/register'

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

test('a memory folder maps to its project root even after a cd into a subfolder', () => {
  expect(projectRoot('C:\\Dev\\lab', 'C--Dev-lab')).toBe('C:\\Dev\\lab')
  expect(projectRoot('C:\\Dev\\lab\\memory-explorer', 'C--Dev-lab')).toBe('C:\\Dev\\lab')
  expect(projectRoot('C:\\Dev\\lab\\knowledge-mcp\\src', 'C--Dev-lab')).toBe('C:\\Dev\\lab')
  expect(projectRoot('/home/x/app/web', '-home-x-app')).toBe('/home/x/app')
  expect(projectRoot('C:\\Dev\\lab', 'C--Dev-RagBase2')).toBeNull() // another project's memory
})

test('auto-memory paths are recognised, the index is not', () => {
  expect(autoMemoryFile('C:\\Users\\x\\.claude\\projects\\C--dev-lab\\memory\\note.md')).toEqual({ dir: 'C--dev-lab', project: 'lab', file: 'note.md' })
  expect(autoMemoryFile('/home/x/.claude/projects/-home-x-app/memory/MEMORY.md')).toBeNull()
  expect(autoMemoryFile('C:\\Dev\\app\\README.md')).toBeNull()
})

test('verdicts and episodes parse', () => {
  expect(parseVerdict('SKIP')).toBeNull()
  expect(parseVerdict('LEARNING: route order matters')).toEqual({ kind: 'LEARNING', what: 'route order matters' })
  expect(parseEpisode('```json\n{"name": "Route order", "body": "Body"}\n```')).toEqual({ action: 'new', kind: undefined, name: 'Route order', body: 'Body' })
  expect(parseEpisode('{"action": "correction", "kind": "learning", "name": "N", "body": "B"}')).toEqual({ action: 'correction', kind: 'LEARNING', name: 'N', body: 'B' })
  expect(parseEpisode('{"action": "skip", "name": "N", "body": "B"}')).toBeNull()
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

test('a memory file always maps to the same episode id (UUID v5, URL namespace)', async () => {
  expect(await episodeUuid('knowledge-memory:project_lab/note.md')).toBe('c4e94053-5b7c-576c-a78e-f2022bf31016')
})

test('the episode id goes into the frontmatter once', () => {
  const id = 'c4e94053-5b7c-576c-a78e-f2022bf31016'
  const withMeta = '---\nname: a\nmetadata:\n    type: project\n---\n\nBody'
  expect(withKnowledgeId(withMeta, id)).toBe(`---\nname: a\nmetadata:\n    knowledge_id: ${id}\n    type: project\n---\n\nBody`)
  expect(withKnowledgeId(withKnowledgeId(withMeta, id)!, id)).toBeNull()
  expect(withKnowledgeId('---\nname: a\n---\nBody', id)).toBe(`---\nname: a\nknowledge_id: ${id}\n---\nBody`)
  expect(withKnowledgeId('---\r\nname: a\r\nknowledge_id: old\r\n---\r\nBody', id)).toBe(`---\r\nname: a\r\nknowledge_id: ${id}\r\n---\r\nBody`)
  expect(withKnowledgeId('# No frontmatter', id)).toBeNull()
})

const factsReply = (facts: object[]) => ({ value: { content: [{ type: 'text', text: JSON.stringify({ message: 'ok', facts }) }], isError: false } })

test('the writer sees what the graph already knows and can skip', async ($, on) => {
  engine(on)
  let asked = ''
  let wrote = false
  on('model.complete', () => answer('LEARNING: auth middleware before webhook route blocks Stripe'))
  on('model.fork', (_$: any, e: any) => { asked = e.prompt; return answer('{"action": "skip", "name": "", "body": ""}') })
  on('mcp.call', (_$: any, e: any) => {
    if (JSON.stringify(e).includes('search_memory_facts')) return factsReply([{ fact: 'Webhook routes go before auth middleware', created_at: '2026-10-01T10:00:00Z', expired_at: null }])
    wrote = true
    return { value: { content: [], isError: false } }
  })
  const r = await $.command.run({ command: 'knowledge-memory', args: 'now' })
  expect(asked).toContain('- 2026-10-01 Webhook routes go before auth middleware')
  expect(r.text).toContain('skipped by the writer')
  expect(wrote).toBe(false)
})

test('a correction is saved and marked', async ($, on) => {
  engine(on)
  const calls: any[] = []
  on('model.complete', () => answer('PROJECT: webhook route now registered after auth'))
  on('model.fork', () => answer('{"action": "correction", "name": "Webhook route order changed", "body": "Now after auth, not before as saved earlier."}'))
  on('mcp.call', (_$: any, e: any) => { calls.push(e); return factsReply([]) })
  const r = await $.command.run({ command: 'knowledge-memory', args: 'now' })
  expect(r.text).toContain('correction saved to project_')
  expect(JSON.stringify(calls)).toContain('| correction')
})

test('save <what> skips the judge and lets the writer pick the group', async ($, on) => {
  engine(on)
  let judged = false
  let asked = ''
  const calls: any[] = []
  on('model.complete', () => { judged = true; return answer('SKIP') })
  on('model.fork', (_$: any, e: any) => { asked = e.prompt; return answer('{"action": "new", "kind": "learning", "name": "Bun stdin blocks without EOF", "body": "Close stdin."}') })
  on('mcp.call', (_$: any, e: any) => { calls.push(e); return factsReply([]) })
  const r = await $.command.run({ command: 'knowledge-memory', args: 'save bun stdin needs EOF' })
  expect(judged).toBe(false)
  expect(asked).toContain('The user asked to save this to the knowledge graph: bun stdin needs EOF')
  expect(r.text).toContain('saved to learning: Bun stdin blocks without EOF')
})
