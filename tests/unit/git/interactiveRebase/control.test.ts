import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REBASE_SESSION_MARKER } from "../../../../src/git/interactiveRebase/editorCommand";
import {
    abortInteractiveRebase,
    continueInteractiveRebase,
} from "../../../../src/git/interactiveRebase/control";
import { createGitEditorCommand } from "../../../../src/git/interactiveRebase/editorCommand";
import type { InteractiveRebaseRunDependencies } from "../../../../src/git/interactiveRebase/run";
import {
    createRebaseSessionDirectory,
    getRebaseStoragePaths,
    tryAcquireRebaseReservation,
    writeRebaseManifest,
} from "../../../../src/git/interactiveRebase/storage";
import { removeScratchDirectories } from "../../../helpers/scratchDirectories";

const terminalManifestWriteFault = vi.hoisted(() => ({ enabled: false }));

vi.mock("../../../../src/git/interactiveRebase/storage", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../../../src/git/interactiveRebase/storage")>();
    return {
        ...actual,
        writeRebaseManifest: async (...args: Parameters<typeof actual.writeRebaseManifest>) => {
            if (terminalManifestWriteFault.enabled) {
                terminalManifestWriteFault.enabled = false;
                throw new Error("forced terminal manifest write failure");
            }
            return actual.writeRebaseManifest(...args);
        },
    };
});

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const REBASED = "c".repeat(40);
const REPO_ROOT = "/fixture-repository";
const BRANCH = "refs/heads/main";
const SESSION_ID = "session-1";
const directories: string[] = [];

afterEach(async () => {
    terminalManifestWriteFault.enabled = false;
    await Promise.all(
        directories.splice(0).map((directory) => removeScratchDirectories(directory)),
    );
});

