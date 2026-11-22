---
name: review
description: Open Agent Review, a visual review of code changes (architecture, impact, findings, dependency evidence, source diffs) for the worktree, a commit or a pull request. USE WHEN agent review, review canvas, review my changes visually, review what the agent changed, open the review UI, walk me through this change.
---

# Agent Review

Agent Review is Mark Russinovich's GitHub Copilot canvas, run unmodified by this plugin's `agent-review` MCP server. Its UI is a local web page; its analysis is deterministic, and its explanations are written by Claude.

## Opening it

1. Call `open_review`. `repoPath` defaults to the project directory; pass `baseRef` only when the user names a base (`origin/main`, `HEAD`). The first call ever downloads the pinned upstream bundle and can take a minute.
   - **Model**: when the user names a model, as the argument (`/agent-review:review haiku`) or in their own words, pass it as `model`. That model then answers every AI request of the review. Without one, leave `model` out: the plugin's settings decide (by default Sonnet writes explanations and Opus runs the review passes). `model: "default"` returns to those. The result's `models` says what is in effect.
2. Show the returned URL to the user:
   - **A browser pane is available** (the Claude desktop app's built-in browser, tools named `...Claude_Browser__*`): open the URL there with `preview_start`, so the review sits beside the chat. The server runs on the machine this session runs on. If the pane refuses or cannot reach a `127.0.0.1` address (a session running in the cloud always will), do not retry: use the next option.
   - **No browser pane, or it could not open the URL**: call `open_review` again with `openInBrowser: true`, which opens the system browser on the machine the server runs on, and give the user the URL as well.
3. The user chooses what to review in the page: Worktree, Commit or Pull request. Nothing is analyzed before that.

The server and its URL live as long as this session. Opening the same repository again returns the same URL.

## Working with the open review

The other tools act on the review the user is looking at:

- `get_review_context`: without `id`, a compact summary; with an item id, the evidence and relationships for that node, edge, package or finding. Read this before making claims about the change.
- `focus_item`: move the user's view to an item, so both of you look at the same evidence.
- `add_review_observation`: put a finding of your own in the review. Every factual claim must cite evidence ids that `get_review_context` returned; an observation without evidence is refused.
- `get_session_change_context`: which prompts led to which file changes. Context, not proof of authorship.
- `refresh`: re-analyze after the code changed. `cancel` stops a running analysis.
- `close_review`: stop the server when the user is done.

## Limits to mention when they matter

- Explanations cost one headless Claude call each and take from seconds to a minute or two; the page shows them as they arrive.
- Upstream cancels any request that takes over two minutes. A slow model on a large change loses review passes that way and the findings stay incomplete; a faster model for the review fixes it.
- Upstream's wording still says "Copilot" in places. The text is Claude's.
- .NET, Go, Rust and C/C++ analysis need those toolchains installed; Python 3.11+ and git are always needed.
