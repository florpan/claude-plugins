// knowledge-memory: saves what a session learns straight into a Graphiti
// knowledge graph, a little after every turn, instead of in bulk at the next
// session start.
//
// After each main-thread turn:
//   1. A small model (Haiku by default) reads the last exchange and answers
//      SKIP, LEARNING: <what> (reusable across projects) or PROJECT: <what>
//      (specific to this project).
//   2. Only when it is not SKIP, the graph is searched for what the judge
//      flagged, and a tool-less $.model.fork gets the facts it already holds.
//      The fork replays the session's own transcript from the prompt cache, so
//      it has the full context at a fraction of the price. It answers skip
//      (already known), correction (states what it replaces) or new, and
//      drafts the episode.
//   3. The episode goes to the graph's MCP server through $.mcp.call:
//      `learningGroup` for learnings, `project_<name>` for project facts.
// "/knowledge-memory save <what>" runs step 2-3 on demand, without the judge.
//
// A project can steer it with .claude/memory.json, found by walking up from the
// session's folder: `group` names the project's group, `save` and `skip` guide
// the judge. Without one the group comes from the folder name.
//
// It also mirrors Claude Code's file-based auto-memory: every Write or Edit of
// a file under ~/.claude/projects/<project>/memory/ replaces that file's one
// episode in the graph. The episode id is derived from the group and file name,
// and written into the file's frontmatter as knowledge_id.

import type { EngineInterface, Register, SessionMessage } from 'claude-code'

const JUDGE = `You decide whether one turn of a coding session taught something worth keeping in a long-term knowledge graph.

Answer LEARNING when the turn established something reusable beyond this project: a root cause found while debugging, a tool or API gotcha, a working technique, a decision with its reason, a correction of a wrong assumption.
Answer PROJECT when it established a lasting fact about this project: its setup, a constraint, a decision, where something lives, how it is deployed.
Answer SKIP for routine work, questions, plans not yet carried out, chit-chat, anything only this conversation needs, and anything listed under "already saved".

The turn may come with this project's own guidance on what to save and skip; follow it.

Answer with exactly one line: "LEARNING: <what to save, under 20 words>", "PROJECT: <what to save, under 20 words>" or "SKIP".`

// `ask` says why the writer runs: a classifier's flag, or the user's own /knowledge-memory save
const writerPrompt = (ask: string, known: string, manual: boolean) => `[knowledge-memory] This message is from the knowledge-memory plugin, not the user. Do not use tools; answer in text only.

${ask}

The knowledge graph already holds these facts on the subject (found by searching for it; the date is when each was saved, "expired" means a later fact replaced it):
<known>
${known || '(nothing found)'}
</known>

Decide first:
- "skip" when the graph already says this, in other words or not.
- "correction" when it contradicts or updates a fact listed above. Write the episode so it states the new fact and what it replaces ("X, not Y as saved earlier").
- "new" otherwise.

Write the episode self-contained, for a future session without this conversation: the context, what was found or decided, the fix or the reason, and concrete names (tools, files, commands, versions, hosts). Leave out filler and the story of the conversation.

Reply with only a JSON object: {"action": "new" | "correction" | "skip", ${manual ? '"kind": "learning" (reusable beyond this project) | "project" (about this project), ' : ''}"name": "<title under 80 characters>", "body": "<markdown, 3 to 15 lines>"}. With "skip", name and body may be empty.`

type Saved = { at: number; group: string; name: string }
type Settings = { path: string; group?: string; save?: string; skip?: string; recall?: boolean }

let server = 'knowledge'
let learningGroup = 'learning'
let judgeModel = 'haiku'
let mirrorAutoMemory = true

let saved: Saved[] = [] // this session's episodes, newest last
let lastResult = 'nothing yet'
let isBusy = false
let isPending = false

// "C--Dev-RagBase2" -> "Dev-RagBase2" -> "RagBase2"; the same rule the old sync hook used
export const projectName = (dirName: string): string =>
  dirName.replace(/^[A-Z]--/, '').replace(/^(dev|Users-[^-]+)-/, '') || dirName

const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

// Where .claude/memory.json may be, nearest first: "C:\Dev\lab" -> C:\Dev\lab\.claude\memory.json, C:\Dev\..., C:\...
export const settingsPaths = (dir: string): string[] => {
  const sep = dir.includes('\\') ? '\\' : '/'
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.map((_, i) => [...parts.slice(0, parts.length - i), '.claude', 'memory.json'].join(sep))
}

