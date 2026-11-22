// Stands in for "@github/copilot-sdk": upstream starts a Copilot CLI server and
// opens tool-less sessions on it for every explanation, and lists and resumes
// earlier sessions for provenance. Here a session is a headless Claude call and
// the earlier sessions are Claude Code's transcripts.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { askClaude } from "../claude.mjs";
import { host } from "../host.mjs";
import { modelFor } from "../models.mjs";
import { setting } from "../paths.mjs";
import { listSessions, sessionEvents } from "../transcripts.mjs";

const execFileAsync = promisify(execFile);

export const RuntimeConnection = {
    forStdio: (options) => ({ kind: "stdio", ...options }),
};

// The picker's entries beside "the session's model". Aliases, so they do not age with model releases.
function offeredModels() {
    const configured = setting("AGENT_REVIEW_MODELS");
    const ids = configured ? configured.split(",").map((id) => id.trim()).filter(Boolean) : ["opus", "sonnet", "haiku"];
    return ids.map((id) => ({ id, name: `Claude ${id[0].toUpperCase()}${id.slice(1)}`, policy: { state: "enabled" } }));
}

async function worktreeRoots(directory) {
    try {
        const { stdout } = await execFileAsync("git", ["-C", directory, "worktree", "list", "--porcelain"],
            { encoding: "utf8", windowsHide: true, timeout: 10_000 });
        return stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
    } catch {
        return [];
    }
}

export class CopilotClient {
    constructor({ workingDirectory } = {}) {
        this.workingDirectory = workingDirectory || process.cwd();
        this.transcripts = new Map();
    }

    async start() {}

    async stop() {}

    async listModels() {
        return offeredModels();
    }

    async createSession({ model } = {}) {
        const controller = new AbortController();
        return {
            sendAndWait: async ({ prompt, responseSchema }, timeoutMs) => {
                const content = await askClaude({
                    prompt, responseSchema, model: modelFor(model, prompt), timeoutMs, signal: controller.signal,
                    // A neutral directory: an explanation must not pick up the reviewed repository's instructions.
                    cwd: host().session?.workspacePath,
                });
                return { data: { content, toolRequests: [] } };
            },
            abort: async () => controller.abort(new Error("The explanation request was cancelled.")),
            disconnect: async () => {},
        };
    }

    async listSessions() {
        const roots = [...new Set([this.workingDirectory, ...await worktreeRoots(this.workingDirectory)])];
        const sessions = await listSessions(roots);
        for (const session of sessions) this.transcripts.set(session.sessionId, session.transcript);
        return sessions.map(({ transcript, ...metadata }) => metadata);
    }

    async resumeSession(sessionId) {
        const transcript = this.transcripts.get(sessionId);
        if (!transcript) throw new Error(`Unknown Claude session: ${sessionId}`);
        return {
            getEvents: () => sessionEvents(transcript),
            disconnect: async () => {},
        };
    }
}