/** Creates an observable control-operation fixture with optional rebase ownership evidence. */
async function fixture(
    options: {
        control?: "owned" | "unowned" | "foreign" | "none";
        hasPushedCommit?: boolean;
        exitCode?: number;
        unmerged?: string;
        stderr?: string;
        abortFails?: boolean;
        continueThrows?: string;
        /** Git state left behind by a Continue that did not succeed, observed by the second probe. */
        afterContinue?: "keep" | "end" | "steal";
        /** Makes only the manifest write after a successful Git Continue fail. */
        terminalManifestWriteFailure?: boolean;
    } = {},
) {
    const root = await mkdtemp(path.join(os.tmpdir(), "intelligit-rebase-control-"));
    directories.push(root);
    const gitDir = path.join(root, ".git");
    const storageRoot = path.join(root, "storage");
    const helperScriptPath = path.join(root, "helper.cjs");
    await Promise.all([mkdir(gitDir), writeFile(helperScriptPath, "// fixture\n")]);
    const control = options.control ?? "owned";
    const paths = getRebaseStoragePaths(storageRoot, REPO_ROOT);

    if (control === "owned" || control === "foreign") {
        const acquired = await tryAcquireRebaseReservation({
            storageRoot,
            repoRoot: REPO_ROOT,
            gitDir,
            sessionId: SESSION_ID,
        });
        if (acquired.status !== "acquired") throw new Error("Expected fixture reservation.");
        await writeRebaseManifest(storageRoot, {
            version: 1,
            sessionId: SESSION_ID,
            repoRoot: REPO_ROOT,
            branch: BRANCH,
            hasPushedCommit: options.hasPushedCommit ?? false,
            pushTarget: {
                remoteName: "origin",
                remoteHeadRef: "refs/heads/main",
                upstreamOid: BASE,
            },
            baseHash: BASE,
            expectedHead: HEAD,
            createdAt: "2026-08-02T00:00:00.000Z",
            lifecycle: "paused",
        });
        await createRebaseSessionDirectory(storageRoot, REPO_ROOT, SESSION_ID);
    }
    if (control !== "none") {
        const mergeDirectory = path.join(gitDir, "rebase-merge");
        await mkdir(mergeDirectory);
        if (control === "owned" || control === "foreign") {
            await writeFile(
                path.join(mergeDirectory, REBASE_SESSION_MARKER),
                control === "owned" ? SESSION_ID : "other-session",
            );
        }
    }

    let inGate = false;
    const calls: Array<{ args: string[]; options?: Record<string, unknown> }> = [];
    const executor = {
        runBinary: vi.fn(async (args: string[], runOptions?: Record<string, unknown>) => {
            if (!inGate) throw new Error(`Git command escaped mutation gate: ${args.join(" ")}`);
            calls.push({ args, options: runOptions });
            const command = args.join(" ");
            if (command === "rev-parse HEAD") return binary(REBASED);
            if (command === "ls-files -u") return binary(options.unmerged ?? "");
            if (command === "rebase --continue") {
                const exitCode = options.exitCode ?? 0;
                const succeeded = exitCode === 0 && !options.continueThrows;
                const after = options.afterContinue ?? (succeeded ? "end" : "keep");
                const mergeDirectory = path.join(gitDir, "rebase-merge");
                if (after === "end") await removeScratchDirectories(mergeDirectory);
                if (after === "steal") {
                    await writeFile(
                        path.join(mergeDirectory, REBASE_SESSION_MARKER),
                        "other-session",
                    );
                }
                if (options.continueThrows) throw new Error(options.continueThrows);
                if (succeeded && options.terminalManifestWriteFailure) {
                    terminalManifestWriteFault.enabled = true;
                }
                return binary("", options.stderr ?? "helper-stop", exitCode);
            }
            if (command === "rebase --abort") {
                if (options.abortFails) throw new Error("abort failed");
                await removeScratchDirectories(path.join(gitDir, "rebase-merge"));
                return binary();
            }
            throw new Error(`Unexpected Git command: ${command}`);
        }),
    };
    const mutationGate = {
        run: vi.fn(
            async (_repoRoot: string, _commonDir: string, operation: () => Promise<unknown>) => {
                inGate = true;
                try {
                    return await operation();
                } finally {
                    inGate = false;
                }
            },
        ),
    };
    const dependencies = {
        executor: executor as never,
        mutationGate: mutationGate as never,
        storageRoot,
        gitDir,
        commonDir: gitDir,
        helperScriptPath,
    } satisfies Pick<
        InteractiveRebaseRunDependencies,
        "executor" | "mutationGate" | "storageRoot" | "gitDir" | "commonDir" | "helperScriptPath"
    >;
    return { calls, dependencies, executor, mutationGate, paths };
}

/** Produces the executor binary result shape from fixture text. */
function binary(stdout = "", stderr = "", exitCode = 0, truncated = false) {
    return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode, truncated };
}

async function expectMissing(target: string): Promise<void> {
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
}

function expectPassThroughEditor(
    call: { args: string[]; options?: Record<string, unknown> },
    extra: Record<string, unknown> = {},
): void {
    expect(call.options).toEqual({
        ...extra,
        env: { GIT_SEQUENCE_EDITOR: "true", GIT_EDITOR: "true" },
    });
}

