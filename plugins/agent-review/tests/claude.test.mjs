import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { askClaude, buildArguments, parseResult } from "../server/claude.mjs";

const result = (fields) => JSON.stringify({ type: "result", is_error: false, ...fields });

// A stand-in for the CLI process: records what it was given and answers once stdin closes.
function fakeClaude(answer, seen = {}) {
    return (executable, args, options) => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => { seen.killed = true; child.emit("close", null); };
        Object.assign(seen, { executable, args, env: options.env });
        let input = "";
        child.stdin.on("data", (chunk) => { input += chunk; });
        child.stdin.on("end", () => {
            seen.input = input;
            if (answer === null) return; // never answers
            child.stdout.write(answer);
            setImmediate(() => child.emit("close", 0));
        });
        return child;
    };
}

test("a call is tool-less, unpersisted and free of the user's customizations", () => {
    const args = buildArguments({ model: "haiku", schema: '{"type":"object"}', effort: "low" });
    assert.deepEqual(args.slice(0, 4), ["-p", "--safe-mode", "--tools", ""]);
    assert.ok(args.includes("--no-session-persistence"));
    assert.deepEqual(args.slice(-4), ["--model", "haiku", "--json-schema", '{"type":"object"}']);
    assert.ok(!buildArguments({}).includes("--model"));
});

test("text and structured answers are returned as upstream expects: a string", () => {
    assert.equal(parseResult(result({ result: "## Heading\n\nBody" }), {}), "## Heading\n\nBody");
    assert.equal(parseResult(result({ result: "ignored", structured_output: { a: 1 } }), { schema: "{}" }), '{"a":1}');
    assert.equal(parseResult(`noise\n${result({ result: '```json\n{"a":2}\n```' })}\n`, { schema: "{}", schemaInPrompt: true }), '{"a":2}');
    assert.throws(() => parseResult(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }), {}), /Not logged in/);
    assert.throws(() => parseResult("", {}), /no result/);
});

test("the prompt goes in on stdin and the parent session's plumbing stays out of the child", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "parent";
    const seen = {};
    const content = await askClaude({ prompt: "explain", model: "sonnet", run: fakeClaude(result({ result: "done" }), seen) });
    assert.equal(content, "done");
    assert.equal(seen.input, "explain");
    assert.equal(seen.env.CLAUDE_CODE_SESSION_ID, undefined);
    delete process.env.CLAUDE_CODE_SESSION_ID;
});

test("a schema too large for a command line travels in the prompt", async () => {
    const seen = {};
    const responseSchema = { type: "object", properties: { id: { type: "string", enum: Array.from({ length: 2000 }, (_, i) => `evidence-${i}`) } } };
    const content = await askClaude({ prompt: "review", responseSchema, run: fakeClaude(result({ result: '{"id":"evidence-1"}' }), seen) });
    assert.equal(content, '{"id":"evidence-1"}');
    assert.ok(!seen.args.includes("--json-schema"));
    assert.ok(seen.input.includes("evidence-1999"));
});

test("a request that is cancelled or too slow ends its process", async () => {
    const slow = {};
    await assert.rejects(askClaude({ prompt: "x", timeoutMs: 20, run: fakeClaude(null, slow) }), /did not answer/);
    assert.equal(slow.killed, true);
    const cancelled = {};
    const controller = new AbortController();
    const pending = askClaude({ prompt: "x", signal: controller.signal, run: fakeClaude(null, cancelled) });
    setTimeout(() => controller.abort(new Error("cancelled")), 10);
    await assert.rejects(pending, /cancelled/);
    assert.equal(cancelled.killed, true);
});

test("no more than the configured number of calls run at once", async () => {
    process.env.AGENT_REVIEW_CONCURRENCY = "2";
    let active = 0, peak = 0;
    const run = (...args) => {
        active += 1;
        peak = Math.max(peak, active);
        const child = fakeClaude(result({ result: "ok" }))(...args);
        child.on("close", () => { active -= 1; });
        return child;
    };
    await Promise.all(Array.from({ length: 6 }, () => askClaude({ prompt: "x", run })));
    assert.equal(peak, 2);
    delete process.env.AGENT_REVIEW_CONCURRENCY;
});
