import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPackageSmokeHostLogs } from "../../e2e/hostFixtures/packageSmokeLogs";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

let profile: string;
beforeEach(async () => {
    profile = await mkdtemp(path.join(os.tmpdir(), "intelligit-smoke-log-"));
});
afterEach(async () => {
    await removeScratchDirectories(profile);
});

async function writeLog(relative: string, content: string): Promise<void> {
    const target = path.join(profile, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
}

describe("installed package smoke diagnostics", () => {
    it("allows failures before a host log exists", async () => {
        expect(await readPackageSmokeHostLogs(profile)).toEqual([]);
    });

    it("captures nested hosts and startup logs without reading unrelated profile data", async () => {
        await writeLog("logs/session/window1/exthost/exthost.log", "git add failed: index.lock");
        await writeLog("logs/session/window2/exthost/exthost.log", "another host");
        await writeLog("logs/session/window1/renderer.log", "startup renderer");
        await writeLog("logs/session/main.log", "startup main");
        await writeLog("logs/session/sharedprocess.log", "startup shared process");
        await writeLog("logs/session/unrelated.log", "not an allowed startup log");
        await writeLog("User/settings.json", "unrelated settings");
        const logs = await readPackageSmokeHostLogs(profile);
        expect(logs.map(({ name, body }) => ({ name, text: body.toString() }))).toEqual([
            { name: "session-main.log", text: "startup main" },
            { name: "session-sharedprocess.log", text: "startup shared process" },
            { name: "session-window1-exthost-exthost.log", text: "git add failed: index.lock" },
            { name: "session-window1-renderer.log", text: "startup renderer" },
            { name: "session-window2-exthost-exthost.log", text: "another host" },
        ]);
    });

    it("bounds the number and combined bytes of collected logs", async () => {
        for (let index = 0; index < 20; index++)
            await writeLog(
                `logs/session-${String(index).padStart(2, "0")}/exthost.log`,
                "x".repeat(256 * 1024),
            );
        const logs = await readPackageSmokeHostLogs(profile);
        expect(logs.length).toBeLessThanOrEqual(12);
        expect(logs.reduce((sum, log) => sum + log.body.length, 0)).toBeLessThanOrEqual(
            1024 * 1024,
        );
        expect(logs.some((log) => log.name.startsWith("session-19-"))).toBe(true);
    });

    it("does not open a directory that happens to have an allowed log name", async () => {
        await mkdir(path.join(profile, "logs/session/main.log"), { recursive: true });
        expect(await readPackageSmokeHostLogs(profile)).toEqual([]);
    });

    it("bounds large logs while retaining the latest Git failure", async () => {
        const tail = "git add failed: index.lock";
        await writeLog("logs/session/exthost.log", "x".repeat(300 * 1024) + tail);
        const [log] = await readPackageSmokeHostLogs(profile);
        expect(log.body.length).toBe(256 * 1024);
        expect(log.body.toString().endsWith(tail)).toBe(true);
    });
});
