import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInteractiveRebaseSubmission } from "../../../../src/git/interactiveRebase/run";
import { getRebaseStoragePaths } from "../../../../src/git/interactiveRebase/storage";
import type { InteractiveRebaseRunDependencies } from "../../../../src/git/interactiveRebase/run";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const REBASED = "c".repeat(40);
const BRANCH = "refs/heads/main";
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

/** Creates a filesystem-backed runner fixture with an observable mutation gate. */
async function fixture(
    options: {
        exitCode?: number;
        branch?: string;
        head?: string;
        unmerged?: string;
        createRebaseDirectory?: boolean;
        throwOnRebase?: boolean;
        /** Makes the in-gate guard re-check see a working tree dirtied after submission. */
        dirty?: boolean;
        /** Leaves a live rebase behind before the spawn throws. */
        rebaseDirectoryBeforeThrow?: boolean;
        /** Name of a rebase state directory that already exists before the run starts. */
        existingRebaseDirectory?: "rebase-merge" | "rebase-apply";
        /** Rebase state directory that appears while this submission waits in the mutation queue. */
        rebaseDirectoryInGate?: "rebase-merge" | "rebase-apply";
        /** Makes the live-rebase probe fail with a non-ENOENT error once the spawn is under way. */
        unreadableRebaseDirectoryBeforeThrow?: boolean;
        /** Git command whose output is reported as hitting the byte ceiling. */
        truncateProbe?: string;
    } = {},
) {
    const root = await mkdtemp(path.join(os.tmpdir(), "intelligit-rebase-run-"));
    directories.push(root);
    const gitDir = path.join(root, ".git");
    const storageRoot = path.join(root, "storage");
    const helperScriptPath = path.join(root, "helper.cjs");
    await Promise.all([mkdir(gitDir), writeFile(helperScriptPath, "// fixture\n")]);
    if (options.existingRebaseDirectory) {
        await mkdir(path.join(gitDir, options.existingRebaseDirectory));
    }
    let inGate = false;
    let manifestAtSpawn: string | undefined;
    const calls: string[][] = [];
    const executor = {
        runBinary: vi.fn(async (args: string[], runOptions?: { expectedExitCodes?: number[] }) => {
            calls.push(args);
            const command = args.join(" ");
            if (!inGate) throw new Error(`Git command escaped mutation gate: ${args.join(" ")}`);
            if (command === "symbolic-ref --quiet HEAD") return binary(options.branch ?? BRANCH);
            if (command === "rev-parse HEAD")
                return binary(
                    calls.filter((call) => call.join(" ") === command).length > 1
                        ? REBASED
                        : (options.head ?? HEAD),
                );
            if (command === options.truncateProbe) return binary("", "", 0, true);
            if (command === "ls-files -u") return binary(options.unmerged ?? "");
            if (command === `rebase -i ${BASE}`) {
                // The manifest must already record the running lifecycle by the time Git is
                // spawned; captured here because a completed run deletes it before assertions.
                manifestAtSpawn = await readFile(
                    getRebaseStoragePaths(storageRoot, "/fixture-repository").manifestPath(
                        "session-1",
                    ),
                    "utf8",
                );
                if (options.throwOnRebase) {
                    if (options.rebaseDirectoryBeforeThrow) {
                        await mkdir(path.join(gitDir, "rebase-merge"));
                    }
                    if (options.unreadableRebaseDirectoryBeforeThrow) {
                        // A self-referential symlink makes `stat` fail with ELOOP rather than
                        // ENOENT, so the cleanup probe cannot answer whether a rebase is live.
                        const loop = path.join(gitDir, "rebase-merge");
                        await symlink(loop, loop);
                    }
                    throw new Error("spawn failed");
                }
                if (options.createRebaseDirectory) await mkdir(path.join(gitDir, "rebase-merge"));
                const exitCode = options.exitCode ?? 0;
                // The real executor rejects any code outside `expectedExitCodes`; a mock that
                // returned every code regardless would hide which codes the caller accepts.
                if (!(runOptions?.expectedExitCodes ?? [0]).includes(exitCode)) {
                    throw new Error(`Git exited with ${exitCode}`);
                }
                return binary("", "helper-stop", exitCode);
            }
            throw new Error(`Unexpected Git command: ${command}`);
        }),
    };
    // The in-gate guard re-check runs through the text executor, so the fixture answers the
    // same probes `evaluateInteractiveRebaseGuards` makes against a clean single-parent range.
    const run = vi.fn(async (args: string[]) => {
        if (!inGate) throw new Error(`Guard probe escaped mutation gate: ${args.join(" ")}`);
        const command = args.join(" ");
        if (command === "bisect log") throw new Error("not bisecting");
        if (command === "symbolic-ref --quiet HEAD") return options.branch ?? BRANCH;
        if (command === `rev-list --parents -n 1 --end-of-options ${BASE}`)
            return `${BASE} ${"e".repeat(40)}\n`;
        if (command === `merge-base --is-ancestor --end-of-options ${BASE} HEAD`) return "";
        if (command === "status --porcelain=v1 -z -uall") return options.dirty ? " M file\0" : "";
        if (command === `rev-list --parents --end-of-options ${BASE}^..HEAD`)
            return `${HEAD} ${BASE}\n`;
        throw new Error(`Unexpected Git text command: ${command}`);
    });
    const gate = {
        run: vi.fn(async (_root: string, _commonDir: string, operation: () => Promise<unknown>) => {
            // A mutation that ran while this submission queued can start a rebase of its own,
            // which only a check inside the critical section can still see.
            if (options.rebaseDirectoryInGate) {
                await mkdir(path.join(gitDir, options.rebaseDirectoryInGate));
            }
            inGate = true;
            try {
                return await operation();
            } finally {
                inGate = false;
            }
        }),
    };
    const dependencies: InteractiveRebaseRunDependencies = {
        executor: { ...executor, run } as never,
        mutationGate: gate as never,
        storageRoot,
        gitDir,
        commonDir: gitDir,
        helperScriptPath,
        hasWholeIndexOperationInProgress: async () => false,
        createSessionId: () => "session-1",
        now: () => new Date("2026-08-02T00:00:00.000Z"),
    };
    return {
        root,
        gitDir,
        storageRoot,
        calls,
        executor,
        run,
        gate,
        dependencies,
        manifestAtSpawn: () => manifestAtSpawn,
    };
}

