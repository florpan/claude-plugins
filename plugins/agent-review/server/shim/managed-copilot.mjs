// Stands in for upstream's managed-copilot.mjs, which searches the GitHub app's
// cache for copilot.exe and fails without it. Nothing launches the returned path:
// the fake SDK ignores it.
import { claudeExecutable } from "../claude.mjs";

export async function managedCopilotPath() {
    return claudeExecutable();
}
