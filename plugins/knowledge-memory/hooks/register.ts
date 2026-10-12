// knowledge-memory: saves what a session learns straight into a Graphiti
// knowledge graph, a little after every turn, instead of in bulk at the next
// session start.
//
// After each main-thread turn:
//   1. A small model (Haiku by default) reads the last exchange and answers
//      SKIP, LEARNING: <what> (reusable across projects) or PROJECT: <what>
//      (specific to this project).
//   2. Only when it is not SKIP, a tool-less $.model.fork drafts one episode.
//      The fork replays the session's own transcript from the prompt cache, so
//      it has the full context at a fraction of the price.
//   3. The episode goes to the graph's MCP server through $.mcp.call:
//      `learningGroup` for learnings, `project_<name>` for project facts.
//
// It also mirrors Claude Code's file-based auto-memory: every Write or Edit of
// a file under ~/.claude/projects/<project>/memory/ is sent to the graph as
// soon as it lands, under the same `project_<name>` group.

import type { EngineInterface, Register, SessionMessage } from 'claude-code'

const JUDGE = `You decide whether one turn of a coding session taught something worth keeping in a long-term knowledge graph.

Answer LEARNING when the turn established something reusable beyond this project: a root cause found while debugging, a tool or API gotcha, a working technique, a decision with its reason, a correction of a wrong assumption.
Answer PROJECT when it established a lasting fact about this project: its setup, a constraint, a decision, where something lives, how it is deployed.
Answer SKIP for routine work, questions, plans not yet carried out, chit-chat, anything only this conversation needs, and anything listed under "already saved".

Answer with exactly one line: "LEARNING: <what to save, under 20 words>", "PROJECT: <what to save, under 20 words>" or "SKIP".`

const writerPrompt = (kind: string, what: string) => `[knowledge-memory] This message is from the knowledge-memory plugin, not the user. Do not use tools; answer in text only.

A classifier flagged the latest turn for the knowledge graph as a ${kind}: ${what}

Write it as one self-contained episode a future session can use without this conversation: the context, what was found or decided, the fix or the reason, and concrete names (tools, files, commands, versions, hosts). Leave out filler and the story of the conversation.

Reply with only a JSON object: {"name": "<title under 80 characters>", "body": "<markdown, 3 to 15 lines>"}. If on reflection nothing is worth keeping, reply {"name": "", "body": ""}.`

type Saved = { at: number; group: string; name: string }

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

// ~/.claude/projects/<dir>/memory/<file>.md, either slash
const AUTO_MEMORY = /[\\/]\.claude[\\/]projects[\\/]([^\\/]+)[\\/]memory[\\/]([^\\/]+\.md)$/i

export const autoMemoryFile = (path: string) => {
  const m = AUTO_MEMORY.exec(path)
  return m && m[2] !== 'MEMORY.md' ? { project: projectName(m[1]!), file: m[2]! } : null
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

export const parseEpisode = (text: string) => {
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { name?: unknown; body?: unknown }
  const name = typeof json.name === 'string' ? json.name.trim().slice(0, 120) : ''
  const body = typeof json.body === 'string' ? json.body.trim() : ''
  return name && body ? { name, body } : null
}

async function addEpisode($: EngineInterface, args: { name: string; body: string; group: string; source: string }) {
  const r = await $.mcp.call(server, 'add_memory', {
    name: args.name,
    episode_body: args.body.slice(0, 5000),
    group_id: args.group,
    source: 'text',
    source_description: args.source,
  })
  if (r.isError) throw new Error(`add_memory on "${server}" failed`)
  saved = [...saved, { at: await $.clock.now(), group: args.group, name: args.name }].slice(-20)
}

async function considerTurn($: EngineInterface): Promise<string> {
  const exchange = lastExchange(await $.session.messages())
  if (exchange.length < 200) return (lastResult = 'skipped: short turn')

  const already = saved.map(s => `- ${s.name}`).join('\n') || '(none)'
  const verdict = await $.model.complete({
    model: judgeModel,
    system: JUDGE,
    prompt: `<already_saved>\n${already}\n</already_saved>\n\n<turn>\n${exchange}\n</turn>`,
    maxTokens: 60,
    timeoutMs: 20_000,
  })
  if (!verdict.isAnswered) return (lastResult = `judge failed: ${verdict.reason}`)
  const flagged = parseVerdict(verdict.text)
  if (!flagged) return (lastResult = `skipped: judge said "${verdict.text.trim().slice(0, 200)}"`)

  const reply = await $.model.fork({ prompt: writerPrompt(flagged.kind.toLowerCase(), flagged.what) })
  if (!reply.isAnswered) return (lastResult = `writer failed: ${reply.reason}`)
  let episode: ReturnType<typeof parseEpisode>
  try {
    episode = parseEpisode(reply.text)
  } catch {
    return (lastResult = 'writer did not answer with JSON')
  }
  if (!episode) return (lastResult = 'skipped by the writer')

  const project = projectName(projectSlug(await $.session.cwd()))
  const group = flagged.kind === 'LEARNING' ? learningGroup : `project_${project}`
  await addEpisode($, { ...episode, group, source: `knowledge-memory | Project: ${project}` })
  $.ui.status(`🧠 saved to ${group}: ${episode.name}`)
  return (lastResult = `saved to ${group}: ${episode.name}`)
}

// One run at a time; a turn that ends during a run is considered once it finishes
async function consider($: EngineInterface): Promise<void> {
  if (isBusy) {
    isPending = true
    return
  }
  isBusy = true
  try {
    lastResult = await considerTurn($)
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

async function mirror($: EngineInterface, path: string): Promise<void> {
  const hit = autoMemoryFile(path)
  if (!hit) return
  const body = await $.fs.read(path)
  await addEpisode($, {
    name: `project-memory: ${hit.project}/${hit.file}`,
    body,
    group: `project_${hit.project}`,
    source: `Project: ${hit.project} | File: ${hit.file}`,
  })
  lastResult = `mirrored ${hit.project}/${hit.file}`
}

export const register: Register = (on, options) => {
  server = String(options.server || 'knowledge')
  learningGroup = String(options.learningGroup || 'learning')
  judgeModel = String(options.judgeModel || 'haiku')
  mirrorAutoMemory = options.mirrorAutoMemory !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'knowledge-memory',
      description: 'Show what knowledge-memory saved this session; "/knowledge-memory now" considers the last turn now',
      argumentHint: '[now]',
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
    if ((e.args ?? '').trim() === 'now') {
      if (isBusy) return { text: 'A run is already considering the last turn; /knowledge-memory shows its result.' }
      await consider($)
      return { text: lastResult }
    }
    const lines = saved.map(s => `- [${s.group}] ${s.name}`)
    return {
      text: [
        `Judge ${judgeModel}, server "${server}", learnings to "${learningGroup}".`,
        lines.length ? `Saved this session:\n${lines.join('\n')}` : 'Nothing saved this session yet.',
        `Last: ${lastResult}`,
      ].join('\n'),
    }
  })
}
