import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
    abortInteractiveRebase,
    continueInteractiveRebase,
} from "../../../src/git/interactiveRebase/control";
import { runInteractiveRebaseSubmission } from "../../../src/git/interactiveRebase/run";
import type { RebaseTodoEntry } from "../../../src/git/interactiveRebase/types";
import {
    cleanTemporaryRepositories,
    createConflictingRebaseFixture,
    createRebaseFixture,
    git,
    readHistory,
    type RebaseFixture,
} from "./rebaseTestHarness";

const helperScriptPath = path.resolve(process.cwd(), "dist/interactive-rebase-editor-helper.cjs");

beforeAll(async () => {
    try {
        await access(helperScriptPath);
    } catch {
        throw new Error(
            "Interactive-rebase integration tests require the editor helper. Run `bun run build` first.",
        );
    }
});

afterEach(cleanTemporaryRepositories);

describe("interactive rebase real Git integration", () => {
    it("drops the second-from-top commit without losing the remaining history", async () => {
        const fixture = await createRebaseFixture(helperScriptPath);
        const rebaseable = fixture.commits.slice(2);
        const dropped = rebaseable.at(-2)!;
        const entries = rebaseable.map((commit) => ({
            hash: commit.hash,
            action: commit === dropped ? ("drop" as const) : ("pick" as const),
        }));

        await expect(
            runInteractiveRebaseSubmission(fixture.dependencies, submission(fixture, entries)),
        ).resolves.toMatchObject({ status: "completed" });

        const history = await readHistory(fixture.root);
        expect(history).toHaveLength(3);
        expect(history.map(({ subject }) => subject)).toEqual([
            fixture.commits[0].subject,
            fixture.commits[1].subject,
            ...rebaseable.filter((commit) => commit !== dropped).map(({ subject }) => subject),
        ]);
        expect(history.map(({ subject }) => subject)).not.toContain(dropped.subject);
        // Session state lives outside the repository, so a runner that left anything behind in the
        // working tree shows up here rather than hiding behind an ignore rule.
        expect((await git(fixture.root, ["status", "--porcelain"])).toString("utf8")).toBe("");
    });

    it("reorders commits to the submitted oldest-to-newest order", async () => {
        const fixture = await createRebaseFixture(helperScriptPath);
        const rebaseable = fixture.commits.slice(2);
        const submitted = [rebaseable[1], rebaseable[0]];
        const entries = submitted.map(({ hash }) => ({ hash, action: "pick" as const }));

        await expect(
            runInteractiveRebaseSubmission(fixture.dependencies, submission(fixture, entries)),
        ).resolves.toMatchObject({ status: "completed" });

        expect((await readHistory(fixture.root)).map(({ subject }) => subject)).toEqual([
            fixture.commits[0].subject,
            fixture.commits[1].subject,
            ...submitted.map(({ subject }) => subject),
        ]);
    });

    it("aborts a stopped rebase and restores the exact pre-rebase HEAD", async () => {
        const fixture = await createRebaseFixture(helperScriptPath);
        const headBeforeRun = (await git(fixture.root, ["rev-parse", "HEAD"]))
            .toString("utf8")
            .trim();
        const rebaseable = fixture.commits.slice(2);
        // Reordered so the stop lands on rewritten history. Left in place, the pinned dates make
        // the recreated commits byte-identical, so the paused HEAD would already equal
        // `headBeforeRun` and `rebase --quit` — which clears the state without restoring anything
        // — would satisfy the restore assertion below just as well as `--abort`.
        const entries: RebaseTodoEntry[] = [
            { hash: rebaseable[1].hash, action: "pick" },
            // An empty message makes Git stop at its real amend step while the helper remains active.
            { hash: rebaseable[0].hash, action: "reword", message: "" },
        ];

        await expect(
            runInteractiveRebaseSubmission(fixture.dependencies, submission(fixture, entries)),
        ).resolves.toMatchObject({ status: "paused-helper-stop" });
        // The post-abort ENOENT below proves nothing unless the rebase actually reached a stopped
        // state first — without this, a run that never started would satisfy the whole test.
        await expect(access(path.join(fixture.gitDir, "rebase-merge"))).resolves.toBeUndefined();
        // Pins the non-vacuity the reordering above buys: the restore assertion is only a test of
        // `--abort` while the paused HEAD actually differs from the one being restored.
        expect((await git(fixture.root, ["rev-parse", "HEAD"])).toString("utf8").trim()).not.toBe(
            headBeforeRun,
        );

        await expect(abortInteractiveRebase(fixture.dependencies, fixture.root)).resolves.toEqual({
            status: "aborted",
            rebaseControl: "owned",
        });

        expect((await git(fixture.root, ["rev-parse", "HEAD"])).toString("utf8").trim()).toBe(
            headBeforeRun,
        );
        await expect(access(path.join(fixture.gitDir, "rebase-merge"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("pauses a conflicting reorder with a real conflicted index", async () => {
        const fixture = await createConflictingRebaseFixture(helperScriptPath);
        const entries = conflictingReorderEntries(fixture);

        await expect(
            runInteractiveRebaseSubmission(fixture.dependencies, submission(fixture, entries)),
        ).resolves.toEqual({ status: "paused-conflict" });

        await expect(access(path.join(fixture.gitDir, "rebase-merge"))).resolves.toBeUndefined();
        expect((await git(fixture.root, ["ls-files", "-u"])).toString("utf8")).not.toBe("");
        await expect(readFile(path.join(fixture.root, "shared.txt"), "utf8")).resolves.toContain(
            "<<<<<<<",
        );
    });

    it("continues a resolved conflicting reorder into the submitted history", async () => {
        const fixture = await createConflictingRebaseFixture(helperScriptPath);
        const entries = conflictingReorderEntries(fixture);

        await expect(
            runInteractiveRebaseSubmission(fixture.dependencies, submission(fixture, entries)),
        ).resolves.toEqual({ status: "paused-conflict" });
        await resolveSharedFileConflict(fixture.root);

        // `completed` is reachable only from the owned path, so the result union deliberately
        // carries no `rebaseControl` here — `toEqual` pins that absence, and the OID pins that the
        // reported head is what Git produced rather than a value captured before the continue.
        const completion = await continueInteractiveRebase(fixture.dependencies, fixture.root);
        expect(completion).toEqual({
            status: "completed",
            rebasedHeadOid: (await git(fixture.root, ["rev-parse", "HEAD"]))
                .toString("utf8")
                .trim(),
        });
        expect((await readHistory(fixture.root)).map(({ subject }) => subject)).toEqual([
            fixture.commits[0].subject,
            fixture.commits[1].subject,
            fixture.commits[3].subject,
            fixture.commits[2].subject,
            fixture.commits[4].subject,
        ]);
        expect((await git(fixture.root, ["status", "--porcelain"])).toString("utf8")).toBe("");
        await expect(access(path.join(fixture.gitDir, "rebase-merge"))).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(git(fixture.root, ["show", "HEAD:shared.txt"])).resolves.toEqual(
            Buffer.from("one\ntwo\nthree\nfour\nsecond\nsix\nseven\neight\nnine\nresolved ten\n"),
        );
    });

    it("keeps a queued reword message after resolving an earlier conflict", async () => {
        const fixture = await createConflictingRebaseFixture(helperScriptPath);
        const rebaseable = fixture.commits.slice(2);
        // `third` is picked first and conflicts immediately: its patch is computed against
        // `second`, which the reorder removed from beneath it. The reword is last in the todo, so
        // Git reaches it only after the user resolves that pause — which is the whole claim here,
        // that a message written to session storage before the run survives the interruption and
        // is consumed by a helper spawned after it.
        const entries: RebaseTodoEntry[] = [
            { hash: rebaseable[1].hash, action: "pick" },
            { hash: rebaseable[0].hash, action: "pick" },
            { hash: rebaseable[2].hash, action: "reword", message: "reworded fourth" },
        ];

        await expect(
            runInteractiveRebaseSubmission(fixture.dependencies, submission(fixture, entries)),
        ).resolves.toEqual({ status: "paused-conflict" });
        await resolveSharedFileConflict(fixture.root);

        await expect(
            continueInteractiveRebase(fixture.dependencies, fixture.root),
        ).resolves.toMatchObject({ status: "completed" });
        expect((await readHistory(fixture.root)).map(({ subject }) => subject)).toEqual([
            fixture.commits[0].subject,
            fixture.commits[1].subject,
            fixture.commits[3].subject,
            fixture.commits[2].subject,
            "reworded fourth",
        ]);
    });
});

function conflictingReorderEntries(fixture: RebaseFixture): RebaseTodoEntry[] {
    const rebaseable = fixture.commits.slice(2);
    return [
        { hash: rebaseable[1].hash, action: "pick" },
        { hash: rebaseable[0].hash, action: "pick" },
        { hash: rebaseable[2].hash, action: "pick" },
    ];
}

async function resolveSharedFileConflict(repositoryRoot: string): Promise<void> {
    await writeFile(
        path.join(repositoryRoot, "shared.txt"),
        "one\ntwo\nthree\nfour\nbase\nsix\nseven\neight\nnine\nresolved ten\n",
        "utf8",
    );
    await git(repositoryRoot, ["add", "shared.txt"]);
}

/** Builds the immutable request snapshot the runner receives after dialog validation. */
function submission(fixture: RebaseFixture, entries: readonly RebaseTodoEntry[]) {
    return {
        request: {
            requestId: "rebase-integration-request",
            originProvider: {},
            repoRoot: fixture.root,
            baseHash: fixture.commits[1].hash,
            rangeHashes: fixture.commits.slice(2).map(({ hash }) => hash),
            hasPushedCommit: false,
            expectedHead: fixture.commits.at(-1)!.hash,
            expectedBranch: "refs/heads/main",
        },
        entries,
    };
}
