import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
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
    },
    l10n: {
        t: (message: string, args?: Record<string, unknown>) =>
            Object.entries(args ?? {}).reduce(
                (s, [key, value]) => s.replace(`{${key}}`, String(value)),
                message,
            ),
    },
}));
vi.mock("../../../src/services/diffService", () => ({}));
vi.mock("../../../src/utils/notifications", () => ({
    showTimedInformationMessage: vi.fn(),
    showTimedWarningMessage: vi.fn(),
}));
import { mergeFileFromContext } from "../../../src/commands/fileContextCommands";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const callbacks = {
    refresh: vi.fn(async () => undefined),
    refreshConflicts: vi.fn(async () => undefined),
    openConflictSession: vi.fn(async () => undefined),
};

/** Runs Git against one isolated fixture using the suite's isolated Git configuration. */
async function git(repo: string, args: string[]): Promise<string> {
    return (await execFileAsync("git", args, { cwd: repo })).stdout;
}

/** Creates an attached main branch and a source branch one commit ahead. */
async function repository(): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), "intelligit-native-merge-"));
    directories.push(repo);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "test@example.invalid"]);
    await writeFile(path.join(repo, "selected.txt"), "BASE\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    await git(repo, ["checkout", "-b", "feature"]);
    await writeFile(path.join(repo, "incoming.txt"), "INCOMING\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "incoming"]);
    await git(repo, ["checkout", "main"]);
    return repo;
}

beforeEach(() => {
    vi.clearAllMocks();
});
afterEach(async () => {
    await Promise.all(directories.splice(0).map((dir) => removeScratchDirectories(dir)));
});

describe("native Merge with real Git", () => {
    it("merges clicked B while active A changes to C, preserving A HEAD and index", async () => {
        const [a, b, c] = await Promise.all([repository(), repository(), repository()]);
        await writeFile(path.join(a, "staged.txt"), "A STAGED\n");
        await git(a, ["add", "staged.txt"]);
        const aHead = await git(a, ["rev-parse", "HEAD"]);
        const aIndex = await git(a, ["ls-files", "--stage", "-z"]);
        const cHead = await git(c, ["rev-parse", "HEAD"]);
        const executor = new GitExecutor(a);
        mocks.picker.mockImplementationOnce(async (items) => {
            executor.setRoot(c);
            return items.find((item) => item.label === "feature");
        });
        await mergeFileFromContext(
            new mocks.Uri(path.join(b, "selected.txt")),
            new GitOps(executor),
            callbacks,
        );
        expect(await git(b, ["rev-parse", "HEAD"]), "B receives the incoming history").toBe(
            await git(b, ["rev-parse", "feature"]),
        );
        expect(await readFile(path.join(b, "incoming.txt"), "utf8")).toBe("INCOMING\n");
        expect(await git(a, ["rev-parse", "HEAD"])).toBe(aHead);
        expect(await git(a, ["ls-files", "--stage", "-z"])).toBe(aIndex);
        expect(await git(c, ["rev-parse", "HEAD"])).toBe(cHead);
        expect(mocks.error).not.toHaveBeenCalled();
    });
    it.each(["name", "oid"])("rejects a real dialog-time %s change", async (change) => {
        const repo = await repository();
        mocks.confirm.mockImplementationOnce(async (_m, _o, action) => {
            await git(
                repo,
                change === "name"
                    ? ["checkout", "-b", "other"]
                    : ["commit", "--allow-empty", "-m", "intervening"],
            );
            return action;
        });
        await mergeFileFromContext(
            new mocks.Uri(path.join(repo, "selected.txt")),
            new GitOps(new GitExecutor(repo)),
            callbacks,
        );
        expect(mocks.error).toHaveBeenCalledWith(
            "The current branch or HEAD changed. Start Merge again.",
        );
        expect(await git(repo, ["ls-files", "incoming.txt"])).toBe("");
    });
    it("permits a merge into unchanged detached HEAD", async () => {
        const repo = await repository();
        await git(repo, ["checkout", "--detach", "main"]);
        await mergeFileFromContext(
            new mocks.Uri(path.join(repo, "selected.txt")),
            new GitOps(new GitExecutor(repo)),
            callbacks,
        );
        expect(await git(repo, ["rev-parse", "HEAD"])).toBe(
            await git(repo, ["rev-parse", "feature"]),
        );
        expect(mocks.error).not.toHaveBeenCalled();
    });
    it("reads an unborn target without treating its missing commit as failure", async () => {
        const repo = await repository();
        await git(repo, ["checkout", "--orphan", "newborn"]);
        expect(await new GitOps(new GitExecutor(repo)).getMergeTarget()).toEqual({
            head: "newborn",
            oid: "(initial)",
        });
    });
    it("keeps derived Merge behind an existing mutation on the activation gate", async () => {
        const repo = await repository();
        const gate = new RepositoryMutationGate(
            new RepositoryMutationCoordinator(),
            new RepositoryLock(),
        );
        const commonDir = path.join(repo, ".git");
        let release!: () => void;
        let held!: () => void;
        const holding = new Promise<void>((resolve) => {
            held = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        const first = gate.run(repo, commonDir, async () => {
            held();
            await barrier;
        });
        await holding;
        const before = await git(repo, ["rev-parse", "HEAD"]);
        const spy = vi.spyOn(gate, "run");
        const queued = new GitOps(new GitExecutor(repo, gate)).deriveFor(repo).merge("feature");
        try {
            await vi.waitFor(() =>
                expect(
                    spy,
                    "derived Merge reaches the shared mutation gate",
                ).toHaveBeenCalledOnce(),
            );
            expect(
                await git(repo, ["rev-parse", "HEAD"]),
                "queued Merge cannot execute before release",
            ).toBe(before);
        } finally {
            release();
            await first;
        }
        await queued;
        expect(await git(repo, ["rev-parse", "HEAD"])).toBe(
            await git(repo, ["rev-parse", "feature"]),
        );
    });
    it("rejects option-like branches before the executor can mutate", async () => {
        const run = vi.fn();
        const ops = new GitOps({ run } as unknown as GitExecutor);
        await expect(ops.merge("--abort")).rejects.toThrow();
        expect(run).not.toHaveBeenCalled();
    });
    it("fails closed for unreadable or malformed target identity", async () => {
        const run = vi.fn(async () => "# branch.head main\n");
        await expect(
            new GitOps({ run } as unknown as GitExecutor).getMergeTarget(),
        ).rejects.toThrow("Unable to determine the current branch and HEAD.");
        run.mockRejectedValueOnce(new Error("unreadable repository"));
        await expect(
            new GitOps({ run } as unknown as GitExecutor).getMergeTarget(),
        ).rejects.toThrow("unreadable repository");
    });
});
