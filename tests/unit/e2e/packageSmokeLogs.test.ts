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

    it("captures nested extension hosts without reading unrelated profile data", async () => {
        await writeLog("logs/session/window1/exthost/exthost.log", "git add failed: index.lock");
        await writeLog("logs/session/window2/exthost/exthost.log", "another host");
        await writeLog("logs/session/window1/renderer.log", "unrelated renderer");
        await writeLog("User/settings.json", "unrelated settings");
        const logs = await readPackageSmokeHostLogs(profile);
        expect(logs.map(({ name, body }) => ({ name, text: body.toString() }))).toEqual([
            { name: "session-window1-exthost-exthost.log", text: "git add failed: index.lock" },
            { name: "session-window2-exthost-exthost.log", text: "another host" },
        ]);
    });

    it("bounds large logs while retaining the latest Git failure", async () => {
        const tail = "git add failed: index.lock";
        await writeLog("logs/session/exthost.log", "x".repeat(300 * 1024) + tail);
        const [log] = await readPackageSmokeHostLogs(profile);
        expect(log.body.length).toBe(256 * 1024);
        expect(log.body.toString().endsWith(tail)).toBe(true);
    });
});
