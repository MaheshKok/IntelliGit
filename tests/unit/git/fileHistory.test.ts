import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitExecutor } from "../../../src/git/executor";
import { getFileHistory, getFileHistoryParentPath } from "../../../src/git/fileHistory";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

describe("file history parser input", () => {
    it.each(["tab\tfile.txt", "line\nfile.txt", "[ab]*.txt", " spaced.txt "])(
        "preserves filename bytes without filesystem restrictions: %j",
        async (name) => {
            const hash = "1".repeat(40);
            const output = [
                hash,
                "",
                "Author",
                "author@example.test",
                "2026-01-01T00:00:00Z",
                "Committer",
                "committer@example.test",
                "2026-01-01T00:00:00Z",
                "literal names",
                "\nA",
                name,
                "",
            ].join("\0");
            const run = vi.fn().mockResolvedValueOnce(output).mockResolvedValue("");
            const result = await getFileHistory({ run }, name);
            expect(
                result.entries.map((entry) => [entry.hash, entry.pathAtRevision, entry.status]),
            ).toEqual([[hash, name, "added"]]);
            expect(run.mock.calls[0][0]).toEqual(
                expect.arrayContaining(["--literal-pathspecs", "--", name]),
            );
        },
    );
});

describe("literal file history with real Git", () => {
    let directory: string;
    let executor: GitExecutor;

    beforeEach(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "intelligit-file-history-"));
        executor = new GitExecutor(directory);
        await executor.run(["init", "-b", "main"]);
        await executor.run(["config", "user.name", "History Author"]);
        await executor.run(["config", "user.email", "author@example.test"]);
    });

    afterEach(async () => {
        await removeScratchDirectories(directory);
    });

    /** Commits fixture changes and returns their immutable object ID. */
    async function commit(subject: string): Promise<string> {
        await executor.run(["add", "--all"]);
        await executor.run(["commit", "-m", subject], {
            env: {
                GIT_AUTHOR_DATE: "2026-01-01T01:02:03+00:00",
                GIT_COMMITTER_DATE: "2026-01-02T04:05:06+00:00",
                GIT_COMMITTER_NAME: "History Committer",
                GIT_COMMITTER_EMAIL: "committer@example.test",
            },
        });
        return (await executor.run(["rev-parse", "HEAD"])).trim();
    }

    it("tracks historical paths through two renames, deletion, and the root commit", async () => {
        await writeFile(path.join(directory, "original.txt"), "one\ntwo\nthree\n");
        const added = await commit("root | metadata\u001e separator");
        await rename(path.join(directory, "original.txt"), path.join(directory, "middle.txt"));
        const firstRename = await commit("first rename");
        await writeFile(path.join(directory, "middle.txt"), "one\ntwo\nthree\nfour\n");
        const modified = await commit("modify");
        await rename(path.join(directory, "middle.txt"), path.join(directory, "final.txt"));
        const secondRename = await commit("second rename");
        await rm(path.join(directory, "final.txt"));
        const deleted = await commit("delete");

        const history = await getFileHistory(executor, "final.txt");
        expect(history.entries.map((entry) => entry.hash)).toEqual([
            deleted,
            secondRename,
            modified,
            firstRename,
            added,
        ]);
        expect(history.entries.map((entry) => entry.pathAtRevision)).toEqual([
            "final.txt",
            "final.txt",
            "middle.txt",
            "middle.txt",
            "original.txt",
        ]);
        expect(history.entries.map((entry) => entry.status)).toEqual([
            "deleted",
            "renamed",
            "modified",
            "renamed",
            "added",
        ]);
        expect(history.entries[1]?.previousPath).toBe("middle.txt");
        expect(history.entries[3]?.previousPath).toBe("original.txt");
        expect(history.entries[4]).toMatchObject({
            parents: [],
            subject: "root | metadata\u001e separator",
            authorName: "History Author",
            authorEmail: "author@example.test",
            committerName: "History Committer",
            committerEmail: "committer@example.test",
        });
        expect(Date.parse(history.entries[4]!.authoredAt)).toBe(Date.parse("2026-01-01T01:02:03Z"));
        expect(Date.parse(history.entries[4]!.committedAt)).toBe(
            Date.parse("2026-01-02T04:05:06Z"),
        );
        expect(history.entries[0]?.parents).toEqual([secondRename]);
        expect(history.hasMore).toBe(false);

        const page = await getFileHistory(executor, "final.txt", { ref: deleted, limit: 2 });
        expect(page.entries.map((entry) => entry.hash)).toEqual([deleted, secondRename]);
        expect(page.hasMore).toBe(true);
        const complete = await getFileHistory(executor, "final.txt", { ref: deleted, limit: 5 });
        expect(complete).toEqual(history);
        const branch = await getFileHistory(executor, "final.txt", { ref: "main" });
        expect(branch).toEqual(history);
    });

    it("attaches real branch, remote and lightweight or annotated tag names to their commits", async () => {
        await writeFile(path.join(directory, "file.txt"), "first\n");
        const first = await commit("first");
        await executor.run(["tag", "v1"]);
        await executor.run(["tag", "-a", "release/one", "-m", "release"]);
        await executor.run(["update-ref", "refs/remotes/origin/main", first]);
        await writeFile(path.join(directory, "file.txt"), "second\n");
        const second = await commit("second");
        const history = await getFileHistory(executor, "file.txt");
        expect(history.entries.find((entry) => entry.hash === first)?.refs).toEqual([
            { name: "origin/main", kind: "remote" },
            { name: "release/one", kind: "tag" },
            { name: "v1", kind: "tag" },
        ]);
        expect(history.entries.find((entry) => entry.hash === second)?.refs).toEqual([
            { name: "main", kind: "branch" },
        ]);
    });

    it("preserves literal brackets, leading-dash, and leading-space filenames with real Git", async () => {
        const names = ["[ab].txt", "-option.txt", " spaced.txt"];
        for (const name of names) await writeFile(path.join(directory, name), name);
        const initial = await commit("literal names");
        await writeFile(path.join(directory, "a.txt"), "unrelated glob match");
        await commit("unrelated");
        for (const name of names) {
            const result = await getFileHistory(executor, name);
            expect(result.entries.map((entry) => [entry.hash, entry.pathAtRevision])).toEqual([
                [initial, name],
            ]);
        }
    });

    it("reports type changes and returns empty history for an absent file", async () => {
        await writeFile(path.join(directory, "file.txt"), "target.txt");
        await commit("regular file");
        const blob = (await executor.run(["rev-parse", "HEAD:file.txt"])).trim();
        await executor.run(["update-index", "--cacheinfo", `120000,${blob},file.txt`]);
        await executor.run(["commit", "-m", "symbolic link"]);
        const history = await getFileHistory(executor, "file.txt");
        expect(history.entries.map((entry) => entry.status)).toEqual(["type-changed", "added"]);
        await expect(getFileHistory(executor, "absent.txt")).resolves.toEqual({
            entries: [],
            hasMore: false,
        });
    });

    it("includes conflict-resolution merges once with both real parents", async () => {
        await writeFile(path.join(directory, "file.txt"), "base\n");
        await commit("base");
        await executor.run(["checkout", "-b", "side"]);
        await writeFile(path.join(directory, "file.txt"), "side\n");
        const side = await commit("side");
        await executor.run(["checkout", "main"]);
        await writeFile(path.join(directory, "file.txt"), "main\n");
        const main = await commit("main");
        await expect(executor.run(["merge", "side"])).rejects.toThrow();
        await writeFile(path.join(directory, "file.txt"), "resolved\n");
        const merge = await commit("conflict resolution");
        const history = await getFileHistory(executor, "file.txt");
        expect(history.entries[0]).toMatchObject({ hash: merge, parents: [main, side] });
        expect(history.entries.filter((entry) => entry.hash === merge)).toHaveLength(1);
        expect(history.entries.map((entry) => entry.hash)).toContain(side);
    });

    it("resolves a renamed file separately for each merge parent", async () => {
        await writeFile(path.join(directory, "old.txt"), "one\ntwo\nthree\nfour\n");
        await commit("base");
        await executor.run(["checkout", "-b", "side"]);
        await writeFile(path.join(directory, "old.txt"), "one\ntwo\nthree\nchanged\n");
        const side = await commit("side edit");
        await executor.run(["checkout", "main"]);
        await rename(path.join(directory, "old.txt"), path.join(directory, "new.txt"));
        const main = await commit("rename");
        await executor.run(["merge", "--no-ff", "side", "-m", "merge"]);
        const history = await getFileHistory(executor, "new.txt");
        const merge = history.entries[0];
        expect(merge.parents).toEqual([main, side]);
        await expect(getFileHistoryParentPath(executor, merge, main)).resolves.toBe("new.txt");
        await expect(getFileHistoryParentPath(executor, merge, side)).resolves.toBe("old.txt");
    });

    it("rejects invalid paths and refs before Git and propagates repository failures", async () => {
        const failing = {
            run: async (): Promise<string> => {
                throw new Error("Git unavailable");
            },
        };
        for (const file of ["", "/absolute", "../escape", "dir/../escape", "nul\0file"]) {
            await expect(getFileHistory(failing, file)).rejects.toThrow(/path/i);
        }
        for (const ref of ["--all", "HEAD~1", "main..other", "main\nother", ""]) {
            await expect(getFileHistory(failing, "valid.txt", { ref })).rejects.toThrow(/ref/i);
        }
        await expect(getFileHistory(failing, "valid.txt")).rejects.toThrow("Git unavailable");
        await expect(getFileHistory(executor, "valid.txt", { limit: 0 })).rejects.toThrow(/limit/i);
        await expect(getFileHistory(executor, "valid.txt", { ref: "missing" })).rejects.toThrow();
    });
});
