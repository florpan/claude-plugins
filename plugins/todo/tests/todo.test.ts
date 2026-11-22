import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDate, parseTask, setDate, setPriority, Store, visibleLists } from '../tools/lib'
import { run } from '../tools/todo'

const TODAY = '2026-11-22' // a Sunday
let root: string
let n: number
const store = () => new Store({ root, today: TODAY, random: () => `id${n++}` })
const read = (rel: string) => readFileSync(join(root, ...rel.split('/')), 'utf8')
const write = (rel: string, text: string) => {
  const p = join(root, ...rel.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}
const cli = (...args: string[]) => run(args, { TODO_ROOT: root, TODO_USER: 'christer', TODO_TODAY: TODAY })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'todo-'))
  n = 1
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('dates', () => {
  expect(parseDate('today', TODAY)).toBe('2026-11-22')
  expect(parseDate('tomorrow', TODAY)).toBe('2026-11-23')
  expect(parseDate('+3d', TODAY)).toBe('2026-11-25')
  expect(parseDate('+1w', TODAY)).toBe('2026-11-29')
  expect(parseDate('monday', TODAY)).toBe('2026-11-23')
  expect(parseDate('sun', TODAY)).toBe('2026-11-29') // the next one, not today
  expect(parseDate('2026-12-24', TODAY)).toBe('2026-12-24')
  expect(() => parseDate('soon', TODAY)).toThrow()
})

test('parses a Tasks line', () => {
  const t = parseTask('- [ ] Buy milk #store ⏫ 🔁 every week ➕ 2026-11-20 📅 2026-11-25 🆔 k3f9')!
  expect(t).toMatchObject({ status: 'open', text: 'Buy milk #store', tags: ['store'], priority: 'high', due: '2026-11-25', created: '2026-11-20', id: 'k3f9', recurrence: 'every week' })
  expect(parseTask('- [x] Done thing ✅ 2026-11-21')).toMatchObject({ status: 'done', done: '2026-11-21', text: 'Done thing' })
  expect(parseTask('- [-] Dropped')).toMatchObject({ status: 'cancelled' })
  expect(parseTask('  * [ ] nested')).toMatchObject({ text: 'nested' })
  expect(parseTask('- not a task')).toBeUndefined()
})

test('field edits keep the rest of the line', () => {
  const line = '- [ ] Call the plumber #house 📅 2026-11-25 🆔 ab12'
  expect(setDate(line, 'due', '2026-12-01')).toBe('- [ ] Call the plumber #house 🆔 ab12 📅 2026-12-01')
  expect(setDate(line, 'due')).toBe('- [ ] Call the plumber #house 🆔 ab12')
  expect(setPriority(line, 'high')).toBe('- [ ] Call the plumber #house ⏫ 📅 2026-11-25 🆔 ab12')
  expect(setPriority(setPriority(line, 'high'), 'low')).toBe('- [ ] Call the plumber #house 🔽 📅 2026-11-25 🆔 ab12')
  expect(setPriority(setPriority(line, 'high'))).toBe(line)
})

test('add creates the list with frontmatter and appends after the last task', () => {
  const s = store()
  s.add('christer/ideas', 'Try Syncthing', { tags: ['homelab'], priority: 'medium', due: '2026-11-30' })
  s.add('christer/ideas', 'Second')
  expect(read('christer/ideas.md')).toBe(
    '---\nowner: christer\n---\n\n# Ideas\n\n- [ ] Try Syncthing #homelab 🔼 ➕ 2026-11-22 📅 2026-11-30 🆔 id1\n- [ ] Second ➕ 2026-11-22 🆔 id2\n',
  )
})

test('add lands in the last section, keeps CRLF and text after the tasks', () => {
  write('shared/groceries.md', '# Groceries\r\n\r\n## Dairy\r\n- [ ] Milk\r\n\r\n## Fruit\r\n- [ ] Apples\r\n  - two kinds\r\n\r\nNotes at the end\r\n')
  store().add('shared/groceries', 'Pears')
  expect(read('shared/groceries.md')).toBe(
    '# Groceries\r\n\r\n## Dairy\r\n- [ ] Milk\r\n\r\n## Fruit\r\n- [ ] Apples\r\n  - two kinds\r\n- [ ] Pears ➕ 2026-11-22 🆔 id1\r\n\r\nNotes at the end\r\n',
  )
})

