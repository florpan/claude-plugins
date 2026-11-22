#!/usr/bin/env bun
// todo: markdown todo lists in a synced folder (TODO_ROOT), readable in Obsidian with the Tasks plugin.
import { existsSync } from 'node:fs'
import { matches, parseDate, PRIORITIES, sortTasks, Store, visibleLists, type Priority, type Query, type Task } from './lib'

const HELP = `todo: markdown todo lists (root: TODO_ROOT, user: TODO_USER or --user)

  todo lists                                  the lists you see (--all: everyone's)
  todo list [list...]                         open tasks; no list = all your lists + shared/
        [--due overdue|today|week] [--tag t] [--area a] [--done|--any] [--all]
  todo add <list> <text...> [--due d] [--prio p] [--tag t]...
  todo done|undo|cancel|rm <id>...
  todo edit <id> [--text "..."] [--due d|--no-due] [--prio p|--no-prio] [--tag t] [--untag t]
  todo move <id> <list>
  todo search <text> [--all] [--any]
  todo archive [list...] [--days 7]           finished tasks older than N days → <list>.archive.md
  todo init <user>                            folders plus an index.md for Obsidian

  <list>: "ideas" = your own list, else shared/ideas if it exists, else a new list of yours;
          "shared/groceries" or "alex/school" = exactly that file.
  dates:  YYYY-MM-DD, today, tomorrow, +3d, +2w, monday..sunday
  prio:   ${Object.keys(PRIORITIES).join(', ')}
  --json  machine-readable output for every command`

interface Args {
  pos: string[]
  flags: Record<string, string[]>
}

const BOOL = new Set(['json', 'all', 'done', 'any', 'no-due', 'no-prio', 'help'])

export function parseArgs(argv: string[]): Args {
  const out: Args = { pos: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') { out.pos.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s)
      const key = k!
      const value = inline ?? (BOOL.has(key) ? 'true' : argv[++i])
      if (value === undefined) throw new Error(`--${key} needs a value`)
      ;(out.flags[key] ??= []).push(value)
    } else if (a === '-h') out.flags.help = ['true']
    else out.pos.push(a)
  }
  return out
}

const prio = (v?: string): Priority | undefined => {
  if (v === undefined) return undefined
  const p = v.toLowerCase() as Priority
  if (!(p in PRIORITIES)) throw new Error(`unknown priority "${v}" (${Object.keys(PRIORITIES).join(', ')})`)
  return p
}

function format(t: Task, today: string): string {
  const mark = t.status === 'done' ? '✓ ' : t.status === 'cancelled' ? '✗ ' : ''
  const bits = [`[${t.id ?? '----'}]`, `${mark}${t.text}`]
  if (t.priority) bits.push(PRIORITIES[t.priority])
  if (t.due) bits.push(`📅 ${t.due}${t.status === 'open' && t.due < today ? ' (overdue)' : t.due === today ? ' (today)' : ''}`)
  if (t.recurrence) bits.push(`🔁 ${t.recurrence}`)
  const head = `  ${bits.join(' ')}`
  return t.notes.length ? `${head}\n${t.notes.map((n) => `      ${n.trim()}`).join('\n')}` : head
}

function printTasks(tasks: Task[], today: string): string {
  if (!tasks.length) return 'nothing'
  const out: string[] = []
  let list = ''
  for (const t of sortTasks(tasks)) {
    if (t.list !== list) out.push(`${out.length ? '\n' : ''}${(list = t.list)}`)
    out.push(format(t, today))
  }
  return out.join('\n')
}

