# agent-review

Runs [Agent Review](https://github.com/markrussinovich/agent-review), Mark Russinovich's GitHub Copilot canvas for reviewing agent-made changes, inside Claude Code. Upstream's code runs unmodified; this plugin is the host it expects, built for Claude.

Agent Review reads a change from the top down: intent and architecture, then impact, findings, dependency evidence and source diffs, with a review queue and per-file decisions. See upstream's README for what it does.

## How it works

A Copilot canvas is a local web app: the extension starts an HTTP server and hands Copilot a URL. Nearly all of Agent Review (analyzers, review state, server, UI) does not care who the host is. It touches Copilot in three places, and this plugin stands in for each:

| Upstream uses Copilot for | Here |
|---|---|
| Joining the host session and registering its canvas (`@github/copilot-sdk/extension`) | A module-resolution hook points the import at `server/shim/`; the canvas is opened and driven from MCP tools |
| Every AI text: a tool-less Copilot session per explanation (`@github/copilot-sdk`) | One headless `claude -p` call per explanation: no tools, no customizations, nothing saved |
| Provenance: the session's events, and earlier sessions for the same repository | Claude Code's transcripts under `~/.claude/projects`, replayed as Copilot-shaped events |

Upstream itself is not in this repository. The first `open_review` downloads the release archive pinned in `upstream.json` (the same archive upstream's own Copilot bootstrap fetches), checks its size and SHA-256, and unpacks it into the plugin's data directory.

## Install

```
/plugin install agent-review --marketplace florpan/claude-plugins
```

## Using it

Ask Claude to open Agent Review, or run `/agent-review:review`. Claude calls `open_review` and shows you the URL: in the desktop app's browser pane, or in your system browser from a terminal. Choose Worktree, Commit or Pull request in the page.

To pick the model for a review, name it: `/agent-review:review haiku`, or "open Agent Review with opus". That model then answers every request of that review. The page's Settings (gear) menu changes the same choice.

While a review is open Claude has upstream's canvas actions as tools: `get_review_context`, `focus_item`, `add_review_observation`, `get_session_change_context`, `refresh`, `cancel`. They come from upstream's own definition, so they follow the pinned version.

## Requirements

- Node.js 22.15 or newer on `PATH` (upstream targets Node 24)
- Python 3.11+ and git
- The `claude` CLI, signed in
- For those languages only: the .NET SDK, Go, Rust or a C/C++ toolchain

## Settings

Agent Review makes two kinds of model call, and they ask for different things. Explanations (overview, summaries, per-file explanations, discussion answers) describe code that is in front of the model. Review passes look for defects in the change and then verify each candidate against the source. Copilot has a router, Fusion, that picks a model per request. Here each kind has its own model:

| Setting | Default | Meaning |
|---|---|---|
| Model for explanations | `sonnet` | A model name, or `session` for the model of the session that opened the review |
| Model for review passes | `opus` | The same, for the passes that find and verify defects |
| Effort for explanations | `low` | Effort level of every call |

These are plugin settings, asked for when the plugin is enabled. They reach the server as `AGENT_REVIEW_MODEL`, `AGENT_REVIEW_REVIEW_MODEL` and `AGENT_REVIEW_EFFORT`. They are what "Session model" in the page's Settings menu stands for; a model picked there, or named when opening the review, answers both kinds. The rest are environment variables of the MCP server:

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_REVIEW_CONCURRENCY` | `3` | Explanation calls running at once |
| `AGENT_REVIEW_MODELS` | `opus,sonnet,haiku` | Models offered in the page's Settings menu, beside the session's own |
| `AGENT_REVIEW_CLAUDE` | the CLI that started the server | Path of the `claude` executable |
| `AGENT_REVIEW_PYTHON` | `py -3`, `python`, `python3` | Python executable (also read by upstream) |
| `AGENT_REVIEW_HOME` | the plugin's data directory | Where the bundle and review state live |
| `AGENT_REVIEW_BUNDLE_DIR` | | Use this unpacked upstream directory instead of the pinned download |
| `AGENT_REVIEW_DEBUG_DIR` | | Keep every explanation request and answer here |

Each explanation is a model call on your Claude plan, and the page prefetches the next file's explanation while you read.

Speed decides what a model can be used for: upstream gives every request two minutes and cancels what is not done. Measured on a 2,000-line change at low effort, one review pass took about 16 seconds on Sonnet, 40 on Opus and 100 to 115 on the largest model, which then loses passes to the limit. A file explanation took about 15 seconds on Sonnet and 35 on the largest model. If a review's findings stay incomplete, the review-pass model is too slow for the change.

The two kinds of call are told apart by the opening of upstream's review-pass prompt. If an upstream release rewords it, review passes run on the explanation model until `server/models.mjs` follows; the tests check this against the bundle.

## What differs from Copilot

- **Fusion** in the model menu is Copilot's own model router. It is not available; choosing it gives the same as "Session model": the two configured models.
- "Session model" in that menu means the configured models, which by default are not the model your session runs.
- The page's wording still says "Copilot" and "Copilot canvas" in places. The text it labels is Claude's.
- Provenance covers what Claude Code's file tools did (Edit, Write, NotebookEdit). A file changed by a shell command is not attributed to a prompt, as in upstream.
- Review progress belongs to the Claude session that opened the review, and is pruned 30 days after last use.

## Updating upstream

`upstream.json` is a copy of `release-manifest.json` from upstream's `dist` branch. To move to a newer upstream, replace it with the newer manifest and run the tests against the new bundle:

```
node --test "tests/*.test.mjs"
```

Set `AGENT_REVIEW_BUNDLE_DIR` to an unpacked bundle to include the test that runs upstream's own attribution code over a sample transcript.

The shim covers the part of the Copilot SDK upstream uses today: `joinSession`, `createCanvas`, `CanvasError`, and `CopilotClient` with `start`, `stop`, `listModels`, `createSession`, `listSessions`, `resumeSession`. An upstream release that reaches for more will fail at that call with the missing name.

## License

MIT. Agent Review is © Mark Russinovich, MIT licensed, and is downloaded from its own repository, not redistributed here.