test('list names resolve to the user, then shared, then a new list', () => {
  write('shared/groceries.md', '# G\n')
  write('christer/ideas.md', '# I\n')
  const s = store()
  expect(s.resolve('ideas', 'christer')).toBe('christer/ideas')
  expect(s.resolve('groceries', 'christer')).toBe('shared/groceries')
  expect(s.resolve('books', 'christer')).toBe('christer/books')
  expect(s.resolve('alex/school', 'christer')).toBe('alex/school')
  expect(() => s.resolve('books')).toThrow()
  expect(() => s.resolve('../etc', 'christer')).toThrow()
  expect(() => s.resolve('.obsidian/x', 'christer')).toThrow()
})

test('done, undo, cancel, edit, rm', () => {
  const s = store()
  const t = s.add('christer/inbox', 'Fix the gate')
  expect(s.done(t.id!)).toMatchObject({ status: 'done', done: TODAY })
  expect(read('christer/inbox.md')).toContain('- [x] Fix the gate ➕ 2026-11-22 🆔 id1 ✅ 2026-11-22')
  const reopened = s.undo(t.id!)
  expect(reopened.status).toBe('open')
  expect(reopened.done).toBeUndefined()
  expect(s.cancel(t.id!)).toMatchObject({ status: 'cancelled', cancelled: TODAY })
  s.undo(t.id!)
  const e = s.edit(t.id!, { text: 'Fix the garden gate', due: '2026-11-24', priority: 'high', addTags: ['house'] })
  expect(e).toMatchObject({ text: 'Fix the garden gate #house', due: '2026-11-24', priority: 'high', tags: ['house'] })
  const cleared = s.edit(t.id!, { due: null, priority: null, removeTags: ['house'] })
  expect([cleared.text, cleared.due, cleared.priority]).toEqual(['Fix the garden gate', undefined, undefined])
  s.rm(t.id!)
  expect(s.readTasks('christer/inbox')).toHaveLength(0)
  expect(() => s.done('nope')).toThrow('no task with id nope')
})

test('move carries sub-items and notes', () => {
  write('christer/inbox.md', '# Inbox\n\n- [ ] Plan trip 🆔 aa11\n  - [ ] book hotel 🆔 bb22\n  notes here\n- [ ] Other 🆔 cc33\n')
  const s = store()
  s.move('aa11', 'christer/travel')
  expect(read('christer/inbox.md')).toBe('# Inbox\n\n- [ ] Other 🆔 cc33\n')
  expect(read('christer/travel.md')).toContain('# Travel\n\n- [ ] Plan trip 🆔 aa11\n  - [ ] book hotel 🆔 bb22\n  notes here\n')
  expect(s.find('bb22')?.list).toBe('christer/travel')
  expect(s.find('aa11')?.notes).toEqual(['  notes here'])
})

test('tasks typed in Obsidian get ids, unique across the vault', () => {
  write('shared/house.md', '- [ ] Paint 🆔 id1\n- [ ] Clean gutters\n')
  write('christer/x.md', '- [ ] Something\n')
  const s = store()
  expect(s.assignIds(['shared/house', 'christer/x'])).toBe(2)
  expect(read('shared/house.md')).toBe('- [ ] Paint 🆔 id1\n- [ ] Clean gutters 🆔 id2\n')
  expect(read('christer/x.md')).toBe('- [ ] Something 🆔 id3\n')
  expect(s.assignIds(['shared/house'])).toBe(0)
})