export function run(argv: string[], env: Record<string, string | undefined> = process.env): string {
  const { pos, flags } = parseArgs(argv)
  const one = (k: string) => flags[k]?.at(-1)
  const has = (k: string) => !!flags[k]
  const [cmd, ...rest] = pos
  if (!cmd || has('help') || cmd === 'help') return HELP

  const root = one('root') ?? env.TODO_ROOT
  if (!root) throw new Error('set TODO_ROOT to the todo folder (or pass --root)')
  if (!existsSync(root)) throw new Error(`TODO_ROOT ${root} does not exist`)
  const user = (one('user') ?? env.TODO_USER)?.toLowerCase()
  const store = new Store({ root, today: env.TODO_TODAY })
  const json = has('json')
  const out = (value: unknown, text: string) => (json ? JSON.stringify(value, null, 2) : text)
  const needUser = () => {
    if (!user) throw new Error('who is this for? pass --user or set TODO_USER')
    return user
  }
  const ids = () => {
    if (!rest.length) throw new Error(`${cmd} needs at least one id`)
    return rest
  }
  const query = (extra: Partial<Query> = {}): Query => ({
    user,
    all: has('all'),
    area: one('area'),
    tag: one('tag'),
    due: one('due') as Query['due'],
    status: has('any') ? 'any' : has('done') ? 'done' : 'open',
    ...extra,
  })
  const collect = (q: Query) => {
    const lists = visibleLists(store.lists(), q).map((l) => l.name)
    store.assignIds(lists) // tasks typed in Obsidian get an id the first time an agent sees them
    return lists.flatMap((l) => store.readTasks(l)).filter((t) => matches(t, q, store.today))
  }

  switch (cmd) {
    case 'lists': {
      const lists = visibleLists(store.lists(), query())
      const rows = lists.map((l) => ({ ...l, open: store.readTasks(l.name).filter((t) => t.status === 'open').length }))
      return out(rows, rows.map((l) => `${l.name}${l.area ? ` (${l.area})` : ''}: ${l.open} open`).join('\n') || 'no lists')
    }
    case 'list': {
      const due = one('due')
      if (due && !['overdue', 'today', 'week'].includes(due)) throw new Error('--due is overdue, today or week here')
      if (!user && !rest.length && !has('all')) needUser()
      const tasks = collect(query({ lists: rest.map((l) => store.resolve(l, user)) }))
      return out(sortTasks(tasks), printTasks(tasks, store.today))
    }
    case 'search': {
      const text = rest.join(' ')
      if (!text) throw new Error('search for what?')
      const tasks = collect(query({ text }))
      return out(sortTasks(tasks), printTasks(tasks, store.today))
    }
    case 'add': {
      const [name, ...words] = rest
      if (!name || !words.length) throw new Error('usage: todo add <list> <text...>')
      const list = store.resolve(name, user)
      const due = one('due')
      const t = store.add(list, words.join(' '), { due: due && parseDate(due, store.today), priority: prio(one('prio')), tags: flags.tag })
      return out(t, `added to ${t.list}\n${format(t, store.today)}`)
    }
    case 'done':
    case 'undo':
    case 'cancel':
    case 'rm': {
      const done = ids().map((id) => store[cmd](id))
      const verb = { done: 'done', undo: 'reopened', cancel: 'cancelled', rm: 'removed' }[cmd]
      return out(done, done.map((t) => `${verb}: ${t.list}\n${format(t, store.today)}`).join('\n'))
    }
    case 'edit': {
      const [id] = ids()
      const due = one('due')
      const t = store.edit(id!, {
        text: one('text'),
        due: has('no-due') ? null : due ? parseDate(due, store.today) : undefined,
        priority: has('no-prio') ? null : prio(one('prio')),
        addTags: flags.tag,
        removeTags: flags.untag,
      })
      return out(t, `edited: ${t.list}\n${format(t, store.today)}`)
    }
    case 'move': {
      const [id, to] = rest
      if (!id || !to) throw new Error('usage: todo move <id> <list>')
      const t = store.move(id, store.resolve(to, user))
      return out(t, `moved to ${t.list}\n${format(t, store.today)}`)
    }
    case 'archive': {
      const days = Number(one('days') ?? 7)
      if (!Number.isFinite(days) || days < 0) throw new Error('--days is a number of days')
      const lists = rest.length ? rest.map((l) => store.resolve(l, user)) : visibleLists(store.lists(), query()).map((l) => l.name)
      const n = store.archive(lists, days)
      return out({ archived: n }, `archived ${n} task${n === 1 ? '' : 's'}`)
    }
    case 'init': {
      const who = (rest[0] ?? needUser()).toLowerCase()
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(who) || who === 'shared') throw new Error(`bad user name "${who}"`)
      const made = store.init(who)
      return out({ created: made }, made.length ? `created ${made.join(', ')}` : 'already there')
    }
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`)
  }
}

if (import.meta.main) {
  try {
    console.log(run(process.argv.slice(2)))
  } catch (err) {
    console.error(`todo: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
