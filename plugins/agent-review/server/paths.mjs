import { homedir } from "node:os";
import { join } from "node:path";

// A plugin setting Claude Code did not substitute arrives as the literal "${...}".
export function setting(name) {
    const value = process.env[name];
    return value && !value.includes("${") ? value : null;
}

export function claudeConfigDirectory() {
    return setting("CLAUDE_CONFIG_DIR") || join(homedir(), ".claude");
}

// Where the upstream bundle, canvas markers and per-session review state live.
export function homeDirectory() {
    return setting("AGENT_REVIEW_HOME") || join(claudeConfigDirectory(), "agent-review");
}

export function log(...parts) {
    console.error("[agent-review-claude]", ...parts);
}
