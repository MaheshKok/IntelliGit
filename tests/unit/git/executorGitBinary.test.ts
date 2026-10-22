import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitExecutor, resolveGitBinary } from "../../../src/git/executor";

// The shim is only skipped when it is the first git on PATH (Homebrew or a wrapper is kept).
const shimFirst =
    process.platform === "darwin" &&
    realpathSync(execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()) ===
        "/usr/bin/git";

describe("the Git program the executor spawns", () => {
    afterEach(() => {
        vi.doUnmock("node:child_process");
        vi.resetModules();
    });

    it("keeps the PATH lookup off macOS", async () => {
        expect(await resolveGitBinary("linux")).toBe("git");
        expect(await resolveGitBinary("win32")).toBe("git");
    });

    it.runIf(shimFirst)(
        "on macOS skips the xcrun shim for the binary in Git's exec path",
        async () => {
            const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();

            expect(await resolveGitBinary()).toBe(path.join(execPath, "git"));
        },
    );

    it.runIf(shimFirst)("on macOS runs that binary even when PATH cannot find git", async () => {
        await resolveGitBinary();
        const result = await new GitExecutor(process.cwd()).runBinary(["--version"], {
            env: { PATH: path.join(tmpdir(), "intelligit-no-such-directory") },
        });

        expect(result.stdout.toString("utf8")).toMatch(/^git version /);
    });

    it("keeps a git wrapper that comes first on PATH", async () => {
        const wrapperDir = mkdtempSync(path.join(tmpdir(), "intelligit-git-wrapper-"));
        const wrapper = path.join(wrapperDir, "git");
        writeFileSync(wrapper, '#!/bin/sh\nexec /usr/bin/git "$@"\n');
        chmodSync(wrapper, 0o755);
        const fresh = await import("../../../src/git/executor");

        expect(
            await fresh.resolveGitBinary("darwin", `${wrapperDir}${path.delimiter}/usr/bin`),
        ).toBe("git");
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
