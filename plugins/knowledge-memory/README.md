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
2. **A fork writes the episode.** Only when it is not `SKIP`: a tool-less
   `$.model.fork` replays the session's own transcript from the prompt cache,
   so it writes with the full context at a fraction of the price, and replies
   with a title and a short self-contained markdown body.
3. **The episode goes to the graph** through the server's `add_memory` tool:
   learnings to `learningGroup`, project facts to `project_<name>`.

Claude Code's own file-based auto-memory is mirrored too: each Write or Edit
of a file under `~/.claude/projects/<project>/memory/` is sent to the graph as
`project-memory: <project>/<file>` in `project_<name>`, as soon as it lands.

The status line shows the last save. Nothing is added to the conversation.

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