test('visibility: own + shared by default, others with --all, work only for its owner', () => {
  write('christer/work.md', '---\narea: work\n---\n- [ ] Deploy\n')
  write('christer/ideas.md', '- [ ] Idea\n')
  write('alex/school.md', '- [ ] Homework\n')
  write('shared/groceries.md', '- [ ] Milk\n')
  write('users.md', '| user |\n')
  write('christer/index.md', '---\ntype: index\n---\n')
  const lists = store().lists()
  expect(lists.map((l) => l.name)).toEqual(['alex/school', 'christer/ideas', 'christer/work', 'shared/groceries'])
  const names = (q: object) => visibleLists(lists, q).map((l) => l.name)
  expect(names({ user: 'christer' })).toEqual(['christer/ideas', 'christer/work', 'shared/groceries'])
  expect(names({ user: 'alex' })).toEqual(['alex/school', 'shared/groceries'])
  expect(names({ user: 'alex', all: true })).toEqual(['alex/school', 'christer/ideas', 'shared/groceries'])
  expect(names({ user: 'alex', all: true, area: 'work' })).toEqual(['christer/work'])
  expect(names({ user: 'alex', lists: ['christer/work'] })).toEqual(['christer/work'])
})

test('archive moves old finished tasks with their sub-items', () => {
  write('christer/inbox.md', '- [x] Old ✅ 2026-11-01 🆔 a1\n  - [x] sub ✅ 2026-11-01 🆔 a2\n- [x] Recent ✅ 2026-11-20 🆔 a3\n- [-] Dropped ❌ 2026-10-01 🆔 a4\n- [ ] Open 🆔 a5\n')
  expect(store().archive(['christer/inbox'], 7)).toBe(2)
  expect(read('christer/inbox.md')).toBe('- [x] Recent ✅ 2026-11-20 🆔 a3\n- [ ] Open 🆔 a5\n')
  expect(read('christer/inbox.archive.md')).toContain('- [x] Old ✅ 2026-11-01 🆔 a1\n  - [x] sub ✅ 2026-11-01 🆔 a2\n- [-] Dropped ❌ 2026-10-01 🆔 a4\n')
  expect(store().lists().map((l) => l.name)).toEqual(['christer/inbox'])
})

test('no temp files are left behind', () => {
  const s = store()
  const t = s.add('christer/inbox', 'x')
  s.done(t.id!)
  expect(readdirSync(join(root, 'christer'))).toEqual(['inbox.md'])
})

test('cli: add, list with due filters, done, json', () => {
  write('shared/groceries.md', '# Groceries\n')
  expect(cli('add', 'groceries', 'Milk', '--prio', 'high')).toContain('added to shared/groceries')
  cli('add', 'inbox', 'Pay', 'the', 'bill', '--due', 'tomorrow')
  cli('add', 'inbox', 'Late thing', '--due', '2026-11-01')
  const all = cli('list')
  expect(all).toContain('christer/inbox')
  expect(all).toContain('Pay the bill 📅 2026-11-23')
  expect(all).toContain('Late thing 📅 2026-11-01 (overdue)')
  expect(cli('list', '--due', 'today')).not.toContain('Pay the bill')
  expect(cli('list', '--due', 'week')).toContain('Pay the bill')
  const tasks = JSON.parse(cli('list', 'groceries', '--json'))
  expect(tasks).toHaveLength(1)
  cli('done', tasks[0].id)
  expect(cli('list', 'groceries')).toBe('nothing')
  expect(cli('list', 'groceries', '--done')).toContain('✓ Milk')
  expect(cli('search', 'bill')).toContain('Pay the bill')
  expect(JSON.parse(cli('lists', '--json')).map((l: any) => l.name)).toEqual(['christer/inbox', 'shared/groceries'])
})

test('cli: errors are plain', () => {
  expect(() => run(['list'], { TODO_ROOT: root })).toThrow('--user')
  expect(() => run(['list'], {})).toThrow('TODO_ROOT')
  expect(() => cli('add', 'inbox')).toThrow('usage')
  expect(() => cli('add', 'inbox', 'x', '--prio', 'urgent')).toThrow('unknown priority')
  expect(() => cli('frobnicate')).toThrow('unknown command')
  expect(cli('--help')).toContain('todo add')
})

test('cli: init makes an Obsidian index that is not a list', () => {
  expect(cli('init', 'alex')).toBe('created alex/index.md, shared/index.md')
  expect(read('alex/index.md')).toContain('```tasks')
  expect(cli('init', 'alex')).toBe('already there')
  expect(cli('lists')).toBe('no lists')
})