export const parseSettings = (path: string, text: string): Settings => {
  const json = JSON.parse(text) as Record<string, unknown>
  const str = (k: string) => (typeof json[k] === 'string' && json[k] ? (json[k] as string) : undefined)
  return { path, group: str('group'), save: str('save'), skip: str('skip'), recall: json.recall !== false }
}

// The nearest .claude/memory.json at or above the session's folder
async function projectSettings($: EngineInterface): Promise<Settings | null> {
  for (const path of settingsPaths(await $.session.cwd())) {
    if (!(await $.fs.exists(path))) continue
    try {
      return parseSettings(path, await $.fs.read(path))
    } catch {
      return null // a broken file falls back to the folder name rather than guessing
    }
  }
  return null
}

const projectGroup = async ($: EngineInterface, settings: Settings | null) =>
  settings?.group ?? `project_${projectName(projectSlug(await $.session.cwd()))}`

// ~/.claude/projects/<dir>/memory/<file>.md, either slash
const AUTO_MEMORY = /[\\/]\.claude[\\/]projects[\\/]([^\\/]+)[\\/]memory[\\/]([^\\/]+\.md)$/i

export const autoMemoryFile = (path: string) => {
  const m = AUTO_MEMORY.exec(path)
  return m && m[2] !== 'MEMORY.md' ? { dir: m[1]!, project: projectName(m[1]!), file: m[2]! } : null
}

// A slash command's own rows (its record and output) are no exchange to judge
const isCommandRow = (m: SessionMessage) => /^\s*<(local-)?command-/.test(m.text)

export const lastExchange = (all: SessionMessage[]) => {
  const messages = all.filter(m => !isCommandRow(m))
  const start = messages.findLastIndex(m => m.role === 'user' && m.text.trim() !== '' && !m.toolResults?.length)
  const text = messages
    .slice(Math.max(0, start))
    .flatMap(m => [...(m.text.trim() ? [`${m.role.toUpperCase()}: ${m.text.trim()}`] : []), ...m.toolUses.map(t => `TOOL: ${t.tool}`)])
    .join('\n')
  return text.length > 12000 ? `${text.slice(0, 4000)}\n…\n${text.slice(-8000)}` : text
}

export const parseVerdict = (text: string) => {
  const m = /^(LEARNING|PROJECT):\s*(.+)$/m.exec(text.trim())
  return m ? { kind: m[1] as 'LEARNING' | 'PROJECT', what: m[2]!.trim() } : null
}

type Episode = { action: 'new' | 'correction'; kind?: 'LEARNING' | 'PROJECT'; name: string; body: string }

// null when the writer decided to skip
export const parseEpisode = (text: string): Episode | null => {
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>
  const str = (k: string) => (typeof json[k] === 'string' ? (json[k] as string).trim() : '')
  const action = str('action') === 'correction' ? 'correction' : str('action') === 'skip' ? 'skip' : 'new'
  const kind = str('kind') === 'learning' ? 'LEARNING' : str('kind') === 'project' ? 'PROJECT' : undefined
  const name = str('name').slice(0, 120)
  const body = str('body')
  return action !== 'skip' && name && body ? { action, kind, name, body } : null
}

// The text of an MCP tool result, parsed as the JSON the knowledge server answers with
const mcpJson = (r: { content?: unknown }): any => {
  const text = (Array.isArray(r.content) ? r.content : []).map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('')
  return text ? JSON.parse(text) : {}
}

// What the graph already says about a subject, one fact per line, for the writer to check against
async function knownFacts($: EngineInterface, query: string, groups: string[]): Promise<string> {
  try {
    const r = await $.mcp.call(server, 'search_memory_facts', { query, group_ids: groups, max_facts: 8 })
    if (r.isError) return ''
    const facts = (mcpJson(r).facts ?? []) as { fact?: string; created_at?: string; expired_at?: string | null }[]
    return facts
      .filter(f => f.fact)
      .map(f => `- ${(f.created_at ?? '').slice(0, 10)} ${f.fact}${f.expired_at ? ' (expired)' : ''}`)
      .join('\n')
  } catch {
    return '' // no check is better than no save
  }
}

