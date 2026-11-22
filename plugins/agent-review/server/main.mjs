#!/usr/bin/env node
// MCP server: runs Mark Russinovich's Agent Review (a GitHub Copilot canvas
// extension) unmodified inside Claude Code. See ../README.md.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "./mcp.mjs";
import { homeDirectory, log, setting } from "./paths.mjs";
import { ReviewHost } from "./review.mjs";

// stdout carries the protocol; nothing upstream prints may reach it.
console.log = console.error;
console.info = console.error;

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const release = await read("../upstream.json");
const plugin = await read("../.claude-plugin/plugin.json");
const review = new ReviewHost({ release, home: homeDirectory(), cwd: process.cwd() });

const OWN_TOOLS = [
    {
        name: "open_review",
        description: "Start Agent Review for a repository and return the URL of its review UI: architecture, impact, "
            + "findings, dependency evidence and source diffs for the changes in the worktree, a commit or a pull request. "
            + "The UI is a local web page; show the returned URL to the user in a browser pane or tab. "
            + "The first call downloads the pinned upstream bundle and can take a minute.",
        inputSchema: {
            type: "object",
            properties: {
                repoPath: { type: "string", description: "Repository path. Defaults to the session's project directory." },
                baseRef: { type: "string", description: "Optional base branch or ref to compare against, such as origin/main or HEAD." },
                model: { type: "string", description: "Model for this review's AI requests, when the user names one: haiku, sonnet, opus or a model id. It then answers every request. \"default\" returns to the configured models. Omit to leave the choice as it is; it applies to requests made from then on." },
                openInBrowser: { type: "boolean", description: "Also open the URL in the system's default browser. Leave false when you can show it in a browser pane yourself." },
            },
            additionalProperties: false,
        },
    },
    {
        name: "close_review",
        description: "Close the open Agent Review and stop its local server.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
];

function openInSystemBrowser(url) {
    const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (error) => log("could not open the browser:", error.message));
    child.unref();
}

let actionNames = new Set();

async function listTools() {
    const definition = await review.definition();
    const actions = (definition?.actions || []).map((action) => ({
        name: action.name,
        description: `${action.description} Needs a review opened with open_review.`,
        inputSchema: action.inputSchema || { type: "object", properties: {}, additionalProperties: false },
    }));
    actionNames = new Set(actions.map((action) => action.name));
    return [...OWN_TOOLS, ...actions];
}

const server = serve({
    info: { name: "agent-review", version: plugin.version },
    instructions: "Agent Review shows a change review UI as a local web page. open_review starts it and returns the URL; "
        + "the other tools read from and write to the review the user is looking at.",
    listTools,
    onClose: () => review.shutdown(),
    callTool: async (name, input) => {
        if (name === "open_review") {
            const known = actionNames.size > 0;
            const result = await review.open(input, (message) => log(message));
            if (!known) server.notify("notifications/tools/list_changed");
            if (input.openInBrowser) openInSystemBrowser(result.url);
            return {
                url: result.url,
                repository: result.repository,
                models: result.models,
                upstream_commit: release.source_commit,
                opened_in_system_browser: Boolean(input.openInBrowser),
                next: "Show the URL to the user. They pick what to review (worktree, commit or pull request) in the page.",
            };
        }
        if (name === "close_review") {
            const closed = await review.close();
            return closed ? { closed: closed.repository } : { closed: null };
        }
        if (!actionNames.size) await listTools();
        if (!actionNames.has(name)) throw new Error(`Unknown tool: ${name}`);
        return review.action(name, input);
    },
});

log(`ready (upstream ${release.source_commit.slice(0, 7)}), data in ${homeDirectory()}, cwd ${process.cwd()},`
    + ` session id ${setting("CLAUDE_CODE_SESSION_ID") ? "passed" : "not passed"}`);
if (setting("AGENT_REVIEW_DEBUG_DIR")) {
    // What Claude Code handed this server; stderr is not always easy to find.
    const facts = { home: homeDirectory(), cwd: process.cwd(), node: process.version,
        session: setting("CLAUDE_CODE_SESSION_ID"), project: setting("CLAUDE_PROJECT_DIR"), claude: setting("CLAUDE_CODE_EXECPATH"),
        model: process.env.AGENT_REVIEW_MODEL ?? null, reviewModel: process.env.AGENT_REVIEW_REVIEW_MODEL ?? null, effort: process.env.AGENT_REVIEW_EFFORT ?? null };
    mkdir(setting("AGENT_REVIEW_DEBUG_DIR"), { recursive: true })
        .then(() => writeFile(join(setting("AGENT_REVIEW_DEBUG_DIR"), "server.json"), JSON.stringify(facts, null, 2)))
        .catch((error) => log("debug record failed:", error.message));
}
