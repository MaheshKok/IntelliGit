import { access } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { abortInteractiveRebase } from "../../../src/git/interactiveRebase/control";
import { runInteractiveRebaseSubmission } from "../../../src/git/interactiveRebase/run";
import type { RebaseTodoEntry } from "../../../src/git/interactiveRebase/types";
import {
    cleanTemporaryRepositories,
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
});

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
