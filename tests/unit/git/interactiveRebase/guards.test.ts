import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateInteractiveRebaseGuards } from "../../../../src/git/interactiveRebase/guards";
import type { GitExecutor } from "../../../../src/git/executor";

const execFileAsync = promisify(execFile);
const HASH = "a".repeat(40);
const PARENT = "b".repeat(40);
const OTHER = "c".repeat(40);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

function allowedResponses(): Record<string, string | Error> {
    return {
        "bisect log": new Error("not bisecting"),
        "symbolic-ref --quiet HEAD": "refs/heads/main\n",
        [`rev-list --parents -n 1 --end-of-options ${HASH}`]: `${HASH} ${PARENT}\n`,
        [`merge-base --is-ancestor --end-of-options ${HASH} HEAD`]: "",
        "status --porcelain=v1 -z -uall": "",
        [`rev-list --parents --end-of-options ${HASH}^..HEAD`]: `${HASH} ${PARENT}\n`,
    };
}

function executorFor(overrides: Record<string, string | Error> = {}): GitExecutor {
    const responses = { ...allowedResponses(), ...overrides };
    return {
        run: vi.fn(async (args: string[]) => {
            const response = responses[args.join(" ")];
            if (response instanceof Error) throw response;
            if (response !== undefined) return response;
            throw new Error(`Unexpected Git command: ${args.join(" ")}`);
        }),
    } as unknown as GitExecutor;
}

async function evaluate(
    executor: GitExecutor = executorFor(),
    wholeIndexOperationInProgress = false,
    selectedHash = HASH,
) {
    return evaluateInteractiveRebaseGuards({
        executor,
        selectedHash,
        hasWholeIndexOperationInProgress: async () => wholeIndexOperationInProgress,
    });
}

describe("evaluateInteractiveRebaseGuards", () => {
    it("accepts an eligible linear range", async () => {
        await expect(evaluate()).resolves.toEqual({ status: "ok" });
    });

    it.each([
        ["an option-shaped hash", "--output=/tmp/intelligit-should-not-exist"],
        ["a leading dash", "-HEAD"],
        ["an abbreviated hash", "abc1234"],
        ["an uppercase object ID", "A".repeat(40)],
        ["a revision expression", "HEAD~1"],
        ["an empty string", ""],
    ] as const)("rejects %s before spawning Git", async (_name, selectedHash) => {
        const executor = executorFor();

        await expect(evaluate(executor, false, selectedHash)).resolves.toEqual({
            status: "rejected",
            reason: "invalid-selected-hash",
        });
        expect(executor.run).not.toHaveBeenCalled();
    });

    it.each([
        ["detached HEAD", { "symbolic-ref --quiet HEAD": new Error("detached") }, "detached-head"],
        [
            "a selected merge commit",
            {
                [`rev-list --parents -n 1 --end-of-options ${HASH}`]:
                    `${HASH} ${PARENT} ${OTHER}\n`,
            },
            "selected-merge-commit",
        ],
        [
            "the initial commit",
            { [`rev-list --parents -n 1 --end-of-options ${HASH}`]: `${HASH}\n` },
            "initial-commit",
        ],
        [
            "a commit outside HEAD history",
            {
                [`merge-base --is-ancestor --end-of-options ${HASH} HEAD`]: new Error(
                    "not ancestor",
                ),
            },
            "commit-not-ancestor",
        ],
        [
            "a dirty working tree",
            { "status --porcelain=v1 -z -uall": " M tracked.txt\0" },
            "working-tree-dirty",
        ],
        [
            "a merge within the selected range",
            {
                [`rev-list --parents --end-of-options ${HASH}^..HEAD`]:
                    `${HASH} ${PARENT}\n${OTHER} ${PARENT} ${HASH}\n`,
            },
            "range-contains-merge-commit",
        ],
        ["an active bisect session", { "bisect log": "git bisect start\n" }, "operation-in-progress"],
    ] as const)("rejects %s", async (_name, overrides, reason) => {
        await expect(evaluate(executorFor(overrides))).resolves.toEqual({
            status: "rejected",
            reason,
        });
    });

    it("rejects a whole-index operation reported by the repository detector", async () => {
        await expect(evaluate(executorFor(), true)).resolves.toEqual({
            status: "rejected",
            reason: "operation-in-progress",
        });
    });

    it("reports a pending operation ahead of the detached HEAD it produces", async () => {
        const executor = executorFor({
            "bisect log": "git bisect start\n",
            "symbolic-ref --quiet HEAD": new Error("detached"),
        });

        await expect(evaluate(executor)).resolves.toEqual({
            status: "rejected",
            reason: "operation-in-progress",
        });
    });

    it("fails closed when a required Git guard probe fails", async () => {
        await expect(
            evaluate(executorFor({ "status --porcelain=v1 -z -uall": new Error("status failed") })),
        ).resolves.toEqual({ status: "rejected", reason: "git-error" });
    });
});

