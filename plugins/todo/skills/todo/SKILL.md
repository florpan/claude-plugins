---
name: todo
description: Todo lists as markdown files (groceries, ideas, house jobs, project todos, work reminders), per person plus shared family lists. USE WHEN todo, to-do, add to the list, put X on the shopping/grocery list, what's on my list, what do I need to do, ideas list, remember to do, tick off, mark done, I bought X, backlog for a project, what's overdue.
---

# Todo

Lists are markdown files in a synced folder (`TODO_ROOT`), one list per file, one task per line in the
Obsidian Tasks format. People read and edit the same files in Obsidian; you change them **only through the
CLI**, which edits one line at a time and keeps the format right.

```bash
bun "${CLAUDE_PLUGIN_ROOT}/tools/todo.ts" <command> [--user <name>] [--json]
```

`bun "${CLAUDE_PLUGIN_ROOT}/tools/todo.ts" --help` lists every command. The ones you need most:

| Want | Command |
|---|---|
| What's on my plate | `list` (all your lists + shared), `list --due week`, `list --due overdue` |
| One list | `list groceries` |
| Add | `add groceries Milk`, `add inbox Call the plumber --due friday --prio high --tag house` |
| Tick off | `done <id> [<id>...]` (also `undo`, `cancel`, `rm`) |
| Change | `edit <id> --due +3d`, `edit <id> --text "..."`, `--no-due`, `--tag x`, `--untag x` |
| Re-file | `move <id> <list>` |
| Find | `search plumber` |
| Which lists exist | `lists` |

Tasks are addressed by their id (the `[k3f9]` in the output, `🆔 k3f9` in the file). Ids are what make edits
safe: always `list` or `search` first, then act on the id. Never guess one, never edit by line text.

## Who is it for

Every command runs as a user: `--user <name>` or `TODO_USER`. A user is a folder: `christer/`, `alex/`.
`shared/` holds lists for everyone (groceries, house).

- In a personal session `TODO_USER` is set; just run the commands.
- In a session that serves several people (a house assistant), work out who is talking from the channel
  (Discord user, email sender, voice) using the session's own list of people (its CLAUDE.md says where;
  otherwise `users.md` in the root), and pass `--user` on **every** command. The user is the person's name in
  lowercase. If you can't tell who it is, ask, or use a `shared/` list when the item is clearly for the household.
- A new person: `init <name>` makes their folder and an Obsidian index page.

## Which list

`<list>` without a slash means: the user's own list with that name, else the shared list with that name,
else a new list of the user's. With a slash it is exactly that file (`shared/house`, `alex/school`).

- Food and household shopping: `groceries` (shared).
- Something for the house: `house` (shared), unless it is clearly one person's job.
- In a code project (the cwd is a repo) and the item is about that project: `projects/<repo folder name>`.
- Work: the user's `work` list.
- Unclear: `inbox`. Don't invent a new list for one item; check `lists` first and use what exists.

New lists are created on the first `add`. To mark a list as work, give its file frontmatter `area: work`
(the CLI writes `owner:` only).

## Privacy

Not security: everyone can read every file, and everyone knows that. The CLI only filters what you *show*:

- By default a user sees their own lists and `shared/`.
- Someone else's lists only when asked for (`--all`, or the list by name: `list christer/ideas`).
- Lists with `area: work` are only shown to their owner, even with `--all`, unless asked for with
  `--area work` or by name. Don't bring up someone's work items to the rest of the family.

## Behaviour

- Answer with the result, not the command. "Milk is on the grocery list." For a list, read it out short;
  in voice keep it to the items, no ids.
- Several items in one sentence ("milk, eggs and coffee"): one `add` per item.
- "I bought X" / "X is done": `search` or `list`, then `done` with the id. If several match, ask which.
- `done` on a recurring task (`🔁`) only ticks it off; the CLI does not create the next one. Obsidian's
  Tasks plugin does when ticked there. Tell the user, or `add` the next one yourself.
- Hand-typed tasks in Obsidian get an id the first time the CLI lists them; that rewrites the file, which
  is expected.
- `archive` moves tasks finished more than 7 days ago to `<list>.archive.md`. Run it when a list's done
  items are cluttering it, or from a scheduled job.

## Setup

- `TODO_ROOT`: the folder. `TODO_USER`: the default user (leave unset in multi-user sessions).
  Set both in the `env` block of Claude Code's `settings.json` so every Bash call sees them.
- The folder is meant to be synced (Syncthing, a cloud drive) and opened as an Obsidian vault with the
  Tasks plugin. `index.md` per user shows everything of theirs in Obsidian.
