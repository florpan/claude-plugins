// Fetches upstream Agent Review exactly as its own Copilot bootstrap does: the
// release archive pinned in upstream.json, verified by size and SHA-256, then
// unpacked once into a directory named after the hash.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { setting } from "./paths.mjs";

const execute = promisify(execFile);
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const REQUIRED = ["extension.mjs", "review-extension.mjs", "canvas-definition.mjs", "server.mjs",
    "analyzer/analyze.py", "web/index.html", "node_modules/typescript/lib/typescript.js"];

export function validateRelease(release) {
    if (!release || !/^[a-f0-9]{40}$/.test(release.source_commit) || !/^[a-f0-9]{64}$/.test(release.sha256)
        || !Number.isSafeInteger(release.bytes) || release.bytes < 1 || release.bytes > MAX_ARCHIVE_BYTES) {
        throw new Error("upstream.json is not a valid pinned release.");
    }
    const url = new URL(release.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("The pinned release must be an https URL.");
    return release;
}

function pythonCandidates() {
    const configured = setting("AGENT_REVIEW_PYTHON");
    if (configured) return [[configured, []]];
    return process.platform === "win32"
        ? [["py", ["-3"]], ["python", []], ["python3", []]]
        : [["python3", []], ["python", []]];
}

// Python is an upstream requirement anyway, and Node has no zip reader.
const EXTRACT = `
import pathlib, shutil, stat, sys, zipfile
root = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if len(entries) > 5000 or sum(item.file_size for item in entries) > 512 * 1024 * 1024:
        raise ValueError("Bundle exceeds extraction limits")
    for item in entries:
        name = item.filename.rstrip("/")
        parts = name.split("/")
        if (not name or "\\\\" in name or ":" in name or any(part in ("", ".", "..") for part in parts)
                or stat.S_ISLNK(item.external_attr >> 16)):
            raise ValueError("Unsafe archive entry: " + item.filename)
    for item in entries:
        target = root.joinpath(*item.filename.rstrip("/").split("/"))
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as source, target.open("xb") as destination:
                shutil.copyfileobj(source, destination)
`;

async function extract(archive, directory) {
    for (const [command, prefix] of pythonCandidates()) {
        try {
            await execute(command, [...prefix, "-I", "-B", "-c", EXTRACT, archive, directory],
                { timeout: 120_000, windowsHide: true });
            return;
        } catch (error) {
            if (error.code !== "ENOENT") throw new Error(`Unpacking the bundle failed: ${error.stderr || error.message}`, { cause: error });
        }
    }
    throw new Error("Agent Review needs Python 3.11+ on PATH (or AGENT_REVIEW_PYTHON).");
}

async function complete(directory) {
    try {
        for (const path of REQUIRED) await access(join(directory, ...path.split("/")));
        return true;
    } catch {
        return false;
    }
}

export async function bundleDirectory(release, home) {
    // A checkout of upstream's .github/extensions/agent-review (after npm ci) for working on upstream itself.
    const override = setting("AGENT_REVIEW_BUNDLE_DIR");
    if (override) return { directory: override, ready: await complete(override), override: true };
    const directory = join(home, "runtime", release.sha256);
    let marked = false;
    try {
        marked = JSON.parse(await readFile(join(directory, ".complete.json"), "utf8")).sha256 === release.sha256;
    } catch { /* not prepared yet */ }
    return { directory, ready: marked && await complete(directory), override: false };
}

let preparing = null;

export function ensureBundle(release, home, onProgress = () => {}) {
    preparing ||= prepare(validateRelease(release), home, onProgress).catch((error) => { preparing = null; throw error; });
    return preparing;
}

async function prepare(release, home, onProgress) {
    const { directory, ready, override } = await bundleDirectory(release, home);
    if (ready) return directory;
    if (override) throw new Error(`AGENT_REVIEW_BUNDLE_DIR is not a prepared Agent Review extension directory: ${directory}`);
    const cacheRoot = join(home, "runtime");
    await mkdir(cacheRoot, { recursive: true });
    const scratch = await mkdtemp(join(cacheRoot, "prepare-"));
    try {
        onProgress(`Downloading Agent Review ${release.source_commit.slice(0, 7)} (${Math.round(release.bytes / 1e6)} MB)`);
        const response = await fetch(release.url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
        if (!response.ok) throw new Error(`Bundle download failed: HTTP ${response.status}`);
        const data = Buffer.from(await response.arrayBuffer());
        if (data.length !== release.bytes) throw new Error(`Bundle size mismatch: got ${data.length}, pinned ${release.bytes}.`);
        const digest = createHash("sha256").update(data).digest("hex");
        if (digest !== release.sha256) throw new Error(`Bundle hash mismatch: got ${digest}, pinned ${release.sha256}.`);
        const archive = join(scratch, "agent-review.zip");
        await writeFile(archive, data);
        onProgress("Unpacking the verified bundle");
        const unpacked = join(scratch, "bundle");
        await mkdir(unpacked);
        await extract(archive, unpacked);
        if (!await complete(unpacked)) throw new Error("The bundle is missing files this host needs; upstream's layout has changed.");
        await writeFile(join(unpacked, ".complete.json"), JSON.stringify({ sha256: release.sha256, source_commit: release.source_commit }));
        await rm(directory, { recursive: true, force: true });
        try {
            await rename(unpacked, directory);
        } catch (error) {
            // Another session finished the same preparation first.
            if (!(await bundleDirectory(release, home)).ready) throw error;
        }
        return directory;
    } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
}
