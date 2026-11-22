# todo

Todo lists as plain markdown files in a folder you sync however you like (Syncthing, a cloud drive). The
same files are an Obsidian vault for people and a small CLI for agents, so a desktop session, a house
assistant and a phone all work on one set of lists.

- One list per file, one task per line, in the [Obsidian Tasks](https://publish.obsidian.md/tasks/) format:
  `- [ ] Call the plumber #house ⏫ ➕ 2026-11-22 📅 2026-11-25 🆔 k3f9`
- A folder per person, plus `shared/` for the household. Everyone can read everything; the CLI just
  doesn't show other people's lists unless asked, and keeps `area: work` lists to their owner.
- Agents change lists only through the CLI. It re-reads the file, changes one line, and writes through a
  temp file and a rename, so it doesn't fight Obsidian or the sync tool.

## Layout

```
<TODO_ROOT>/
  users.md                 who is who (names, chat ids, mail addresses) for multi-user assistants
  shared/groceries.md      lists for everyone
  shared/index.md          Obsidian page: every open shared task
  <user>/inbox.md          a person's lists; any name, subfolders allowed (projects/<repo>.md)
  <user>/work.md           frontmatter "area: work" keeps it to its owner
  <user>/index.md          Obsidian page: the user's tasks plus shared ones
  <list>.archive.md        finished tasks moved out by "todo archive"
```

Files in the root, `index.md` pages (`type: index`), archives and dot-folders (`.obsidian`, `.stversions`,
`.trash`) are not lists.

## CLI

```bash
export TODO_ROOT=~/Todo TODO_USER=me
bun tools/todo.ts init me
bun tools/todo.ts add groceries Milk             # → me/groceries, or shared/groceries if that exists
bun tools/todo.ts add inbox Renew passport --due +2w --prio high
bun tools/todo.ts list --due week
bun tools/todo.ts done k3f9
bun tools/todo.ts --help
```

Every command takes `--json`. Requires [Bun](https://bun.sh); no dependencies.

## Install

```
/plugin install todo --marketplace florpan/claude-plugins
```

Then set the folder (and, for a personal session, the user) in the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "TODO_ROOT": "C:\\Users\\me\\Todo", "TODO_USER": "me" } }
```

In a session that serves several people, leave `TODO_USER` unset; the skill tells the agent to pass
`--user` per request, using `users.md`.

## Obsidian

Open `TODO_ROOT` as a vault and install the community plugin **Tasks**. The `index.md` pages are Tasks
queries. Ticking a recurring task (`🔁`) in Obsidian creates the next one; the CLI does not.

## Not handled

- Recurrence beyond keeping the `🔁` text (see above).
- Real access control: anyone with the folder can read and change every list.
- Two writers changing the *same line* within one sync interval: the sync tool decides (Syncthing keeps a
  `.sync-conflict` copy).

## Tests

```bash
bun test
```