async function addEpisode($: EngineInterface, args: { name: string; body: string; group: string; source: string; uuid?: string; max?: number }) {
  const r = await $.mcp.call(server, 'add_memory', {
    name: args.name,
    episode_body: args.body.slice(0, args.max ?? 5000),
    group_id: args.group,
    source: 'text',
    source_description: args.source,
    ...(args.uuid ? { uuid: args.uuid } : {}),
  })
  if (r.isError) throw new Error(`add_memory on "${server}" failed`)
  saved = [...saved, { at: await $.clock.now(), group: args.group, name: args.name }].slice(-20)
}

// The judge: does the last turn hold something worth keeping? Kept apart so another classifier can replace it.
async function judge($: EngineInterface, settings: Settings | null): Promise<{ kind: 'LEARNING' | 'PROJECT'; what: string } | string> {
  const exchange = lastExchange(await $.session.messages())
  if (exchange.length < 200) return 'skipped: short turn'
  const already = saved.map(s => `- ${s.name}`).join('\n') || '(none)'
  const guidance = [settings?.save && `Save: ${settings.save}`, settings?.skip && `Skip: ${settings.skip}`].filter(Boolean).join('\n')
  const verdict = await $.model.complete({
    model: judgeModel,
    system: JUDGE,
    prompt: `${guidance ? `<project_guidance>\n${guidance}\n</project_guidance>\n\n` : ''}<already_saved>\n${already}\n</already_saved>\n\n<turn>\n${exchange}\n</turn>`,
    maxTokens: 60,
    timeoutMs: 20_000,
  })
  if (!verdict.isAnswered) return `judge failed: ${verdict.reason}`
  return parseVerdict(verdict.text) ?? `skipped: judge said "${verdict.text.trim().slice(0, 200)}"`
}

// The writer: a fork with the whole conversation checks the graph's facts and writes one episode
async function write($: EngineInterface, settings: Settings | null, ask: { kind?: 'LEARNING' | 'PROJECT'; what: string; manual: boolean }): Promise<string> {
  const group = await projectGroup($, settings)
  const known = await knownFacts($, ask.what, [learningGroup, group])
  const why = ask.manual
    ? `The user asked to save this to the knowledge graph: ${ask.what}`
    : `A classifier flagged the latest turn for the knowledge graph as a ${ask.kind!.toLowerCase()}: ${ask.what}`
  const reply = await $.model.fork({ prompt: writerPrompt(why, known, ask.manual) })
  if (!reply.isAnswered) return `writer failed: ${reply.reason}`
  let episode: Episode | null
  try {
    episode = parseEpisode(reply.text)
  } catch {
    return 'writer did not answer with JSON'
  }
  if (!episode) return 'skipped by the writer: already known or nothing to keep'

  const kind = ask.kind ?? episode.kind ?? 'PROJECT'
  const target = kind === 'LEARNING' ? learningGroup : group
  const project = projectName(projectSlug(await $.session.cwd()))
  await addEpisode($, { ...episode, group: target, source: `knowledge-memory | Project: ${project}${episode.action === 'correction' ? ' | correction' : ''}` })
  const what = `${episode.action === 'correction' ? 'correction ' : ''}saved to ${target}: ${episode.name}`
  $.ui.status(`🧠 ${what}`)
  return what
}

async function considerTurn($: EngineInterface): Promise<string> {
  const settings = await projectSettings($)
  const flagged = await judge($, settings)
  return typeof flagged === 'string' ? flagged : write($, settings, { ...flagged, manual: false })
}

// /knowledge-memory save <hint>: no judge, the writer saves what the user pointed at
async function saveHint($: EngineInterface, hint: string): Promise<string> {
  return write($, await projectSettings($), { what: hint, manual: true })
}

