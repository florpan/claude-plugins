// One upstream "isolated explanation session" = one headless Claude Code call:
// no tools, no customizations, nothing written to the transcript folder.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log, setting } from "./paths.mjs";

const SYSTEM_PROMPT = "You are the explanation engine inside Agent Review, a tool a developer uses to review code changes. "
    + "Everything you may rely on is in the request: saved source, diffs and analyzer evidence. You have no tools and cannot look anything up. "
    + "Follow the requested structure, headings, identifiers and citation format exactly, and return only the requested content. "
    // Upstream re-measures a JSON answer after adding a path and side to every citation, so an answer
    // near the stated limit is rejected as too large; and a long answer outlasts its two-minute budget.
    + "A stated character limit is a hard ceiling that the tool measures after adding metadata to your answer: "
    + "stay under half of it, keep the points that matter most, and cite at most three lines per claim.";

// Session plumbing of the Claude Code that started this server; a child must not inherit it.
const PARENT_ONLY = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_BRIDGE_SESSION_ID"];
// Windows caps a command line at 32,767 characters; a larger schema travels in the prompt instead.
const MAX_SCHEMA_ARGUMENT = 16_000;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function claudeExecutable() {
    return setting("AGENT_REVIEW_CLAUDE") || setting("CLAUDE_CODE_EXECPATH") || "claude";
}

export function effortLevel() {
    const level = setting("AGENT_REVIEW_EFFORT");
    // Low: an explanation is reading what is on the page, and upstream gives each request two minutes.
    return EFFORTS.includes(level) ? level : "low";
}

function concurrency() {
    const value = Number(setting("AGENT_REVIEW_CONCURRENCY"));
    return Number.isInteger(value) && value > 0 ? Math.min(value, 8) : 3;
}

let running = 0;
const waiting = [];

// Upstream prefetches explanations freely; each one here is a process and a model call.
async function slot(signal) {
    if (running >= concurrency()) {
        await new Promise((resolve, reject) => {
            const entry = { resolve, reject: null };
            const abort = () => {
                waiting.splice(waiting.indexOf(entry), 1);
                reject(signal.reason ?? new Error("Aborted."));
            };
            entry.resolve = () => { signal?.removeEventListener("abort", abort); resolve(); };
            signal?.addEventListener("abort", abort, { once: true });
            waiting.push(entry);
        });
    }
    running += 1;
    return () => {
        running -= 1;
        waiting.shift()?.resolve();
    };
}

export function buildArguments({ model, schema, effort = effortLevel() }) {
    const args = ["-p", "--safe-mode", "--tools", "", "--no-session-persistence", "--output-format", "json",
        "--system-prompt", SYSTEM_PROMPT, "--effort", effort];
    if (model) args.push("--model", model);
    if (schema) args.push("--json-schema", schema);
    return args;
}

function withSchemaInPrompt(prompt, schema) {
    return `${prompt}\n\nReturn only one JSON value that validates against this JSON Schema, with no prose and no code fence:\n${schema}`;
}

function jsonFromText(text) {
    const trimmed = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    JSON.parse(trimmed);
    return trimmed;
}

export function parseResult(stdout, { schema, schemaInPrompt }) {
    let result;
    for (const line of String(stdout).split(/\r?\n/).reverse()) {
        if (!line.trim().startsWith("{")) continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed.type === "result") { result = parsed; break; }
        } catch { /* not the result line */ }
    }
    if (!result) throw new Error(`Claude returned no result: ${String(stdout).trim().slice(0, 300) || "empty output"}`);
    if (result.is_error) throw new Error(`Claude request failed: ${String(result.result || result.subtype || "unknown error").slice(0, 500)}`);
    if (schema && !schemaInPrompt) {
        return result.structured_output === undefined || result.structured_output === null
            ? jsonFromText(result.result) : JSON.stringify(result.structured_output);
    }
    return schemaInPrompt ? jsonFromText(result.result) : String(result.result ?? "");
}

let calls = 0;

// AGENT_REVIEW_DEBUG_DIR keeps every request and answer, for reading what upstream asked and what came back.
async function record(number, name, text) {
    const directory = setting("AGENT_REVIEW_DEBUG_DIR");
    if (!directory) return;
    try {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${String(number).padStart(4, "0")}-${name}`), text);
    } catch (error) {
        log("debug record failed:", error.message);
    }
}

export async function askClaude({ prompt, responseSchema, model, timeoutMs = 120_000, signal, cwd, run = spawn }) {
    signal?.throwIfAborted();
    const number = ++calls;
    const queued = Date.now();
    const release = await slot(signal);
    const started = Date.now();
    const describe = (outcome) => log(`call ${number} ${model || "default model"} ${effortLevel()}`
        + ` ${responseSchema ? "schema" : "text"} ${prompt.length} chars in, ${outcome},`
        + ` ${((Date.now() - started) / 1000).toFixed(1)}s (+${((started - queued) / 1000).toFixed(1)}s queued)`);
    try {
        signal?.throwIfAborted();
        await record(number, "request.txt", `${responseSchema ? `${JSON.stringify(responseSchema)}\n\n` : ""}${prompt}`);
        const schema = responseSchema ? JSON.stringify(responseSchema) : null;
        const schemaInPrompt = Boolean(schema) && schema.length > MAX_SCHEMA_ARGUMENT;
        const env = { ...process.env };
        for (const name of PARENT_ONLY) delete env[name];
        const stdout = await new Promise((resolve, reject) => {
            const child = run(claudeExecutable(), buildArguments({ model, schema: schemaInPrompt ? null : schema }),
                { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
            let out = "", err = "", settled = false;
            const finish = (action, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                action(value);
            };
            // Settle before killing: the kill's own "close" must not be the reported outcome.
            const abort = () => { finish(reject, signal.reason ?? new Error("Aborted.")); child.kill(); };
            const timer = setTimeout(() => {
                finish(reject, new Error(`Claude did not answer within ${Math.round(timeoutMs / 1000)} seconds.`));
                child.kill();
            }, timeoutMs);
            signal?.addEventListener("abort", abort, { once: true });
            child.stdout.on("data", (chunk) => { out += chunk; });
            child.stderr.on("data", (chunk) => { err += chunk; });
            child.on("error", (error) => finish(reject, error.code === "ENOENT"
                ? new Error(`Claude Code CLI not found (${claudeExecutable()}). Set AGENT_REVIEW_CLAUDE to its executable.`, { cause: error })
                : error));
            child.on("close", (code) => {
                if (out.trim()) finish(resolve, out);
                else finish(reject, new Error(`Claude exited with code ${code}: ${err.trim().slice(0, 500) || "no output"}`));
            });
            child.stdin.on("error", () => {});
            child.stdin.end(schemaInPrompt ? withSchemaInPrompt(prompt, schema) : prompt);
        });
        const content = parseResult(stdout, { schema, schemaInPrompt });
        describe(`${content.length} chars out`);
        await record(number, "response.txt", content);
        return content;
    } catch (error) {
        describe(`failed: ${error?.message || error}`);
        throw error;
    } finally {
        release();
    }
}
