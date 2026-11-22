// Hosts upstream's Copilot extension in this process: its imports of the Copilot
// SDK resolve to the shims, it joins a session backed by the Claude transcript,
// and the canvas it registers is opened and driven from MCP tool calls.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleDirectory, ensureBundle } from "./bundle.mjs";
import { host } from "./host.mjs";
import { describeModels, withDefaultModels } from "./models.mjs";
import { log, setting } from "./paths.mjs";
import { findTranscript, newestTranscript, sessionEvents } from "./transcripts.mjs";

const EXTENSION_ID = "claude-code:agent-review";
const SESSION_STATE_DAYS = 30;
const shim = (name) => new URL(`./shim/${name}`, import.meta.url).href;

let redirected = false;

function redirectCopilotImports(directory) {
    if (redirected) return;
    if (typeof registerHooks !== "function") throw new Error("Agent Review needs Node.js 22.15 or newer (module.registerHooks).");
    const bundle = pathToFileURL(directory).href;
    const packages = {
        "@github/copilot-sdk": shim("copilot-sdk.mjs"),
        "@github/copilot-sdk/extension": shim("copilot-sdk-extension.mjs"),
    };
    registerHooks({
        resolve(specifier, context, nextResolve) {
            if (packages[specifier]) return { url: packages[specifier], shortCircuit: true };
            if (/(?:^|\/)managed-copilot\.mjs$/.test(specifier) && context.parentURL?.startsWith(bundle)) {
                return { url: shim("managed-copilot.mjs"), shortCircuit: true };
            }
            return nextResolve(specifier, context);
        },
    });
    redirected = true;
}

// The calling session: the id Claude Code passes when its transcript is the one being written, else the
// transcript written last for this project (the call that got us here was just recorded in it).
export async function resolveSession(cwd) {
    const passed = setting("CLAUDE_CODE_SESSION_ID");
    const passedTranscript = passed ? await findTranscript(passed) : null;
    if (passedTranscript) {
        const age = Date.now() - (await stat(passedTranscript)).mtimeMs;
        if (age < 120_000) return { sessionId: passed, transcript: passedTranscript };
    }
    const newest = await newestTranscript(cwd);
    if (newest) return { sessionId: newest.sessionId, transcript: newest.path };
    if (passedTranscript) return { sessionId: passed, transcript: passedTranscript };
    return { sessionId: passed || `claude-${randomUUID()}`, transcript: null };
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

// A server that was killed leaves its markers, and with them a guard process per session. Removing the
// markers of dead servers ends those guards; a review is reopened on the same port either way.
export async function removeDeadMarkers(directory) {
    let entries;
    try { entries = await readdir(directory, { recursive: true }); } catch { return; }
    for (const name of entries.filter((entry) => entry.endsWith(".json"))) {
        const path = join(directory, name);
        try {
            const marker = JSON.parse(await readFile(path, "utf8"));
            if (!Number.isInteger(marker.providerPid) || !alive(marker.providerPid)) await rm(path, { force: true });
        } catch { /* being written, or not a marker */ }
    }
}

async function pruneSessionState(directory) {
    const cutoff = Date.now() - SESSION_STATE_DAYS * 24 * 60 * 60 * 1000;
    let names;
    try { names = await readdir(directory); } catch { return; }
    for (const name of names) {
        const path = join(directory, name);
        try {
            if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
        } catch { /* in use */ }
    }
}

// The model choice lives in upstream's review state, behind the endpoint its own Settings menu uses, so
// a choice made here shows in that menu. "default" is upstream's "session": the configured models.
async function chooseModel(url, model) {
    const settings = (await (await fetch(new URL("api/state", url))).json()).ai_settings || { model: "session", language: "default" };
    if (!model) return settings.model;
    const response = await fetch(new URL("api/ai-settings", url), { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, model: model === "default" ? "session" : model }) });
    const body = await response.json();
    if (!response.ok) throw new Error(`Could not set the model: ${body.error || response.status}`);
    return body.ai_settings.model;
}

export class ReviewHost {
    constructor({ release, home, cwd }) {
        this.release = release;
        this.home = home;
        this.cwd = cwd;
        this.loading = null;
        this.canvas = null;
        this.instances = new Map();
        this.current = null;
    }