/** Produces the executor's binary result shape from test text. */
function binary(stdout: string, stderr = "", exitCode = 0, truncated = false) {
    return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode, truncated };
}

function input(
    hasPushedCommit = false,
    pushTarget: { remoteName: string; remoteHeadRef: string; upstreamOid: string } | undefined = undefined,
) {
    return {
        request: {
            requestId: "request-1",
            originProvider: {},
            repoRoot: "/fixture-repository",
            baseHash: BASE,
            rangeHashes: [BASE],
            hasPushedCommit,
            expectedHead: HEAD,
            expectedBranch: BRANCH,
            ...(pushTarget ? { pushTarget } : {}),
        },
        entries: [{ hash: HEAD, action: "reword" as const, message: "subject\n\nbody" }],
    };
}

async function expectMissing(target: string): Promise<void> {
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("runInteractiveRebaseSubmission", () => {
    it("spawns interactive rebase inside the gate with both helper editor commands and removes a done session", async () => {
        const test = await fixture();

        await expect(runInteractiveRebaseSubmission(test.dependencies, input())).resolves.toEqual({
            status: "completed",
            rebasedHeadOid: REBASED,
        });

        expect(test.gate.run).toHaveBeenCalledOnce();
        const rebaseCall = test.executor.runBinary.mock.calls.find(
            ([args]) => args[0] === "rebase",
        );
        expect(rebaseCall?.[0]).toEqual(["rebase", "-i", BASE]);
        expect(rebaseCall?.[1]).toMatchObject({
            env: {
                GIT_SEQUENCE_EDITOR: expect.stringContaining("'sequence' '"),
                GIT_EDITOR: expect.stringContaining("'message' '"),
            },
        });
        const paths = getRebaseStoragePaths(test.storageRoot, "/fixture-repository");
        await expectMissing(paths.sessionDirectory("session-1"));
        await expectMissing(paths.manifestPath("session-1"));
        await expectMissing(paths.reservationPath);
    });

    it("does not retain an offer when the submission had no upstream", async () => {
        const test = await fixture();

        await expect(runInteractiveRebaseSubmission(test.dependencies, input(true))).resolves.toEqual({
            status: "completed",
            rebasedHeadOid: REBASED,
        });

        const paths = getRebaseStoragePaths(test.storageRoot, "/fixture-repository");
        await expectMissing(paths.manifestPath("session-1"));
    });

    it("does not offer a push when the submitted range was entirely unpushed", async () => {
        const test = await fixture();

        await expect(
            runInteractiveRebaseSubmission(
                test.dependencies,
                input(false, { remoteName: "origin", remoteHeadRef: "refs/heads/main", upstreamOid: BASE }),
            ),
        ).resolves.toEqual({
            status: "completed",
            rebasedHeadOid: REBASED,
        });
    });

    it("retains only the completed push offer after rewriting pushed history", async () => {
        const test = await fixture();

        await expect(
            runInteractiveRebaseSubmission(
                test.dependencies,
                input(true, { remoteName: "origin", remoteHeadRef: "refs/heads/main", upstreamOid: BASE }),
            ),
        ).resolves.toMatchObject({
            status: "completed-pending-push",
            manifest: {
                lifecycle: "completed-pending-push",
                rebasedHeadOid: REBASED,
                pushTarget: { remoteName: "origin", remoteHeadRef: "refs/heads/main", upstreamOid: BASE },
            },
        });

        const paths = getRebaseStoragePaths(test.storageRoot, "/fixture-repository");
        await Promise.all([
            expectMissing(paths.sessionDirectory("session-1")),
            expectMissing(paths.reservationPath),
            expect(access(paths.manifestPath("session-1"))).resolves.toBeUndefined(),
        ]);
    });

    it.each([
        ["branch changed", { branch: "refs/heads/other" }, "branch-moved"],
        ["HEAD moved", { head: "d".repeat(40) }, "head-moved"],
    ] as const)("rejects in-gate when %s without spawning", async (_name, options, reason) => {
        const test = await fixture(options);

        await expect(runInteractiveRebaseSubmission(test.dependencies, input())).resolves.toEqual({
            status: "failed",
            reason,
        });

        expect(test.executor.runBinary).not.toHaveBeenCalledWith(
            ["rebase", "-i", BASE],
            expect.anything(),
        );
        await expectMissing(
            getRebaseStoragePaths(test.storageRoot, "/fixture-repository").reservationPath,
        );
    });

    it.each([
        [
            "conflict",
            { exitCode: 1, createRebaseDirectory: true, unmerged: "100644 hash 1\tfile\n" },
            "paused-conflict",
        ],
        ["helper stop", { exitCode: 1, createRebaseDirectory: true }, "paused-helper-stop"],
        ["terminal failure", { exitCode: 1 }, "failed"],
    ] as const)("classifies %s", async (_name, options, status) => {
        const test = await fixture(options);
        const result = await runInteractiveRebaseSubmission(test.dependencies, input());

        expect(result.status).toBe(status);
        const paths = getRebaseStoragePaths(test.storageRoot, "/fixture-repository");
        if (status.startsWith("paused")) {
            await expect(access(paths.reservationPath)).resolves.toBeUndefined();
        } else {
            await expectMissing(paths.reservationPath);
            await expectMissing(paths.sessionDirectory("session-1"));
            await expectMissing(paths.manifestPath("session-1"));
        }
    });

    it.each(["rebase-merge", "rebase-apply"] as const)(
        "refuses to spawn when Git already has %s",
        async (directory) => {
            // Both directories mean a live rebase: `rebase-merge` for interactive and
            // `rebase-apply` for the am-based path. Spawning over either destroys that state.
            const test = await fixture({ existingRebaseDirectory: directory });

            await expect(
                runInteractiveRebaseSubmission(test.dependencies, input()),
            ).resolves.toEqual({ status: "failed", reason: "rebase-in-progress" });

            expect(test.executor.runBinary).not.toHaveBeenCalledWith(
                ["rebase", "-i", BASE],
                expect.anything(),
            );
            await expectMissing(
                getRebaseStoragePaths(test.storageRoot, "/fixture-repository").reservationPath,
            );
        },
    );

    it.each(["rebase-merge", "rebase-apply"] as const)(
        "refuses to spawn when %s appears after the reservation is taken",
        async (directory) => {
            // Acquisition already rejects a rebase that exists up front, so this is the case the
            // in-gate check alone covers: the rebase started while this submission was queued.
            const test = await fixture({ rebaseDirectoryInGate: directory });

            await expect(
                runInteractiveRebaseSubmission(test.dependencies, input()),
            ).resolves.toEqual({ status: "failed", reason: "rebase-in-progress" });

            expect(test.executor.runBinary).not.toHaveBeenCalledWith(
                ["rebase", "-i", BASE],
                expect.anything(),
            );
            await expectMissing(
                getRebaseStoragePaths(test.storageRoot, "/fixture-repository").reservationPath,
            );
        },
    );

    it("keeps the session when the live-rebase probe cannot answer", async () => {
        // An unreadable probe is not evidence that nothing is running, so it must not license
        // deleting the session — the same fail-closed reading `exists` applies to a non-ENOENT
        // error rather than reporting the path absent.
        const test = await fixture({
            throwOnRebase: true,
            unreadableRebaseDirectoryBeforeThrow: true,
        });

        await expect(
            runInteractiveRebaseSubmission(test.dependencies, input()),
        ).resolves.toMatchObject({ status: "failed", reason: "unexpected-error" });

        const paths = getRebaseStoragePaths(test.storageRoot, "/fixture-repository");
        await expect(access(paths.reservationPath)).resolves.toBeUndefined();
        await expect(access(paths.sessionDirectory("session-1"))).resolves.toBeUndefined();
    });

    it("bounds every probe and refuses a truncated one", async () => {
        // A truncated `ls-files -u` trimmed into a string would read as an empty conflict list
        // and misreport a real conflict as a clean helper stop.
        const test = await fixture({
            exitCode: 1,
            createRebaseDirectory: true,
            truncateProbe: "ls-files -u",
        });

        await expect(
            runInteractiveRebaseSubmission(test.dependencies, input()),
        ).resolves.toMatchObject({ status: "failed", reason: "unexpected-error" });

        expect(test.executor.runBinary).toHaveBeenCalledWith(["ls-files", "-u"], {
            maxOutputBytes: expect.any(Number),
        });
    });

    it("records the running lifecycle before Git is spawned", async () => {
        const test = await fixture();

        await expect(runInteractiveRebaseSubmission(test.dependencies, input())).resolves.toEqual({
            status: "completed",
            rebasedHeadOid: REBASED,
        });

        expect(JSON.parse(test.manifestAtSpawn() ?? "{}")).toMatchObject({
            lifecycle: "running",
            sessionId: "session-1",
            baseHash: BASE,
        });
    });

    it("treats an exit code outside the rebase contract as an error, not a clean failure", async () => {
        // Only 0 and 1 are rebase outcomes; a Git fatal must not be classified as though Git
        // had reported a normal unresumable stop.
        const test = await fixture({ exitCode: 128 });

        await expect(
            runInteractiveRebaseSubmission(test.dependencies, input()),
        ).resolves.toMatchObject({ status: "failed", reason: "unexpected-error" });

        const rebaseCall = test.executor.runBinary.mock.calls.find(
            ([args]) => args[0] === "rebase",
        );
        expect(rebaseCall?.[1]).toMatchObject({ expectedExitCodes: [0, 1] });
    });

    it("re-runs every guard inside the gate, not just the two revisions", async () => {
        // Submission already passed these guards; the tree was dirtied while this submission
        // waited in the mutation queue. Only a check inside the critical section sees that.
        const test = await fixture({ dirty: true });

        await expect(runInteractiveRebaseSubmission(test.dependencies, input())).resolves.toEqual({
            status: "guard-rejected",
            reason: "working-tree-dirty",
        });

        expect(test.executor.runBinary).not.toHaveBeenCalledWith(
            ["rebase", "-i", BASE],
            expect.anything(),
        );
        const paths = getRebaseStoragePaths(test.storageRoot, "/fixture-repository");
        await Promise.all([
            expectMissing(paths.reservationPath),
            expectMissing(paths.sessionDirectory("session-1")),
        ]);
    });

    it("keeps the session when the spawn throws after Git left a live rebase", async () => {
        // A Git fatal exits outside `expectedExitCodes`, so this lands on the throw path even
        // though a resumable rebase exists. Deleting the session here would strand that rebase
        // with no todo, no message map, and no reservation.
        const test = await fixture({ throwOnRebase: true, rebaseDirectoryBeforeThrow: true });

        await expect(
            runInteractiveRebaseSubmission(test.dependencies, input()),
        ).resolves.toMatchObject({ status: "failed", reason: "unexpected-error" });

        const paths = getRebaseStoragePaths(test.storageRoot, "/fixture-repository");
        await Promise.all([
            expect(access(paths.reservationPath)).resolves.toBeUndefined(),
            expect(access(paths.sessionDirectory("session-1"))).resolves.toBeUndefined(),
            expect(access(paths.manifestPath("session-1"))).resolves.toBeUndefined(),
        ]);
    });

    it("releases every owned artifact when the rebase spawn throws", async () => {
        const test = await fixture({ throwOnRebase: true });

        await expect(
            runInteractiveRebaseSubmission(test.dependencies, input()),
        ).resolves.toMatchObject({
            status: "failed",
            reason: "unexpected-error",
        });

        const paths = getRebaseStoragePaths(test.storageRoot, "/fixture-repository");
        await Promise.all([
            expectMissing(paths.reservationPath),
            expectMissing(paths.sessionDirectory("session-1")),
            expectMissing(paths.manifestPath("session-1")),
        ]);
    });

    it.each([
        [
            "storage is unavailable",
            async (test: Awaited<ReturnType<typeof fixture>>) => {
                test.dependencies.storageRoot = undefined;
            },
            "storage-unavailable",
        ],
        [
            "the helper is missing",
            async (test: Awaited<ReturnType<typeof fixture>>) => {
                await rm(test.dependencies.helperScriptPath);
            },
            "editor-helper-missing",
        ],
    ] as const)("rejects before reserving when %s", async (_name, arrange, reason) => {
        const test = await fixture();
        await arrange(test);

        await expect(runInteractiveRebaseSubmission(test.dependencies, input())).resolves.toEqual({
            status: "failed",
            reason,
        });
        await expectMissing(
            getRebaseStoragePaths(test.storageRoot, "/fixture-repository").reservationPath,
        );
    });
});
