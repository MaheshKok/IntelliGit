import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rebaseFileFromContext } from "../../../src/commands/fileContextCommands";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const mocks = vi.hoisted(() => {
    class Uri {
        readonly scheme = "file";
        constructor(readonly fsPath: string) {}
    }
    return {
        Uri,
        picker: vi.fn(async (items: Array<{ label: string }>) =>
            items.find((item) => item.label === "feature"),
        ),
        confirm: vi.fn(async (_message: string, _options: unknown, action: string) => action),
        error: vi.fn(),
    };
});
vi.mock("vscode", () => ({
    Uri: mocks.Uri,
    window: {
        showQuickPick: mocks.picker,
        showWarningMessage: mocks.confirm,
        showErrorMessage: mocks.error,
        showInformationMessage: vi.fn(),
    },
    l10n: {
        t: (message: string, args?: Record<string, unknown>) =>
            Object.entries(args ?? {}).reduce(
                (text, [key, value]) => text.replace(`{${key}}`, String(value)),
                message,
            ),
    },
}));
vi.mock("../../../src/services/diffService", () => ({}));
vi.mock("../../../src/utils/notifications", () => ({
    showTimedInformationMessage: vi.fn(),
    showTimedWarningMessage: vi.fn(),
}));

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const callbacks = {
    refresh: vi.fn(async (_root: string) => undefined),
    refreshConflicts: vi.fn(async (_root: string) => undefined),
    openConflictSession: vi.fn(async (_ops: GitOps, _root: string, _labels: unknown) => undefined),
};

/** Runs Git inside one test repository with its local identity configured by the fixture. */
async function git(repo: string, args: string[]): Promise<string> {
    return (await execFileAsync("git", args, { cwd: repo })).stdout;
}

/** Creates diverged main and feature branches, optionally conflicting on the selected file. */
async function repository(conflict = false): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), "intelligit-native-rebase-"));
    directories.push(repo);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await writeFile(path.join(repo, "selected.txt"), "BASE\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    await git(repo, ["checkout", "-b", "feature"]);
    await writeFile(path.join(repo, conflict ? "selected.txt" : "feature.txt"), "FEATURE\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "feature"]);
    await git(repo, ["checkout", "main"]);
    await writeFile(path.join(repo, conflict ? "selected.txt" : "main.txt"), "MAIN\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "main"]);
    return repo;
}

beforeEach(() => {
    vi.clearAllMocks();
});
afterEach(async () => {
    await Promise.all(directories.splice(0).map((dir) => removeScratchDirectories(dir)));
});

describe("native Rebase with real Git", () => {
    it("rewrites clicked B onto feature while active A switches to C", async () => {
        const [a, b, c] = await Promise.all([repository(), repository(), repository()]);
        const executor = new GitExecutor(a);
        const aHead = await git(a, ["rev-parse", "HEAD"]);
        const cHead = await git(c, ["rev-parse", "HEAD"]);
        const bBefore = await git(b, ["rev-parse", "HEAD"]);
        mocks.picker.mockImplementationOnce(async (items) => {
            executor.setRoot(c);
            return items.find((item) => item.label === "feature");
        });
        await rebaseFileFromContext(
            new mocks.Uri(path.join(b, "selected.txt")),
            new GitOps(executor),
            callbacks,
        );
        expect(await git(b, ["rev-parse", "HEAD"]), "B history is rewritten").not.toBe(bBefore);
        expect((await git(b, ["merge-base", "feature", "main"])).trim()).toBe(
            (await git(b, ["rev-parse", "feature"])).trim(),
        );
        expect(await readFile(path.join(b, "feature.txt"), "utf8")).toBe("FEATURE\n");
        expect(await readFile(path.join(b, "main.txt"), "utf8")).toBe("MAIN\n");
        expect(await git(a, ["rev-parse", "HEAD"])).toBe(aHead);
        expect(await git(c, ["rev-parse", "HEAD"])).toBe(cHead);
        expect(mocks.error).not.toHaveBeenCalled();
    });
    it("refuses a dirty B instead of silently stashing or resetting it", async () => {
        const b = await repository();
        const before = await git(b, ["rev-parse", "HEAD"]);
        await writeFile(path.join(b, "selected.txt"), "DIRTY\n");
        await rebaseFileFromContext(
            new mocks.Uri(path.join(b, "selected.txt")),
            new GitOps(new GitExecutor(b)),
            callbacks,
        );
        expect(await git(b, ["rev-parse", "HEAD"])).toBe(before);
        expect(await readFile(path.join(b, "selected.txt"), "utf8")).toBe("DIRTY\n");
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("Rebase failed:"));
    });
    it("keeps B conflict and abort on B when the active executor switches to C", async () => {
        const [a, b, c] = await Promise.all([repository(), repository(true), repository()]);
        const executor = new GitExecutor(a);
        const aHead = await git(a, ["rev-parse", "HEAD"]);
        const cHead = await git(c, ["rev-parse", "HEAD"]);
        mocks.picker.mockImplementationOnce(async (items) => {
            executor.setRoot(c);
            return items.find((item) => item.label === "feature");
        });
        await rebaseFileFromContext(
            new mocks.Uri(path.join(b, "selected.txt")),
            new GitOps(executor),
            callbacks,
        );
        expect(callbacks.openConflictSession).toHaveBeenCalledWith(
            expect.any(GitOps),
            await realpath(b),
            { sourceBranch: "main", targetBranch: "feature" },
        );
        expect((await git(b, ["status", "--porcelain"])).trim()).toContain("UU selected.txt");
        const scopedOps = callbacks.openConflictSession.mock.calls.at(-1)?.[0];
        expect(scopedOps).toBeInstanceOf(GitOps);
        await scopedOps!.abortMerge();
        expect(await git(b, ["status", "--porcelain"])).toBe("");
        expect(await git(a, ["rev-parse", "HEAD"])).toBe(aHead);
        expect(await git(c, ["rev-parse", "HEAD"])).toBe(cHead);
    });
});