    // Upstream's canvas definition (its action names and schemas), readable without loading the extension.
    async definition() {
        const { directory, ready } = await bundleDirectory(this.release, this.home);
        if (!ready) return null;
        return (await import(pathToFileURL(join(directory, "canvas-definition.mjs")).href)).canvasDefinition;
    }

    start(onProgress) {
        this.loading ||= this.load(onProgress).catch((error) => { this.loading = null; throw error; });
        return this.loading;
    }

    async load(onProgress) {
        const directory = await ensureBundle(this.release, this.home, onProgress);
        process.env.AGENT_REVIEW_STATE_DIR ||= join(this.home, "canvases");
        await removeDeadMarkers(process.env.AGENT_REVIEW_STATE_DIR);
        const { sessionId, transcript } = await resolveSession(this.cwd);
        const sessions = join(this.home, "sessions");
        const workspacePath = join(sessions, sessionId.replace(/[^A-Za-z0-9_.-]/g, "_"));
        await mkdir(workspacePath, { recursive: true });
        pruneSessionState(sessions).catch(() => {});
        log(`session ${sessionId}${transcript ? "" : " (no transcript found; provenance is empty)"}`);
        host().session = {
            sessionId,
            workspacePath,
            getEvents: async () => withDefaultModels(transcript ? await sessionEvents(transcript) : []),
            log: async (message) => log(message),
            rpc: { extensions: { list: async () => ({ extensions: [{ id: EXTENSION_ID, pid: process.pid }] }) } },
        };
        redirectCopilotImports(directory);
        // Upstream's own entry point: joins the session above and registers its canvas.
        await import(pathToFileURL(join(directory, "extension.mjs")).href);
        this.canvas = host().canvases.find((canvas) => canvas.id === "agent-review") || host().canvases[0];
        if (!this.canvas) throw new Error("Upstream registered no canvas; its entry point has changed.");
        return this.canvas;
    }

    get loaded() {
        return Boolean(this.canvas);
    }

    async open({ repoPath, baseRef, model } = {}, onProgress) {
        const canvas = await this.start(onProgress);
        const repository = resolve(repoPath || setting("CLAUDE_PROJECT_DIR") || this.cwd);
        const instanceId = `claude-${createHash("sha1").update(`${repository.toLowerCase()}|${baseRef || ""}`).digest("hex").slice(0, 16)}`;
        const result = await canvas.open({ instanceId, extensionId: EXTENSION_ID,
            input: { repoPath: repository, ...(baseRef ? { baseRef } : {}) } });
        this.instances.set(instanceId, { repository, url: result.url });
        this.current = instanceId;
        return { ...result, repository, models: describeModels(await chooseModel(result.url, model)) };
    }

    async action(name, input) {
        if (!this.canvas || !this.current) throw new Error("No review is open. Call open_review first.");
        const action = this.canvas.actions.find((candidate) => candidate.name === name);
        if (!action) throw new Error(`Unknown review action: ${name}`);
        return action.handler({ instanceId: this.current, extensionId: EXTENSION_ID, input: input ?? {} });
    }

    async close() {
        if (!this.canvas || !this.current) return null;
        const instanceId = this.current;
        const closed = this.instances.get(instanceId);
        await this.canvas.onClose({ instanceId, extensionId: EXTENSION_ID });
        this.instances.delete(instanceId);
        this.current = [...this.instances.keys()].at(-1) || null;
        return closed;
    }

    // Closing each canvas removes its marker, which is what lets upstream's detached ownership guard exit;
    // its SIGTERM handler then disposes the rest. A marker left behind keeps that guard polling for weeks.
    async shutdown() {
        setTimeout(() => process.exit(0), 5_000).unref();
        if (this.canvas) {
            await Promise.allSettled([...this.instances.keys()].map((instanceId) =>
                this.canvas.onClose({ instanceId, extensionId: EXTENSION_ID })));
        }
        if (this.canvas && process.listenerCount("SIGTERM")) process.emit("SIGTERM", "SIGTERM");
        else process.exit(0);
    }
}
