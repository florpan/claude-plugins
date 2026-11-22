// Stands in for "@github/copilot-sdk/extension": the part of the Copilot SDK an
// extension uses to join its host session and register canvases.
import { host } from "../host.mjs";

export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "CanvasError";
        this.code = code;
    }
}

export function createCanvas(definition) {
    return definition;
}

export async function joinSession({ canvases = [] } = {}) {
    const shared = host();
    if (!shared.session) throw new Error("Agent Review was loaded before its Claude session was resolved.");
    shared.canvases = canvases;
    return shared.session;
}
