import { open, readdir } from "node:fs/promises";
import path from "node:path";

const MAX_HOST_LOG_BYTES = 256 * 1024;

/** Captures only bounded extension-host log tails from the smoke's disposable profile. */
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
    for (const entry of entries.sort()) {
        if (path.basename(entry) !== "exthost.log") continue;
        const file = await open(path.join(logsRoot, entry), "r");
        try {
            const { size } = await file.stat();
            const body = Buffer.alloc(Math.min(size, MAX_HOST_LOG_BYTES));
            const { bytesRead } = await file.read(
                body,
                0,
                body.length,
                Math.max(0, size - body.length),
            );
            logs.push({ name: entry.split(path.sep).join("-"), body: body.subarray(0, bytesRead) });
        } finally {
            await file.close();
        }
    }
    return logs;
}
