// Claude Code's session transcripts, replayed as the Copilot session events
// upstream reads for provenance: which prompt asked for which file change.
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDirectory } from "./paths.mjs";

const HEAD_BYTES = 256 * 1024;
const MAX_COMMAND = 2000;
// Argument names upstream's path collector recognizes.
const PATH_ARGUMENTS = ["path", "file", "filePath", "resourceUri"];
const KEPT_ARGUMENTS = ["description", "command", "pattern", "query", "glob", "url", "subagent_type", "skill"];
// Upstream classifies a write by tool name: "edit", "write" or a name ending in "_edit".
const TOOL_NAMES = { MultiEdit: "multi_edit", NotebookEdit: "notebook_edit" };

export function projectsRoot() {
    return join(claudeConfigDirectory(), "projects");
}

export function encodeProjectPath(path) {
    return String(path).replace(/[^A-Za-z0-9]/g, "-");
}

function stripTags(text) {
    return text
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .replace(/<local-command-(stdout|stderr|caveat)>[\s\S]*?<\/local-command-\1>/g, "")
        .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
        .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
        .replace(/<command-name>([\s\S]*?)<\/command-name>/g, "$1 ")
        .replace(/<command-args>([\s\S]*?)<\/command-args>/g, "$1 ")
        .trim();
}

// What a person (or, in a subagent's file, its parent) asked; null for tool results and engine rows.
export function promptText(entry) {
    if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return null;
    const content = entry.message?.content;
    let text;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
        if (content.some((block) => block?.type === "tool_result")) return null;
        text = content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
    } else return null;
    text = stripTags(text);
    if (!text || text.startsWith("[Request interrupted")) return null;
    // A bare built-in command (/clear, /model) asks for no change.
    if (/^\/[\w:-]+$/.test(text)) return null;
    return text;
}

export function toolArguments(input) {
    if (!input || typeof input !== "object") return {};
    const args = {};
    const path = [input.file_path, input.notebook_path, ...PATH_ARGUMENTS.map((key) => input[key])]
        .find((value) => typeof value === "string" && value.trim());
    if (path) args.path = path;
    for (const key of KEPT_ARGUMENTS) {
        // File bodies and patches are left out: upstream scans every string it is given for paths.
        if (typeof input[key] === "string" && input[key]) args[key] = input[key].slice(0, MAX_COMMAND);
    }
    return args;
}

export function entriesToEvents(entries) {
    const events = [];
    let model = null;
    for (const entry of entries) {
        if (!entry || !entry.uuid || !entry.message) continue;
        const base = { timestamp: entry.timestamp, ...(entry.isSidechain || entry.agentId ? { agentId: entry.agentId || "subagent" } : {}) };
        if (entry.type === "user") {
            const content = promptText(entry);
            if (content) events.push({ ...base, id: entry.uuid, type: "user.message", data: { content } });
        } else if (entry.type === "assistant") {
            const used = entry.message.model;
            if (!base.agentId && used && used !== "<synthetic>" && used !== model) {
                events.push({ id: `${entry.uuid}.model`, timestamp: entry.timestamp,
                    type: model ? "session.model_change" : "session.start",
                    data: model ? { previousModel: model, newModel: used } : { selectedModel: used, context: { cwd: entry.cwd } } });
                model = used;
            }
            const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
            blocks.forEach((block, index) => {
                if (block?.type === "text" && block.text?.trim()) {
                    events.push({ ...base, id: `${entry.uuid}.${index}`, type: "assistant.message", data: { content: block.text } });
                } else if (block?.type === "tool_use") {
                    events.push({ ...base, id: `${entry.uuid}.${index}`, type: "tool.execution_start",
                        data: { toolCallId: block.id, toolName: TOOL_NAMES[block.name] || block.name, arguments: toolArguments(block.input) } });
                }
            });
        }
    }
    return events;
}

function parseLines(text) {
    const entries = [];
    for (const line of text.split("\n")) {
        // Most of a transcript is request bookkeeping; only these rows are parsed.
        if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"type":"ai-title"')) continue;
        try {
            const entry = JSON.parse(line);
            if (entry.type === "user" || entry.type === "assistant" || entry.type === "ai-title") entries.push(entry);
        } catch { /* a row still being written */ }
    }
    return entries;
}

