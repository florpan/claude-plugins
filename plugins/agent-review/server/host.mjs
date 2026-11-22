// What the fake Copilot SDK and this server share: the session upstream joins and the canvases it registers.
const KEY = Symbol.for("agent-review-claude.host");

export function host() {
    globalThis[KEY] ||= { session: null, canvases: [] };
    return globalThis[KEY];
}
