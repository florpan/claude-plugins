# claude-plugins

Christer's Claude Code mods and plugins, in one place so they can be installed
on any machine from this repository.

Some of them depend on my own setup (homelab services, a personal knowledge
graph). They are public anyway: take the code and adapt it to yours.

## Install

In a Claude Code terminal session:

```
/plugin install <mod> --marketplace <owner>/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope (user scope runs it in
every session).

To work on a mod from a local clone, add the clone as a marketplace; the
installed mod is then read straight from the folder, and `/reload-plugins`
picks up edits:

```
claude plugin marketplace add <path-to-clone>
claude plugin install <mod>@berge-claude-plugins
```

## Mods

| Mod | What it does |
| --- | --- |
| [cache-warmer](plugins/cache-warmer) | Keeps the prompt cache warm while the session is idle |

## Rules for this repo

- No secrets, ever. Configuration goes in `userConfig` options or environment
  variables, never in the code.
- Each mod passes `claude plugin validate` and `claude plugin test`.
- `plugins/*/.claude-plugin/types/` is written by Claude Code and is not committed.