const cache = new Map();

async function readEntries(file) {
    const info = await stat(file);
    const key = `${info.mtimeMs}:${info.size}`;
    const cached = cache.get(file);
    if (cached?.key === key) return cached.entries;
    const entries = parseLines(await readFile(file, "utf8"));
    cache.set(file, { key, entries });
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    return entries;
}

// A session's events: its own transcript plus its subagents', in time order.
export async function sessionEvents(transcript) {
    const files = [transcript];
    const subagents = join(transcript.replace(/\.jsonl$/, ""), "subagents");
    try {
        for (const name of await readdir(subagents)) if (name.endsWith(".jsonl")) files.push(join(subagents, name));
    } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    const events = [];
    for (const file of files) {
        try {
            events.push(...entriesToEvents(await readEntries(file)));
        } catch (error) {
            if (file === transcript) throw error;
        }
    }
    // Stable: rows of one file keep their order when timestamps tie.
    return events.map((event, index) => ({ event, index }))
        .sort((a, b) => String(a.event.timestamp).localeCompare(String(b.event.timestamp)) || a.index - b.index)
        .map((item) => item.event);
}

async function projectDirectories() {
    try {
        return (await readdir(projectsRoot(), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
}

async function transcriptsIn(directory) {
    const found = [];
    let names;
    try { names = await readdir(directory); } catch { return found; }
    for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(directory, name);
        try {
            const info = await stat(path);
            found.push({ path, sessionId: name.slice(0, -".jsonl".length), modified: info.mtimeMs });
        } catch { /* removed meanwhile */ }
    }
    return found;
}

export async function findTranscript(sessionId) {
    if (!/^[A-Za-z0-9-]{8,}$/.test(String(sessionId || ""))) return null;
    for (const directory of await projectDirectories()) {
        const path = join(projectsRoot(), directory, `${sessionId}.jsonl`);
        try {
            await stat(path);
            return path;
        } catch { /* another project */ }
    }
    return null;
}

// The transcript being written right now for a session started in `cwd`: the calling session, as its
// tool call was just recorded. Used when Claude Code does not pass the session id to this server.
export async function newestTranscript(cwd) {
    const wanted = encodeProjectPath(cwd).toLowerCase();
    const directory = (await projectDirectories()).find((name) => name.toLowerCase() === wanted);
    if (!directory) return null;
    const newest = (await transcriptsIn(join(projectsRoot(), directory))).sort((a, b) => b.modified - a.modified)[0];
    return newest ? { path: newest.path, sessionId: newest.sessionId } : null;
}

async function head(file) {
    const handle = await open(file, "r");
    try {
        const buffer = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
        await handle.close();
    }
}

async function metadata(item) {
    const entries = parseLines(await head(item.path));
    const first = entries.find((entry) => entry.cwd);
    if (!first) return null;
    const title = entries.findLast((entry) => entry.type === "ai-title")?.aiTitle;
    const prompt = entries.filter((entry) => entry.type === "user").map(promptText).find(Boolean);
    return {
        sessionId: item.sessionId,
        modifiedTime: new Date(item.modified).toISOString(),
        summary: String(title || prompt || "").replace(/\s+/g, " ").slice(0, 200),
        context: { workingDirectory: first.cwd, branch: first.gitBranch || null },
        transcript: item.path,
    };
}

// Sessions started in or under any of the given directories (a repository and its worktrees), newest first.
export async function listSessions(roots, { limit = 60 } = {}) {
    const prefixes = roots.map((root) => encodeProjectPath(root).toLowerCase());
    const candidates = [];
    for (const directory of await projectDirectories()) {
        const name = directory.toLowerCase();
        if (!prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}-`))) continue;
        candidates.push(...await transcriptsIn(join(projectsRoot(), directory)));
    }
    const sessions = [];
    for (const item of candidates.sort((a, b) => b.modified - a.modified).slice(0, limit)) {
        try {
            const found = await metadata(item);
            if (found) sessions.push(found);
        } catch { /* unreadable transcript */ }
    }
    return sessions;
}
