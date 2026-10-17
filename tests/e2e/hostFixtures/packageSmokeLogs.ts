import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

const MAX_HOST_LOG_BYTES = 256 * 1024;
const MAX_LOG_FILES = 12;
const MAX_TOTAL_LOG_BYTES = 1024 * 1024;
const STARTUP_LOG_NAMES = new Set(["exthost.log", "main.log", "renderer.log", "sharedprocess.log"]);

/** Captures bounded startup and extension-host tails only from the smoke's disposable profile. */
export async function readPackageSmokeHostLogs(
    userDataDir: string,
): Promise<{ name: string; body: Buffer }[]> {
    const logsRoot = path.join(userDataDir, "logs");
    const entries = await readdir(logsRoot, { recursive: true }).catch((error: unknown) => {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
        )
            return [];
        throw error;
    });
    const logs = [];
    let remaining = MAX_TOTAL_LOG_BYTES;
    const candidates = entries
        .filter((entry) => STARTUP_LOG_NAMES.has(path.basename(entry)))
        .sort()
        .reverse()
        .slice(0, MAX_LOG_FILES);
    for (const entry of candidates) {
        if (!remaining) break;
        const target = path.join(logsRoot, entry);
        const details = await lstat(target);
        if (!details.isFile() || details.isSymbolicLink()) continue;
        const file = await open(target, "r");
        try {
            const { size } = await file.stat();
            const body = Buffer.alloc(Math.min(size, MAX_HOST_LOG_BYTES, remaining));
            const { bytesRead } = await file.read(
                body,
                0,
                body.length,
                Math.max(0, size - body.length),
            );
            logs.push({ name: entry.split(path.sep).join("-"), body: body.subarray(0, bytesRead) });
            remaining -= bytesRead;
        } finally {
            await file.close();
        }
    }
    return logs.sort((left, right) => left.name.localeCompare(right.name));
}
