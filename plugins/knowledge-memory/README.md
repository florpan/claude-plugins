# knowledge-memory

Saves what a Claude Code session learns straight into a
[Graphiti](https://github.com/getzep/graphiti) knowledge graph, a little after
every turn, instead of in one big batch at the next session start.

This depends on a Graphiti MCP server connected to Claude Code. Without one it
does nothing useful, but the pattern (cheap judge, cached fork, MCP write) is
easy to point at another store.

## How it works

After each answered turn of the main thread, in the background:

1. **A small model judges the turn.** Haiku (by default) reads the last
   exchange and the episodes already saved this session, and answers `SKIP`,
   `LEARNING: <what>` (reusable across projects) or `PROJECT: <what>`
   (specific to this project). Most turns are `SKIP`.
2. **The graph is checked.** The plugin searches the graph
   (`search_memory_facts`) for what the judge flagged.
3. **A fork writes the episode.** A tool-less `$.model.fork` replays the
   session's own transcript from the prompt cache, so it writes with the full
   context at a fraction of the price. It gets the facts the graph already
   holds and answers `skip` (already known), `correction` (the episode states
   what it replaces) or `new`, with a title and a short self-contained
   markdown body.
4. **The episode goes to the graph** through the server's `add_memory` tool:
   learnings to `learningGroup`, project facts to `project_<name>`.

Claude Code's own file-based auto-memory is mirrored too: each Write or Edit
of a file under `~/.claude/projects/<project>/memory/` replaces that file's
episode (`project-memory: <project>/<file>`) in the project's group. The
episode id is a UUID v5 of the group and file name, so one file is always one
episode, and it is written into the file's frontmatter as `knowledge_id`. This
needs a server whose `add_memory` treats a given `uuid` as "create or replace";
plain Graphiti only accepts the uuid of an existing episode.

The status line shows the last save. Nothing is added to the conversation.

## Per-project settings

A project can put a `.claude/memory.json` in its root. The plugin uses the
nearest one at or above the session's folder, so a session started in a
subfolder still lands in the project's group.

```json
{
  "group": "project_myapp",
  "save": "Architecture decisions, deploy setup, where things live.",
  "skip": "UI tweaks. Credentials.",
  "recall": true
}
```

| Key | Meaning |
| --- | --- |
| `group` | `group_id` for this project's facts and its auto-memory files. Without it: `project_<folder name>` |
| `save`, `skip` | Plain-text guidance the judge gets with every turn |
| `recall` | Reserved for recall; not used yet |

`/knowledge-memory` shows which file is in use.

## Permission

The episode is written with the session's own MCP connection, so it goes
through your permission rules. Allow the tool once, or every save will ask:

```json
{ "permissions": { "allow": ["mcp__knowledge__add_memory"] } }
```

(Use your server's name in place of `knowledge`.)

## Commands

- `/knowledge-memory`: what was saved this session and the last result
- `/knowledge-memory now`: judge the last turn now
- `/knowledge-memory save <what>`: save something now, without the judge; the
  writer checks the graph the same way and picks learning or project itself

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `server` | `knowledge` | The Graphiti MCP server's name as `/mcp` lists it |
| `learningGroup` | `learning` | `group_id` for cross-project learnings |
| `judgeModel` | `haiku` | The model that judges each turn |
| `mirrorAutoMemory` | `true` | Mirror auto-memory file writes to the graph |

## Cost

One small judge call per turn (the last exchange, capped at 12k characters).
On a flagged turn, one fork that reads the conversation from the prompt cache
and writes a few hundred tokens. Graphiti's own entity extraction runs on the
server, on whatever model it is configured with.