describe("evaluateInteractiveRebaseGuards against a real repository", () => {
    it("accepts a clean linear range", async () => {
        const repo = await createRepository();
        await commit(repo, "initial");
        const selected = await commit(repo, "second");
        await commit(repo, "third");

        await expect(evaluateIn(repo, selected)).resolves.toEqual({ status: "ok" });
    });

    it("rejects an active bisect session ahead of the detached HEAD it produces", async () => {
        const repo = await createRepository();
        const first = await commit(repo, "initial");
        const selected = await commit(repo, "second");
        await commit(repo, "third");
        await commit(repo, "fourth");
        const last = await commit(repo, "fifth");
        await git(repo, ["bisect", "start", last, first]);

        await expect(git(repo, ["symbolic-ref", "--quiet", "HEAD"])).rejects.toThrow();
        await expect(evaluateIn(repo, selected)).resolves.toEqual({
            status: "rejected",
            reason: "operation-in-progress",
        });
    });

    it("rejects a detached HEAD", async () => {
        const repo = await createRepository();
        await commit(repo, "initial");
        const selected = await commit(repo, "second");
        await commit(repo, "third");
        await git(repo, ["checkout", "--detach"]);

        await expect(evaluateIn(repo, selected)).resolves.toEqual({
            status: "rejected",
            reason: "detached-head",
        });
    });

    it("rejects the initial commit", async () => {
        const repo = await createRepository();
        const selected = await commit(repo, "initial");
        await commit(repo, "second");

        await expect(evaluateIn(repo, selected)).resolves.toEqual({
            status: "rejected",
            reason: "initial-commit",
        });
    });

    it.each([
        ["untracked-only dirt", false],
        ["staged-only dirt", true],
    ] as const)("rejects %s", async (_name, staged) => {
        const repo = await createRepository();
        await commit(repo, "initial");
        const selected = await commit(repo, "second");
        await writeFile(path.join(repo, "scratch.txt"), "dirt\n", "utf8");
        if (staged) await git(repo, ["add", "scratch.txt"]);

        await expect(evaluateIn(repo, selected)).resolves.toEqual({
            status: "rejected",
            reason: "working-tree-dirty",
        });
    });

    it("rejects a merge commit inside the selected range", async () => {
        const repo = await createRepository();
        await commit(repo, "initial");
        const selected = await commit(repo, "second");
        const trunk = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        await git(repo, ["checkout", "-q", "-b", "side"]);
        await commit(repo, "side");
        await git(repo, ["checkout", "-q", trunk]);
        await commit(repo, "third");
        await git(repo, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);

        await expect(evaluateIn(repo, selected)).resolves.toEqual({
            status: "rejected",
            reason: "range-contains-merge-commit",
        });
    });

    it("rejects a selected merge commit ahead of the range it would also fail", async () => {
        const repo = await createRepository();
        await commit(repo, "initial");
        const trunk = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        await git(repo, ["checkout", "-q", "-b", "side"]);
        await commit(repo, "side");
        await git(repo, ["checkout", "-q", trunk]);
        await commit(repo, "second");
        await git(repo, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
        const selected = (await git(repo, ["rev-parse", "HEAD"])).trim();
        await commit(repo, "third");

        // This range contains a merge too, so both rejections apply. The selected-commit check
        // runs first on purpose: it names the commit the user actually clicked, which is the
        // actionable half of the message.
        await expect(evaluateIn(repo, selected)).resolves.toEqual({
            status: "rejected",
            reason: "selected-merge-commit",
        });
    });

    it("rejects a commit that is not an ancestor of HEAD", async () => {
        const repo = await createRepository();
        await commit(repo, "initial");
        const trunk = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        await git(repo, ["checkout", "-q", "-b", "side"]);
        const selected = await commit(repo, "side");
        await git(repo, ["checkout", "-q", trunk]);
        await commit(repo, "second");

        await expect(evaluateIn(repo, selected)).resolves.toEqual({
            status: "rejected",
            reason: "commit-not-ancestor",
        });
    });
});

async function evaluateIn(repo: string, selectedHash: string) {
    const { GitExecutor: Executor } = await import("../../../../src/git/executor");
    return evaluateInteractiveRebaseGuards({
        executor: new Executor(repo),
        selectedHash,
        // Real-repository coverage deliberately pins the shared detector to false so every
        // rejection below is produced by this module's own probes.
        hasWholeIndexOperationInProgress: async () => false,
    });
}

async function createRepository(): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), "intelligit-rebase-guards-"));
    directories.push(repo);
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Test User"]);
    return repo;
}

async function git(repo: string, args: string[]): Promise<string> {
    return (await execFileAsync("git", args, { cwd: repo })).stdout;
}

async function commit(repo: string, subject: string): Promise<string> {
    await git(repo, ["commit", "-q", "--allow-empty", "-m", subject]);
    return (await git(repo, ["rev-parse", "HEAD"])).trim();
}