describe("interactive rebase control", () => {
    it("continues an owned rebase with helper editors and deletes a completed non-offer session", async () => {
        const test = await fixture();

        await expect(continueInteractiveRebase(test.dependencies, REPO_ROOT)).resolves.toEqual({
            status: "completed",
            rebasedHeadOid: REBASED,
        });

        expect(test.mutationGate.run).toHaveBeenCalledWith(
            REPO_ROOT,
            test.dependencies.commonDir,
            expect.any(Function),
        );
        expect(test.calls).toContainEqual({
            args: ["rebase", "--continue"],
            options: {
                expectedExitCodes: [0, 1],
                env: {
                    GIT_SEQUENCE_EDITOR: createGitEditorCommand(
                        test.dependencies.helperScriptPath,
                        "sequence",
                        test.paths.sessionDirectory(SESSION_ID),
                    ),
                    GIT_EDITOR: createGitEditorCommand(
                        test.dependencies.helperScriptPath,
                        "message",
                        test.paths.sessionDirectory(SESSION_ID),
                    ),
                },
            },
        });
        await Promise.all([
            expectMissing(test.paths.sessionDirectory(SESSION_ID)),
            expectMissing(test.paths.manifestPath(SESSION_ID)),
            expectMissing(test.paths.reservationPath),
        ]);
    });

    it("retains the manifest when an owned continue completes a pushed-history offer", async () => {
        const test = await fixture({ hasPushedCommit: true });

        await expect(
            continueInteractiveRebase(test.dependencies, REPO_ROOT),
        ).resolves.toMatchObject({
            status: "completed-pending-push",
            manifest: { lifecycle: "completed-pending-push", rebasedHeadOid: REBASED },
        });

        await Promise.all([
            expectMissing(test.paths.sessionDirectory(SESSION_ID)),
            expect(access(test.paths.manifestPath(SESSION_ID))).resolves.toBeUndefined(),
            expectMissing(test.paths.reservationPath),
        ]);
    });

    it("reports Git success and cleans local state when the terminal Continue manifest write fails", async () => {
        const test = await fixture({ hasPushedCommit: true, terminalManifestWriteFailure: true });

        await expect(continueInteractiveRebase(test.dependencies, REPO_ROOT)).resolves.toEqual({
            status: "completed-with-local-state-warning",
            rebasedHeadOid: REBASED,
        });

        await Promise.all([
            expectMissing(test.paths.sessionDirectory(SESSION_ID)),
            expectMissing(test.paths.manifestPath(SESSION_ID)),
            expectMissing(test.paths.reservationPath),
        ]);
    });

    it.each([
        ["conflict", "UU file\n", { status: "paused-conflict" }],
        ["helper stop", "", { status: "paused-helper-stop", stderr: "helper-stop" }],
    ] as const)(
        "keeps every owned artifact when Continue pauses on %s",
        async (_name, unmerged, result) => {
            const test = await fixture({ exitCode: 1, unmerged });

            await expect(continueInteractiveRebase(test.dependencies, REPO_ROOT)).resolves.toEqual(
                result,
            );

            await Promise.all([
                expect(access(test.paths.sessionDirectory(SESSION_ID))).resolves.toBeUndefined(),
                expect(access(test.paths.manifestPath(SESSION_ID))).resolves.toBeUndefined(),
                expect(access(test.paths.reservationPath)).resolves.toBeUndefined(),
            ]);
        },
    );

    it("clears owned state when Continue fails and leaves Git with nothing to resume", async () => {
        // Git exited non-zero and removed its own rebase directory, so there is no rebase left to
        // resume: keeping the session, manifest, and reservation would block the next rebase on a
        // reservation whose rebase no longer exists.
        const test = await fixture({ exitCode: 1, afterContinue: "end" });

        await expect(
            continueInteractiveRebase(test.dependencies, REPO_ROOT),
        ).resolves.toMatchObject({
            status: "failed",
            rebaseControl: "owned",
            reason: "git-failed",
        });

        await Promise.all([
            expectMissing(test.paths.sessionDirectory(SESSION_ID)),
            expectMissing(test.paths.manifestPath(SESSION_ID)),
            expectMissing(test.paths.reservationPath),
        ]);
    });

    it("keeps owned state when the live rebase stops answering to our marker", async () => {
        const test = await fixture({ exitCode: 1, afterContinue: "steal" });

        await expect(
            continueInteractiveRebase(test.dependencies, REPO_ROOT),
        ).resolves.toMatchObject({
            status: "failed",
            rebaseControl: "owned",
            reason: "ownership-changed",
        });

        await Promise.all([
            expect(access(test.paths.sessionDirectory(SESSION_ID))).resolves.toBeUndefined(),
            expect(access(test.paths.manifestPath(SESSION_ID))).resolves.toBeUndefined(),
            expect(access(test.paths.reservationPath)).resolves.toBeUndefined(),
        ]);
    });

    it("reports a thrown Continue over a still-owned rebase as a Git failure, not a lost session", async () => {
        // `runBinary` rejects on any exit code outside the expected set, so a Git fatal lands here
        // rather than on the paused path. The rebase is still ours and still live: naming this
        // "ownership-changed" would send the caller hunting for a foreign rebase that is not there.
        const test = await fixture({
            continueThrows: "fatal: unable to read index",
            afterContinue: "keep",
        });

        await expect(continueInteractiveRebase(test.dependencies, REPO_ROOT)).resolves.toEqual({
            status: "failed",
            rebaseControl: "owned",
            reason: "git-failed",
            message: "fatal: unable to read index",
        });

        await Promise.all([
            expect(access(test.paths.sessionDirectory(SESSION_ID))).resolves.toBeUndefined(),
            expect(access(test.paths.manifestPath(SESSION_ID))).resolves.toBeUndefined(),
            expect(access(test.paths.reservationPath)).resolves.toBeUndefined(),
        ]);
    });

    it("clears owned state when a thrown Continue left no rebase behind", async () => {
        const test = await fixture({ continueThrows: "fatal: bad object", afterContinue: "end" });

        await expect(
            continueInteractiveRebase(test.dependencies, REPO_ROOT),
        ).resolves.toMatchObject({
            status: "failed",
            rebaseControl: "owned",
            reason: "git-failed",
        });

        await Promise.all([
            expectMissing(test.paths.sessionDirectory(SESSION_ID)),
            expectMissing(test.paths.manifestPath(SESSION_ID)),
            expectMissing(test.paths.reservationPath),
        ]);
    });

    it("aborts an owned rebase and cleans its session state in lifecycle order", async () => {
        const test = await fixture();

        await expect(abortInteractiveRebase(test.dependencies, REPO_ROOT)).resolves.toEqual({
            status: "aborted",
            rebaseControl: "owned",
        });

        expect(test.calls).toContainEqual({
            args: ["rebase", "--abort"],
            options: {
                env: {
                    GIT_SEQUENCE_EDITOR: createGitEditorCommand(
                        test.dependencies.helperScriptPath,
                        "sequence",
                        test.paths.sessionDirectory(SESSION_ID),
                    ),
                    GIT_EDITOR: createGitEditorCommand(
                        test.dependencies.helperScriptPath,
                        "message",
                        test.paths.sessionDirectory(SESSION_ID),
                    ),
                },
            },
        });
        await Promise.all([
            expectMissing(test.paths.sessionDirectory(SESSION_ID)),
            expectMissing(test.paths.manifestPath(SESSION_ID)),
            expectMissing(test.paths.reservationPath),
        ]);
    });

    it("leaves owned state intact when Abort fails", async () => {
        const test = await fixture({ abortFails: true });

        await expect(abortInteractiveRebase(test.dependencies, REPO_ROOT)).resolves.toMatchObject({
            status: "failed",
            rebaseControl: "owned",
        });

        await Promise.all([
            expect(access(test.paths.sessionDirectory(SESSION_ID))).resolves.toBeUndefined(),
            expect(access(test.paths.manifestPath(SESSION_ID))).resolves.toBeUndefined(),
            expect(access(test.paths.reservationPath)).resolves.toBeUndefined(),
        ]);
    });

    it.each([
        [
            "continue",
            continueInteractiveRebase,
            ["rebase", "--continue"],
            { status: "continued", rebaseControl: "unowned" },
            { expectedExitCodes: [0, 1] },
        ],
        [
            "abort",
            abortInteractiveRebase,
            ["rebase", "--abort"],
            { status: "aborted", rebaseControl: "unowned" },
            {},
        ],
    ] as const)(
        "runs unowned %s with a pass-through editor and never creates host state",
        async (_name, operation, argv, result, extraOptions) => {
            const test = await fixture({ control: "unowned" });

            await expect(operation(test.dependencies, REPO_ROOT)).resolves.toEqual(result);

            expect(test.calls).toHaveLength(1);
            expect(test.calls[0]?.args).toEqual(argv);
            expectPassThroughEditor(test.calls[0]!, extraOptions);
            await Promise.all([
                expectMissing(test.paths.sessionDirectory(SESSION_ID)),
                expectMissing(test.paths.manifestPath(SESSION_ID)),
                expectMissing(test.paths.reservationPath),
            ]);
        },
    );

    it("reports an unowned Continue that stops at the next conflict as a pause, not a failure", async () => {
        // Git exits 1 for a conflict stop and for a refusal alike. A rebase we did not start is
        // usually continued straight into its next conflict, so reading that exit as a failure
        // would tell the user their rebase died while Git is in fact waiting for them.
        const test = await fixture({
            control: "unowned",
            exitCode: 1,
            unmerged: "UU file\n",
            afterContinue: "keep",
        });

        await expect(continueInteractiveRebase(test.dependencies, REPO_ROOT)).resolves.toEqual({
            status: "paused-conflict",
        });

        expect(test.calls.map((call) => call.args)).toEqual([
            ["rebase", "--continue"],
            ["ls-files", "-u"],
        ]);
        await expectMissing(test.paths.reservationPath);
    });

    it("reports an unowned Continue as failed once Git has ended the rebase it was continuing", async () => {
        // Unmerged entries outlive the rebase directory when Git gives up mid-step, so the index
        // alone cannot say whether anything is still resumable. Only a rebase Git still holds can
        // be a pause; otherwise there is nothing left for the user to return to.
        const test = await fixture({
            control: "unowned",
            exitCode: 1,
            unmerged: "UU file\n",
            afterContinue: "end",
        });

        await expect(
            continueInteractiveRebase(test.dependencies, REPO_ROOT),
        ).resolves.toMatchObject({
            status: "failed",
            rebaseControl: "unowned",
            reason: "git-failed",
        });

        expect(test.calls.map((call) => call.args)).toEqual([["rebase", "--continue"]]);
    });

    it("reports an unowned Continue that Git refused as a failure carrying Git's own reason", async () => {
        const test = await fixture({
            control: "unowned",
            exitCode: 1,
            unmerged: "",
            stderr: "error: cannot rebase: You have unstaged changes.",
            afterContinue: "keep",
        });

        await expect(continueInteractiveRebase(test.dependencies, REPO_ROOT)).resolves.toEqual({
            status: "failed",
            rebaseControl: "unowned",
            reason: "git-failed",
            message: "error: cannot rebase: You have unstaged changes.",
        });
    });

    it("refuses foreign Continue without issuing a Git command", async () => {
        const test = await fixture({ control: "foreign" });

        await expect(continueInteractiveRebase(test.dependencies, REPO_ROOT)).resolves.toEqual({
            status: "foreign-continue-refused",
        });

        expect(test.executor.runBinary).not.toHaveBeenCalled();
    });

    it("aborts a foreign rebase with pass-through editors and leaves our manifest byte-identical", async () => {
        const test = await fixture({ control: "foreign" });
        const before = await readFile(test.paths.manifestPath(SESSION_ID), "utf8");

        await expect(abortInteractiveRebase(test.dependencies, REPO_ROOT)).resolves.toEqual({
            status: "aborted",
            rebaseControl: "foreign",
        });

        expect(test.calls).toHaveLength(1);
        expect(test.calls[0]?.args).toEqual(["rebase", "--abort"]);
        expectPassThroughEditor(test.calls[0]!);
        await expect(readFile(test.paths.manifestPath(SESSION_ID), "utf8")).resolves.toBe(before);
        await Promise.all([
            expect(access(test.paths.sessionDirectory(SESSION_ID))).resolves.toBeUndefined(),
            expect(access(test.paths.reservationPath)).resolves.toBeUndefined(),
        ]);
    });

    it.each([
        ["continue", continueInteractiveRebase],
        ["abort", abortInteractiveRebase],
    ] as const)(
        "returns no-rebase-in-progress for %s without issuing Git",
        async (_name, operation) => {
            const test = await fixture({ control: "none" });

            await expect(operation(test.dependencies, REPO_ROOT)).resolves.toEqual({
                status: "no-rebase-in-progress",
            });

            expect(test.executor.runBinary).not.toHaveBeenCalled();
        },
    );
});