// One run at a time; a turn that ends during a run is considered once it finishes
async function consider($: EngineInterface, hint?: string): Promise<void> {
  if (isBusy) {
    isPending = true
    return
  }
  isBusy = true
  try {
    lastResult = hint ? await saveHint($, hint) : await considerTurn($)
  } catch (err) {
    lastResult = `failed: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    isBusy = false
    if (isPending) {
      isPending = false
      void consider($)
    }
  }
}

// UUID v5 (URL namespace) of a key: the same memory file always maps to the same episode
export async function episodeUuid(key: string): Promise<string> {
  const ns = '6ba7b8119dad11d180b400c04fd430c8'.match(/../g)!.map(h => parseInt(h, 16))
  const data = new Uint8Array([...ns, ...new TextEncoder().encode(key)])
  const b = new Uint8Array(await crypto.subtle.digest('SHA-1', data)).slice(0, 16)
  b[6] = (b[6]! & 0x0f) | 0x50
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// The file with `knowledge_id: <id>` in its frontmatter (under metadata: when there is one), or null when it
// already has it or has no frontmatter
export const withKnowledgeId = (text: string, id: string): string | null => {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(eol)
  const end = lines.indexOf('---', 1)
  if (lines[0] !== '---' || end < 0) return null
  const at = (re: RegExp) => lines.findIndex((l, i) => i > 0 && i < end && re.test(l))
  const existing = at(/^\s*knowledge_id:/)
  if (existing >= 0) {
    const line = lines[existing]!.replace(/knowledge_id:.*$/, `knowledge_id: ${id}`)
    if (line === lines[existing]) return null
    lines[existing] = line
    return lines.join(eol)
  }
  const meta = at(/^metadata:\s*$/)
  if (meta < 0) lines.splice(end, 0, `knowledge_id: ${id}`)
  else lines.splice(meta + 1, 0, `${/^(\s+)\S/.exec(lines[meta + 1] ?? '')?.[1] ?? '  '}knowledge_id: ${id}`)
  return lines.join(eol)
}

// One episode per memory file, replaced on every write; the file carries the episode's id
async function mirror($: EngineInterface, path: string): Promise<void> {
  const hit = autoMemoryFile(path)
  if (!hit) return
  // The memory folder of this session's own project follows its settings; another project's keeps its folder name
  const own = hit.dir === projectSlug(await $.session.cwd())
  const group = own ? await projectGroup($, await projectSettings($)) : `project_${hit.project}`
  const id = await episodeUuid(`knowledge-memory:${group}/${hit.file}`)
  let body = await $.fs.read(path)
  const tagged = withKnowledgeId(body, id)
  if (tagged !== null) {
    await $.fs.write(path, tagged)
    body = tagged
  }
  await addEpisode($, {
    name: `project-memory: ${hit.project}/${hit.file}`,
    body,
    group,
    source: `Project: ${hit.project} | File: ${hit.file}`,
    uuid: id,
    max: 50_000,
  })
  lastResult = `mirrored ${hit.project}/${hit.file} as ${id}`
}

export const register: Register = (on, options) => {
  server = String(options.server || 'knowledge')
  learningGroup = String(options.learningGroup || 'learning')
  judgeModel = String(options.judgeModel || 'haiku')
  mirrorAutoMemory = options.mirrorAutoMemory !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'knowledge-memory',
      description: 'Show what knowledge-memory saved this session; "now" considers the last turn now; "save <what>" saves it',
      argumentHint: '[now | save <what>]',
    })
    return next(e)
  })

  // After each answered main-thread turn, in the background
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') void consider($)
    return result
  })

  // Mirror auto-memory writes to the graph once the write has landed
  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const result = await next(e)
    if (mirrorAutoMemory && !result.isError) void mirror($, e.file_path).catch(() => { lastResult = 'mirror failed' })
    return result
  }).catch(($, e, next) => next(e)) // never stand between Claude and a write

  on('command.run', { command: 'knowledge-memory' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    const hint = /^save\s+([\s\S]+)$/.exec(args)?.[1]?.trim()
    if (args === 'now' || hint) {
      if (isBusy) return { text: 'A run is already considering the last turn; /knowledge-memory shows its result.' }
      await consider($, hint)
      return { text: lastResult }
    }
    if (args === 'save') return { text: 'Say what to save: /knowledge-memory save <what>' }
    const lines = saved.map(s => `- [${s.group}] ${s.name}`)
    const settings = await projectSettings($)
    return {
      text: [
        `Judge ${judgeModel}, server "${server}", learnings to "${learningGroup}".`,
        settings
          ? `Project settings: ${settings.path}, project facts to "${await projectGroup($, settings)}".`
          : `No .claude/memory.json here; project facts to "${await projectGroup($, null)}".`,
        lines.length ? `Saved this session:\n${lines.join('\n')}` : 'Nothing saved this session yet.',
        `Last: ${lastResult}`,
      ].join('\n'),
    }
  })
}
