import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitExecutor, resolveGitBinary } from "../../../src/git/executor";

const onMac = process.platform === "darwin";

describe("the Git program the executor spawns", () => {
    afterEach(() => {
        vi.doUnmock("node:child_process");
        vi.resetModules();
    });

    it("keeps the PATH lookup off macOS", async () => {
        expect(await resolveGitBinary("linux")).toBe("git");
        expect(await resolveGitBinary("win32")).toBe("git");
    });

    it.runIf(onMac)("on macOS skips the xcrun shim for the binary in Git's exec path", async () => {
        const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();

        expect(await resolveGitBinary()).toBe(path.join(execPath, "git"));
    });

    it.runIf(onMac)("on macOS runs that binary even when PATH cannot find git", async () => {
        await resolveGitBinary();
        const result = await new GitExecutor(process.cwd()).runBinary(["--version"], {
            env: { PATH: path.join(tmpdir(), "intelligit-no-such-directory") },
        });

        expect(result.stdout.toString("utf8")).toMatch(/^git version /);
    });

    it("falls back to plain git when the exec path holds no git binary", async () => {
        vi.doMock("node:child_process", () => ({
            execFile: (_file: string, _args: string[], callback: (...args: unknown[]) => void) =>
                callback(null, { stdout: "/nonexistent/git-core\n", stderr: "" }),
            spawn: vi.fn(),
        }));
        const fresh = await import("../../../src/git/executor");

        expect(await fresh.resolveGitBinary("darwin")).toBe("git");
    });

    it("falls back to plain git when Git cannot report its exec path", async () => {
        vi.doMock("node:child_process", () => ({
            execFile: (_file: string, _args: string[], callback: (...args: unknown[]) => void) =>
                callback(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })),
            spawn: vi.fn(),
        }));
        const fresh = await import("../../../src/git/executor");

        expect(await fresh.resolveGitBinary("darwin")).toBe("git");
    });
});
