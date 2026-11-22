// Markdown todo lists: one list per file, one task per line in the Obsidian Tasks format.
// Everything here works on plain strings and paths so the CLI and the tests share it.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export type Priority = 'highest' | 'high' | 'medium' | 'low' | 'lowest'
export const PRIORITIES: Record<Priority, string> = { highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' }
const PRIORITY_RANK: Record<string, number> = { highest: 0, high: 1, medium: 2, none: 3, low: 4, lowest: 5 }

// Date fields of the Tasks plugin; values are YYYY-MM-DD
const DATE_FIELDS = { due: '📅', scheduled: '⏳', start: '🛫', created: '➕', done: '✅', cancelled: '❌' } as const
type DateField = keyof typeof DATE_FIELDS

const TASK_RE = /^(\s*)[-*+] \[(.)\] (.*)$/
const ID_RE = /🆔️?\s*([A-Za-z0-9_-]+)/
const RESERVED_DIRS = new Set(['.obsidian', '.stversions', '.trash', '.git'])

export interface Task {
  id?: string
  status: 'open' | 'done' | 'cancelled'
  text: string // description without the fields (tags stay in it, as in Tasks)
  tags: string[]
  priority?: Priority
  due?: string
  scheduled?: string
  start?: string
  created?: string
  done?: string
  cancelled?: string
  recurrence?: string
  list: string // path relative to the root, without .md: "shared/groceries"
  line: number // 0-based line of the task in its file
  notes: string[] // indented lines below the task (sub-items, notes)
}

export interface List {
  name: string // "christer/ideas"
  owner: string // first folder; "shared" for shared lists
  area?: string
  title?: string
  path: string
}

// ---------- dates ----------

export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** today, tomorrow, +3d, +2w, a weekday name (next one), or YYYY-MM-DD. */
export function parseDate(value: string, today: string): string {
  const v = value.trim().toLowerCase()
  const base = new Date(`${today}T12:00:00`)
  const shift = (days: number) => (base.setDate(base.getDate() + days), isoDate(base))
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  if (v === 'today') return today
  if (v === 'tomorrow') return shift(1)
  const rel = v.match(/^\+(\d+)([dw])$/)
  if (rel) return shift(Number(rel[1]) * (rel[2] === 'w' ? 7 : 1))
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const day = days.findIndex((d) => d.startsWith(v) && v.length >= 3)
  if (day >= 0) return shift(((day - base.getDay() + 7) % 7) || 7)
  throw new Error(`can't read the date "${value}" (use YYYY-MM-DD, today, tomorrow, +3d, +1w or a weekday)`)
}

// ---------- lines ----------

export function parseTask(line: string): Omit<Task, 'list' | 'line' | 'notes'> | undefined {
  const m = line.match(TASK_RE)
  if (!m) return undefined
  const mark = m[2]!
  const body = m[3]!
  const task: Omit<Task, 'list' | 'line' | 'notes'> = {
    status: mark === ' ' ? 'open' : mark === '-' ? 'cancelled' : 'done',
    text: '',
    tags: [],
  }
  for (const [field, emoji] of Object.entries(DATE_FIELDS)) {
    const d = body.match(new RegExp(`${emoji}\\uFE0F?\\s*(\\d{4}-\\d{2}-\\d{2})`, 'u'))
    if (d) task[field as DateField] = d[1]
  }
  for (const [name, emoji] of Object.entries(PRIORITIES)) if (body.includes(emoji)) task.priority = name as Priority
  const id = body.match(ID_RE)
  if (id) task.id = id[1]
  const rec = body.match(/🔁️?\s*([^📅⏳🛫➕✅❌🆔⛔🏁🔺⏫🔼🔽⏬]+)/u)
  if (rec) task.recurrence = rec[1]!.trim()
  // The description ends where the first field starts
  const fieldStart = body.search(/[📅⏳🛫➕✅❌🆔⛔🏁🔁🔺⏫🔼🔽⏬]/u)
  task.text = (fieldStart < 0 ? body : body.slice(0, fieldStart)).trim()
  task.tags = [...task.text.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((t) => t[1]!)
  return task
}

/** Removes one field (emoji plus its value) from a line. */
function dropField(line: string, emoji: string, value = /\S*/.source): string {
  return line.replace(new RegExp(`\\s*${emoji}\\uFE0F?(\\s*${value})?`, 'gu'), '')
}

export function setDate(line: string, field: DateField, date?: string): string {
  const out = dropField(line, DATE_FIELDS[field], /\d{4}-\d{2}-\d{2}/.source)
  return date ? `${out.trimEnd()} ${DATE_FIELDS[field]} ${date}` : out
}

export function setPriority(line: string, priority?: Priority): string {
  let out = line
  for (const emoji of Object.values(PRIORITIES)) out = out.replace(new RegExp(`\\s*${emoji}\\uFE0F?`, 'gu'), '')
  if (!priority) return out
  // Priority goes right after the description, before the other fields
  return insertAfterText(out, PRIORITIES[priority])
}

export function setId(line: string, id: string): string {
  return `${line.replace(new RegExp(ID_RE.source, 'gu'), '').trimEnd()} 🆔 ${id}`
}

export function setMark(line: string, mark: ' ' | 'x' | '-'): string {
  return line.replace(TASK_RE, (_all, indent, _m, body) => `${indent}- [${mark}] ${body}`)
}

export function setText(line: string, text: string): string {
  const m = line.match(TASK_RE)!
  const body = m[3]!
  const fieldStart = body.search(/[📅⏳🛫➕✅❌🆔⛔🏁🔁🔺⏫🔼🔽⏬]/u)
  const fields = fieldStart < 0 ? '' : ` ${body.slice(fieldStart)}`
  return `${m[1]}- [${m[2]}] ${text.trim()}${fields}`
}

export function addTags(line: string, tags: string[]): string {
  const existing = parseTask(line)!.tags
  const fresh = tags.map((t) => t.replace(/^#/, '')).filter((t) => t && !existing.includes(t))
  return fresh.length ? insertAfterText(line, fresh.map((t) => `#${t}`).join(' ')) : line
}

export function removeTags(line: string, tags: string[]): string {
  let out = line
  for (const t of tags.map((t) => t.replace(/^#/, ''))) out = out.replace(new RegExp(`\\s#${escapeRe(t)}(?=\\s|$)`, 'gu'), '')
  return out
}

function insertAfterText(line: string, insert: string): string {
  const m = line.match(TASK_RE)!
  const body = m[3]!
  const fieldStart = body.search(/[📅⏳🛫➕✅❌🆔⛔🏁🔁🔺⏫🔼🔽⏬]/u)
  const text = (fieldStart < 0 ? body : body.slice(0, fieldStart)).trimEnd()
  const fields = fieldStart < 0 ? '' : ` ${body.slice(fieldStart)}`
  return `${m[1]}- [${m[2]}] ${text} ${insert}${fields}`
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function newTaskLine(text: string, opts: { due?: string; priority?: Priority; tags?: string[]; created: string; id: string }): string {
  let line = `- [ ] ${text.trim()}`
  if (opts.tags?.length) line = addTags(line, opts.tags)
  if (opts.priority) line = setPriority(line, opts.priority)
  line = setDate(line, 'created', opts.created)
  if (opts.due) line = setDate(line, 'due', opts.due)
  return setId(line, opts.id)
}

// ---------- files ----------

interface Doc {
  lines: string[]
  eol: string
  frontmatter: Record<string, string>
  body: number // first line after the frontmatter
}

function readDoc(path: string): Doc {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.length ? raw.replace(/\r?\n$/, '').split(/\r?\n/) : []
  const frontmatter: Record<string, string> = {}
  let body = 0
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const kv = l.match(/^([\w-]+):\s*(.*)$/)
        if (kv) frontmatter[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '').trim()
      }
      body = end + 1
    }
  }
  return { lines, eol, frontmatter, body }
}

/** Write next to the file and rename over it, so Syncthing and Obsidian never see half a file. */
function writeDoc(path: string, doc: Doc) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, doc.lines.join(doc.eol) + doc.eol, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

/** Indented lines (deeper than the task, or blank between such lines) that belong to the task at `line`. */
function blockEnd(lines: string[], line: number): number {
  const indent = lines[line]!.match(/^\s*/)![0].length
  let end = line + 1
  while (end < lines.length) {
    const l = lines[end]!
    if (l.trim() === '') {
      const next = lines.slice(end + 1).find((x) => x.trim() !== '')
      if (next === undefined || next.match(/^\s*/)![0].length <= indent) break
    } else if (l.match(/^\s*/)![0].length <= indent) break
    end++
  }
  return end
}

// ---------- the store ----------

export interface StoreOptions {
  root: string
  today?: string
  random?: () => string
}

export class Store {
  readonly root: string
  readonly today: string
  private random: () => string

  constructor(opts: StoreOptions) {
    this.root = opts.root
    this.today = opts.today ?? isoDate(new Date())
    this.random = opts.random ?? (() => Math.random().toString(36).slice(2, 6).padEnd(4, '0'))
  }

  private path(list: string) {
    return join(this.root, ...`${list}.md`.split('/'))
  }

  /** Every list file under the root, except archives and Obsidian/Syncthing folders. */
  lists(): List[] {
    const out: List[] = []
    const walk = (dir: string) => {
      if (!existsSync(dir)) return
      for (const name of readdirSync(dir)) {
        if (name.startsWith('.') || RESERVED_DIRS.has(name)) continue
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (name.endsWith('.md') && !name.endsWith('.archive.md')) {
          const rel = relative(this.root, full).split(sep).join('/').replace(/\.md$/, '')
          if (!rel.includes('/')) continue // files in the root (users.md, README.md) are not lists
          const fm = readDoc(full).frontmatter
          if (fm.type === 'index') continue
          out.push({ name: rel, owner: rel.split('/')[0]!, area: fm.area, title: fm.title, path: full })
        }
      }
    }
    walk(this.root)
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** "ideas" → the user's own list, else a shared one with that name, else a new list of the user's. */
  resolve(name: string, user?: string): string {
    const clean = name.replace(/\\/g, '/').replace(/\.md$/, '').replace(/^\/+|\/+$/g, '')
    if (!clean || clean.split('/').some((p) => p === '..' || p.startsWith('.'))) throw new Error(`bad list name "${name}"`)
    if (clean.includes('/')) return clean
    if (user && existsSync(this.path(`${user}/${clean}`))) return `${user}/${clean}`
    if (existsSync(this.path(`shared/${clean}`))) return `shared/${clean}`
    if (!user) throw new Error(`no list "${clean}" in shared/, and no user given (--user or TODO_USER)`)
    return `${user}/${clean}`
  }

  private allIds(): Set<string> {
    const ids = new Set<string>()
    for (const l of this.lists()) for (const t of this.readTasks(l.name)) if (t.id) ids.add(t.id)
    return ids
  }

  private newId(taken = this.allIds()): string {
    for (let i = 0; i < 100; i++) {
      const id = this.random()
      if (!taken.has(id)) return taken.add(id), id
    }
    throw new Error('could not find a free id')
  }

  readTasks(list: string): Task[] {
    const doc = readDoc(this.path(list))
    const out: Task[] = []
    for (let i = doc.body; i < doc.lines.length; i++) {
      const t = parseTask(doc.lines[i]!)
      if (!t) continue
      const end = blockEnd(doc.lines, i)
      out.push({ ...t, list, line: i, notes: doc.lines.slice(i + 1, end).filter((l) => !parseTask(l)) })
    }
    return out
  }

  /** Gives every task without an id one, in the lists given. Returns how many it changed. */
  assignIds(lists: string[]): number {
    let taken: Set<string> | undefined
    let changed = 0
    for (const list of lists) {
      const path = this.path(list)
      const doc = readDoc(path)
      let dirty = false
      for (let i = doc.body; i < doc.lines.length; i++) {
        const t = parseTask(doc.lines[i]!)
        if (!t || t.id) continue
        taken ??= this.allIds()
        doc.lines[i] = setId(doc.lines[i]!, this.newId(taken))
        dirty = true
        changed++
      }
      if (dirty) writeDoc(path, doc)
    }
    return changed
  }

  add(list: string, text: string, opts: { due?: string; priority?: Priority; tags?: string[] } = {}): Task {
    if (!text.trim()) throw new Error('empty task')
    const id = this.newId()
    this.appendBlock(list, [newTaskLine(text, { ...opts, created: this.today, id })])
    return this.find(id)!
  }

  find(id: string): Task | undefined {
    for (const l of this.lists()) {
      const t = this.readTasks(l.name).find((t) => t.id === id)
      if (t) return t
    }
    return undefined
  }

  private mustFind(id: string): Task {
    const t = this.find(id.replace(/^🆔\s*/, ''))
    if (!t) throw new Error(`no task with id ${id}`)
    return t
  }

  /** Re-reads the file, finds the task by id again and changes only its line. */
  private update(id: string, change: (line: string) => string): Task {
    const t = this.mustFind(id)
    const path = this.path(t.list)
    const doc = readDoc(path)
    const i = doc.lines.findIndex((l, n) => n >= doc.body && parseTask(l)?.id === t.id)
    doc.lines[i] = change(doc.lines[i]!)
    writeDoc(path, doc)
    return this.find(t.id!)!
  }

  done(id: string): Task {
    return this.update(id, (l) => setDate(setDate(setMark(l, 'x'), 'cancelled'), 'done', this.today))
  }

  undo(id: string): Task {
    return this.update(id, (l) => setDate(setDate(setMark(l, ' '), 'done'), 'cancelled'))
  }

  cancel(id: string): Task {
    return this.update(id, (l) => setDate(setDate(setMark(l, '-'), 'done'), 'cancelled', this.today))
  }

  edit(id: string, e: { text?: string; due?: string | null; priority?: Priority | null; addTags?: string[]; removeTags?: string[] }): Task {
    return this.update(id, (l) => {
      let out = l
      if (e.text !== undefined) out = setText(out, e.text)
      if (e.due !== undefined) out = setDate(out, 'due', e.due ?? undefined)
      if (e.priority !== undefined) out = setPriority(out, e.priority ?? undefined)
      if (e.removeTags?.length) out = removeTags(out, e.removeTags)
      if (e.addTags?.length) out = addTags(out, e.addTags)
      return out
    })
  }

  /** Takes the task and its indented lines out of its file. */
  private cut(id: string): { task: Task; block: string[] } {
    const t = this.mustFind(id)
    const path = this.path(t.list)
    const doc = readDoc(path)
    const i = doc.lines.findIndex((l, n) => n >= doc.body && parseTask(l)?.id === t.id)
    const block = doc.lines.splice(i, blockEnd(doc.lines, i) - i)
    writeDoc(path, doc)
    return { task: t, block }
  }

  rm(id: string): Task {
    return this.cut(id).task
  }

  move(id: string, to: string): Task {
    if (this.mustFind(id).list === to) return this.mustFind(id)
    const { block } = this.cut(id)
    const indent = block[0]!.match(/^\s*/)![0].length
    this.appendBlock(to, block.map((l) => l.slice(Math.min(indent, l.match(/^\s*/)![0].length))))
    return this.mustFind(id)
  }

  /**
   * Puts lines after the last task of a list (so a task added to a list with sections lands in the
   * last one), or at the end when the list has no tasks yet. Creates the file when needed.
   */
  private appendBlock(list: string, block: string[]) {
    const path = this.path(list)
    const doc = readDoc(path)
    if (!doc.lines.length) {
      doc.lines.push('---', `owner: ${list.split('/')[0]}`, '---', '', `# ${titleOf(list)}`)
      doc.body = 3
    }
    let at = -1
    for (let i = doc.lines.length - 1; i >= doc.body; i--) {
      if (parseTask(doc.lines[i]!) && !/^\s/.test(doc.lines[i]!)) { at = blockEnd(doc.lines, i); break }
    }
    if (at < 0) {
      while (doc.lines.length > doc.body && doc.lines[doc.lines.length - 1]!.trim() === '') doc.lines.pop()
      if (doc.lines.length > doc.body) doc.lines.push('')
      at = doc.lines.length
    }
    doc.lines.splice(at, 0, ...block)
    writeDoc(path, doc)
  }

  /** Moves finished tasks done (or cancelled) more than `days` days ago to <list>.archive.md. */
  archive(lists: string[], days: number): number {
    const cutoff = new Date(`${this.today}T12:00:00`)
    cutoff.setDate(cutoff.getDate() - days)
    const limit = isoDate(cutoff)
    let moved = 0
    for (const list of lists) {
      const path = this.path(list)
      const doc = readDoc(path)
      const out: string[] = []
      const keep = doc.lines.slice(0, doc.body)
      for (let i = doc.body; i < doc.lines.length; ) {
        const t = parseTask(doc.lines[i]!)
        const end = t ? blockEnd(doc.lines, i) : i + 1
        const finished = t && t.status !== 'open' && (t.done ?? t.cancelled ?? '9999') <= limit
        ;(finished ? out : keep).push(...doc.lines.slice(i, end))
        i = end
      }
      if (!out.length) continue
      doc.lines = keep
      writeDoc(path, doc)
      this.appendBlock(`${list}.archive`, out)
      moved += out.filter((l) => parseTask(l) && !/^\s/.test(l)).length
    }
    return moved
  }

  /** Creates the folders for a user and an index.md that shows all their tasks in Obsidian. */
  init(user: string): string[] {
    const made: string[] = []
    const ensure = (rel: string, content: string) => {
      const p = join(this.root, ...rel.split('/'))
      if (existsSync(p)) return
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content, 'utf8')
      made.push(rel)
    }
    ensure(`${user}/index.md`, indexFor(user))
    ensure('shared/index.md', indexFor('shared'))
    return made
  }
}

const titleOf = (list: string) => {
  const name = list.split('/').pop()!.replace(/[-_]/g, ' ')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function indexFor(user: string): string {
  const paths = user === 'shared' ? 'path includes shared/' : `(path includes ${user}/) OR (path includes shared/)`
  return [
    '---',
    'type: index',
    '---',
    '',
    `# ${user === 'shared' ? 'Shared' : user}`,
    '',
    '## Due',
    '',
    '```tasks',
    'not done',
    'has due date',
    paths,
    'path does not include .archive',
    'sort by due',
    '```',
    '',
    '## Everything open',
    '',
    '```tasks',
    'not done',
    paths,
    'path does not include .archive',
    'group by filename',
    'sort by priority',
    '```',
    '',
  ].join('\n')
}

// ---------- queries ----------

export interface Query {
  user?: string
  all?: boolean // every user's lists
  lists?: string[] // only these
  area?: string
  due?: 'overdue' | 'today' | 'week'
  tag?: string
  text?: string
  status?: 'open' | 'done' | 'any'
}

/**
 * Which lists a user sees by default: their own and shared/. Other people's lists only with `all` or
 * an explicit list; lists with area "work" only for their owner, or when asked for by area.
 * Not access control: anyone can read every file. It's about not hearing other people's work.
 */
export function visibleLists(lists: List[], q: Query): List[] {
  if (q.lists?.length) return lists.filter((l) => q.lists!.includes(l.name))
  return lists.filter((l) => {
    if (q.area && l.area !== q.area) return false
    const mine = l.owner === q.user || l.owner === 'shared'
    if (!q.all && !mine) return false
    if (l.area === 'work' && l.owner !== q.user && q.area !== 'work') return false
    return true
  })
}

export function matches(t: Task, q: Query, today: string): boolean {
  const status = q.status ?? 'open'
  if (status === 'open' && t.status !== 'open') return false
  if (status === 'done' && t.status === 'open') return false
  if (q.tag && !t.tags.includes(q.tag.replace(/^#/, ''))) return false
  if (q.text && !`${t.text} ${t.notes.join(' ')}`.toLowerCase().includes(q.text.toLowerCase())) return false
  if (q.due) {
    if (!t.due) return false
    if (q.due === 'overdue' && !(t.due < today)) return false
    if (q.due === 'today' && !(t.due <= today)) return false
    if (q.due === 'week') {
      const end = new Date(`${today}T12:00:00`)
      end.setDate(end.getDate() + 7)
      if (t.due > isoDate(end)) return false
    }
  }
  return true
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (a, b) =>
      a.list.localeCompare(b.list) ||
      (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
      PRIORITY_RANK[a.priority ?? 'none']! - PRIORITY_RANK[b.priority ?? 'none']! ||
      a.line - b.line,
  )
}
