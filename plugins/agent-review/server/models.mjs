// Which model answers which request. Copilot has a router (Fusion) that picks per request; here the
// default is one model for explanations and one for the review passes that look for defects, and a
// model chosen in the page or with open_review answers everything.
import { setting } from "./paths.mjs";

const DEFAULT_PREFIX = "agent-review:";
// The second line of upstream's review-pass prompt (review-pipeline.mjs, buildReviewPrompt).
const REVIEW_PASS = "Analyze the saved review evidence.";

export function configuredModels() {
    return { explain: setting("AGENT_REVIEW_MODEL") || "sonnet", review: setting("AGENT_REVIEW_REVIEW_MODEL") || "opus" };
}

export function sessionModel(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const model = events[index].data?.newModel || events[index].data?.selectedModel;
        if (model) return model;
    }
    return null;
}

// Upstream's default choice is "the session's model", read off the session's last model event. The
// event added here answers with an id that carries both configured models; "session" in a setting
// stands for the model the session really runs. Upstream also keys saved review passes on this id.
export function withDefaultModels(events, { explain, review } = configuredModels()) {
    const real = sessionModel(events) || "";
    const resolve = (model) => (model === "session" ? real : model);
    return [...events, { id: "agent-review-models", type: "session.model_change", timestamp: new Date().toISOString(),
        data: { newModel: `${DEFAULT_PREFIX}${resolve(explain)}|${resolve(review)}` } }];
}

export function isReviewPass(prompt) {
    return String(prompt).slice(0, 400).includes(REVIEW_PASS);
}

// The model for one request, or undefined for the CLI's own default.
export function modelFor(requested, prompt) {
    if (!requested?.startsWith(DEFAULT_PREFIX)) return requested || undefined;
    const [explain, review] = requested.slice(DEFAULT_PREFIX.length).split("|");
    return (isReviewPass(prompt) ? review : explain) || undefined;
}

export function describeModels(choice) {
    if (choice && choice !== "session" && choice !== "fusion") return { all_requests: choice };
    const { explain, review } = configuredModels();
    return { explanations: explain, review_passes: review };
}
