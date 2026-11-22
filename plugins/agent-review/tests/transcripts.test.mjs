import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const root = await mkdtemp(join(tmpdir(), "agent-review-transcripts-"));
process.env.CLAUDE_CONFIG_DIR = root;
const { encodeProjectPath, entriesToEvents, findTranscript, listSessions, newestTranscript, promptText, sessionEvents, toolArguments }
    = await import("../server/transcripts.mjs");

const REPO = "C:\\Dev\\sample-repo";
const user = (uuid, content, extra = {}) => ({ type: "user", uuid, timestamp: `2026-01-01T00:00:${uuid.padStart(2, "0")}.000Z`,
    cwd: REPO, sessionId: "session-0001", message: { role: "user", content }, ...extra });
const assistant = (uuid, blocks, extra = {}) => ({ type: "assistant", uuid, timestamp: `2026-01-01T00:00:${uuid.padStart(2, "0")}.000Z`,
    cwd: REPO, sessionId: "session-0001", message: { role: "assistant", model: "claude-test-1", content: blocks }, ...extra });
const lines = (entries) => entries.map((entry) => JSON.stringify(entry)).join("\n");

const session = [
    { type: "mode", mode: "normal", sessionId: "session-0001" },
    user("1", "Make titles optional in the resolver"),
    assistant("2", [{ type: "thinking", thinking: "hidden" }]),
    assistant("3", [{ type: "text", text: "I'll change resolver.js." }]),
    assistant("4", [{ type: "tool_use", id: "t1", name: "Edit",
        input: { file_path: `${REPO}\\src\\resolver.cs`, old_string: "--- a/other/file.js", new_string: "x" } }]),
    user("5", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
    { type: "ai-title", aiTitle: "Optional titles", sessionId: "session-0001" },
    user("6", "<system-reminder>ignore</system-reminder>"),
    user("7", "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
    user("8", "Now add a test", { isMeta: false }),
    assistant("9", [{ type: "tool_use", id: "t2", name: "MultiEdit", input: { file_path: `${REPO}\\test\\resolver.test.cs`, edits: [] } }]),
];

before(async () => {
    const project = join(root, "projects", encodeProjectPath(REPO));
    await mkdir(join(project, "session-0001", "subagents"), { recursive: true });
    await writeFile(join(project, "session-0001.jsonl"), lines(session));
    await writeFile(join(project, "session-0001", "subagents", "agent-a1.jsonl"), lines([
        assistant("45", [{ type: "tool_use", id: "t3", name: "Write", input: { file_path: `${REPO}\\docs\\notes.md`, content: "body" } }],
            { isSidechain: true, agentId: "a1", timestamp: "2026-01-01T00:00:04.500Z" }),
    ]));
    const other = join(root, "projects", encodeProjectPath("C:\\Dev\\sample-repo-two"));
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "session-0002.jsonl"), lines([user("1", "unrelated", { cwd: "C:\\Dev\\sample-repo-two", sessionId: "session-0002" })]));
});
after(() => rm(root, { recursive: true, force: true }));

test("a prompt is what a person typed, not what the engine added", () => {
    assert.equal(promptText(session[1]), "Make titles optional in the resolver");
    assert.equal(promptText(session[5]), null, "tool results are not prompts");
    assert.equal(promptText(session[7]), null, "a system reminder alone is not a prompt");
    assert.equal(promptText(session[8]), null, "a bare built-in command is not a prompt");
    assert.equal(promptText(user("x", "plan it", { isMeta: true })), null);
    assert.equal(promptText(user("x", "<command-name>/tdd</command-name><command-args>add retry</command-args>")), "/tdd add retry");
});

test("tool arguments carry the path under a name upstream reads, and no file bodies", () => {
    assert.deepEqual(toolArguments({ file_path: "a.cs", old_string: "*** Add File: b.js", new_string: "y" }), { path: "a.cs" });
    assert.deepEqual(toolArguments({ command: "npm test", description: "Run tests", timeout: 5 }), { command: "npm test", description: "Run tests" });
});

test("entries become Copilot-shaped events with unique ids", () => {
    const events = entriesToEvents(session);
    assert.deepEqual(events.map((event) => event.type), ["user.message", "session.start", "assistant.message",
        "tool.execution_start", "user.message", "tool.execution_start"]);
    assert.equal(events[1].data.selectedModel, "claude-test-1");
    assert.equal(events[5].data.toolName, "multi_edit");
    assert.equal(new Set(events.map((event) => event.id)).size, events.length);
});

test("upstream attributes an edit to the prompt that asked for it", async () => {
    const directory = process.env.AGENT_REVIEW_BUNDLE_DIR;
    if (!directory) return test.skip("set AGENT_REVIEW_BUNDLE_DIR to an unpacked upstream bundle");
    const { pathToFileURL } = await import("node:url");
    const upstream = await import(pathToFileURL(join(directory, "session-context.mjs")).href);
    const context = upstream.buildSessionContext(await sessionEvents(await findTranscript("session-0001")), REPO);
    assert.equal(context.turns.length, 2);
    const [attribution] = upstream.findSessionAttribution(context, "src/resolver.cs");
    assert.equal(attribution.prompt, "Make titles optional in the resolver");
    assert.equal(attribution.confidence, "likely");
    assert.equal(upstream.findSessionAttribution(context, "other/file.js").length, 0, "edit bodies must not leak paths");
    const [second] = upstream.findSessionAttribution(context, "test/resolver.test.cs");
    assert.equal(second.prompt, "Now add a test");
    const [subagent] = upstream.findSessionAttribution(context, "docs/notes.md");
    assert.equal(subagent.prompt, "Make titles optional in the resolver", "a subagent's write belongs to the turn it ran in");
});

test("sessions are found by id, by project and by repository", async () => {
    assert.ok((await findTranscript("session-0001")).endsWith("session-0001.jsonl"));
    assert.equal(await findTranscript("../session-0001"), null);
    assert.equal((await newestTranscript(REPO)).sessionId, "session-0001");
    assert.equal(await newestTranscript("C:\\Dev\\nowhere"), null);
    const sessions = await listSessions([REPO]);
    assert.deepEqual(sessions.map((item) => item.sessionId).sort(), ["session-0001", "session-0002"], "a sibling folder is listed; upstream filters by path");
    const first = sessions.find((item) => item.sessionId === "session-0001");
    assert.equal(first.summary, "Optional titles");
    assert.equal(first.context.workingDirectory, REPO);
});
