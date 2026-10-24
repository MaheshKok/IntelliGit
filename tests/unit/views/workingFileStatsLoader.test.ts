import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { removeScratchDirectoriesSync } from "../../helpers/scratchDirectories";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import type { WorkingFile } from "../../../src/types";
import { WorkingFileStatsLoader } from "../../../src/views/workingFileStatsLoader";
import { mergeWorkingFileStats } from "../../../src/webviews/protocol/workingFileStats";

const pending = (path: string, sourcePath?: string): WorkingFile => ({
    path,
    ...(sourcePath ? { sourcePath, status: "R" as const } : { status: "M" as const }),
    staged: false,
    additions: 0,
    deletions: 0,
    statsState: "pending",
});

/** A real directory for file timestamps, with a fake index path and a settable HEAD. */
function repository() {
    const root = mkdtempSync(path.join(tmpdir(), "intelligit-stats-"));
    const write = (file: string, text: string) => writeFileSync(path.join(root, file), text);
    for (const file of ["index", "a", "b"]) write(file, "initial");
    let head = "h1";
    const git = {
        head: { set: (value: string) => (head = value) },
        getWorkingFileStatsBasis: vi.fn(async () => ({ indexPath: "index", head })),
        getWorkingFileStats: vi.fn(async (rows: readonly WorkingFile[]) =>
            rows.map((row) => ({ ...row, additions: 9, statsState: "ready" as const })),
        ),
    };
    onTestFinished(() => removeScratchDirectoriesSync(root));
    return { root, git, write };
}

describe("WorkingFileStatsLoader", () => {
    it("reads real Git counts for a stat-dirty unchanged file without rewriting the index", async () => {
        const root = mkdtempSync(path.join(tmpdir(), "intelligit-stats-git-"));
        onTestFinished(() => removeScratchDirectoriesSync(root));
        const git = (...args: string[]) =>
            execFileSync("git", args, { cwd: root, encoding: "utf8" });
        git("init", "-q");
        git("config", "user.name", "Stats");
        git("config", "user.email", "stats@example.invalid");
        git("config", "commit.gpgSign", "false");
        writeFileSync(path.join(root, "same.txt"), "same\n");
        writeFileSync(path.join(root, "changed.txt"), "one\n");
        git("add", ".");
        git("commit", "-qm", "base");
        writeFileSync(path.join(root, "changed.txt"), "one\ntwo\n");
        // Same bytes, later mtime: the index entry is stat-dirty while the content is unchanged.
        writeFileSync(path.join(root, "same.txt"), "same\n");
        const later = statSync(path.join(root, "same.txt")).mtimeMs / 1000 + 2;
        utimesSync(path.join(root, "same.txt"), later, later);
        const indexBefore = readFileSync(path.join(root, ".git", "index"));
        const loader = new WorkingFileStatsLoader();
        const files = loader.reset([pending("same.txt"), pending("changed.txt")]);
        const deliver = vi.fn();

        await loader.request(
            files[0].statsRevision,
            ["same.txt", "changed.txt"],
            root,
            new GitOps(new GitExecutor(root)),
            deliver,
        );

        const delivered = deliver.mock.calls.flatMap(([reply]) => reply.files as WorkingFile[]);
        expect(delivered.find((file) => file.path === "changed.txt")).toMatchObject({
            additions: 1,
            deletions: 0,
            statsState: "ready",
        });
        expect(delivered.find((file) => file.path === "same.txt")).toMatchObject({
            additions: 0,
            deletions: 0,
            statsState: "ready",
        });
        expect(
            readFileSync(path.join(root, ".git", "index")),
            "the statistics read leaves the index bytes untouched",
        ).toEqual(indexBefore);
        loader.dispose();
    });

    it("every accepted visible path reaches ready or unavailable after backpressure", async () => {
        const loader = new WorkingFileStatsLoader();
        const files = loader.reset(
            Array.from({ length: 513 }, (_, index) => pending(`file-${index}.txt`)),
        );
        let releaseFirst!: () => void;
        const firstRead = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const read = vi.fn(async (rows: readonly WorkingFile[]) => {
            if (read.mock.calls.length === 1) await firstRead;
            return rows.map((entry) => ({ ...entry, statsState: "ready" as const }));
        });
        const deliver = vi.fn();
        const requests = Array.from({ length: 5 }, (_, batch) =>
            loader.request(
                files[0].statsRevision,
                files.slice(batch * 128, (batch + 1) * 128).map((entry) => entry.path),
                "/repo",
                { getWorkingFileStats: read },
                deliver,
            ),
        );

        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        releaseFirst();
        await Promise.all(requests);

        const terminalPaths = new Set(
            deliver.mock.calls.flatMap(([reply]) =>
                reply.files.map((entry: WorkingFile) => entry.path),
            ),
        );
        expect(terminalPaths).toHaveLength(513);
        expect(terminalPaths.has("file-512.txt")).toBe(true);
        loader.dispose();
    });

    it("continues after a byte-bounded batch fails and resolves the remaining paths", async () => {
        const loader = new WorkingFileStatsLoader();
        const files = loader.reset([
            pending("one.txt", "a".repeat(30_000)),
            pending("two.txt", "b".repeat(30_000)),
            pending("three.txt", "c".repeat(30_000)),
        ]);
        const read = vi.fn(async (rows: readonly WorkingFile[]) => {
            if (read.mock.calls.length === 1) throw new Error("first batch failed");
            return rows.map((entry) => ({ ...entry, statsState: "ready" as const }));
        });
        const deliver = vi.fn();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
            await loader.request(
                files[0].statsRevision,
                files.map((entry) => entry.path),
                "/repo",
                { getWorkingFileStats: read },
                deliver,
            );
        } finally {
            warn.mockRestore();
        }

        expect(read).toHaveBeenCalledTimes(2);
        const terminal = new Map(
            deliver.mock.calls.flatMap(([reply]) =>
                reply.files.map((entry: WorkingFile) => [entry.path, entry.statsState] as const),
            ),
        );
        expect(terminal.get("one.txt")).toBe("unavailable");
        expect(terminal.get("two.txt")).toBe("unavailable");
        expect(terminal.get("three.txt")).toBe("ready");
        loader.dispose();
    });

    it("marks an individually oversized validated path unavailable without calling Git", async () => {
        const loader = new WorkingFileStatsLoader();
        const files = loader.reset([pending("large.txt", "x".repeat(65_536))]);
        const read = vi.fn(async (rows: readonly WorkingFile[]) =>
            rows.map((entry) => ({ ...entry, statsState: "ready" as const })),
        );
        const deliver = vi.fn();

        await loader.request(
            files[0].statsRevision,
            ["large.txt"],
            "/repo",
            { getWorkingFileStats: read },
            deliver,
        );

        expect(read).not.toHaveBeenCalled();
        expect(deliver).toHaveBeenCalledWith(
            expect.objectContaining({
                repositoryRoot: "/repo",
                files: [expect.objectContaining({ path: "large.txt", statsState: "unavailable" })],
            }),
        );
        loader.dispose();
    });

    it("deduplicates concurrent requests and preserves status and icons when applying counts", async () => {
        const loader = new WorkingFileStatsLoader();
        const files = loader.reset([pending("a"), pending("b")]);
        const read = vi.fn(async (rows: readonly WorkingFile[]) =>
            rows.map((entry) => ({ ...entry, additions: 9, statsState: "ready" as const })),
        );
        const deliver = vi.fn();
        await Promise.all([
            loader.request(
                files[0].statsRevision,
                ["a"],
                "/repo",
                { getWorkingFileStats: read },
                deliver,
            ),
            loader.request(
                files[0].statsRevision,
                ["a"],
                "/repo",
                { getWorkingFileStats: read },
                deliver,
            ),
        ]);
        expect(read).toHaveBeenCalledOnce();
        expect(deliver).toHaveBeenCalledOnce();
        expect(Object.keys(deliver.mock.calls[0][0].files[0]).sort()).toEqual([
            "additions",
            "deletions",
            "path",
            "staged",
            "statsState",
        ]);
        const merged = mergeWorkingFileStats(files, deliver.mock.calls[0][0]);
        expect(merged[0].additions).toBe(9);
        expect(merged[1]).toBe(files[1]);
        loader.dispose();
    });

    it("discards an old refresh's late counts when the new refresh cannot prove them current", async () => {
        const loader = new WorkingFileStatsLoader();
        const files = loader.reset([pending("a")]);
        let resolve!: (rows: WorkingFile[]) => void;
        const read = vi.fn(
            () =>
                new Promise<WorkingFile[]>((done) => {
                    resolve = done;
                }),
        );
        const deliver = vi.fn();
        const request = loader.request(
            files[0].statsRevision,
            ["a"],
            "/repo",
            { getWorkingFileStats: read },
            deliver,
        );
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        const next = loader.reset([pending("a")]);
        resolve([{ ...files[0], additions: 100 }]);
        await request;
        expect(deliver).not.toHaveBeenCalled();
        expect(mergeWorkingFileStats(next, { revision: files[0].statsRevision!, files })).toEqual(
            next,
        );
        loader.dispose();
    });

    it("keeps finished counts across a refresh and recounts only what changed", async () => {
        const { root, git, write } = repository();
        const loader = new WorkingFileStatsLoader();
        const refresh = async () => {
            const status = [pending("a"), pending("b")];
            return loader.reset(status, await loader.capture(status, git, root));
        };
        const first = await refresh();
        await loader.request(first[0].statsRevision, ["a", "b"], root, git, vi.fn());

        write("b", "changed");
        const second = await refresh();
        expect(second[0]).toMatchObject({ path: "a", additions: 9, statsState: "ready" });
        expect(second[1]).toMatchObject({ path: "b", statsState: "pending" });

        await loader.request(second[1].statsRevision, ["b"], root, git, vi.fn());
        expect((await refresh()).map((row) => row.statsState)).toEqual(["ready", "ready"]);
        for (const change of [() => git.head.set("h2"), () => write("index", "staged")]) {
            await loader.request(
                (await refresh())[0].statsRevision,
                ["a", "b"],
                root,
                git,
                vi.fn(),
            );
            change();
            expect((await refresh()).map((row) => row.statsState)).toEqual(["pending", "pending"]);
        }
        loader.dispose();
    });

    it("delivers counts that finish after a refresh when the file did not change", async () => {
        const { root, git, write } = repository();
        const loader = new WorkingFileStatsLoader();
        const refresh = async () => {
            const status = [pending("a")];
            return loader.reset(status, await loader.capture(status, git, root));
        };
        // While `hold` is set each read waits for `release`, like a read slower than one refresh.
        let hold = true;
        let release = () => undefined as void;
        const counted = (rows: readonly WorkingFile[]) =>
            rows.map((row) => ({ ...row, additions: 100, statsState: "ready" as const }));
        const read = vi.fn((rows: readonly WorkingFile[]) =>
            hold
                ? new Promise<WorkingFile[]>((done) => (release = () => done(counted(rows))))
                : Promise.resolve(counted(rows)),
        );
        const slowGit = { ...git, getWorkingFileStats: read };
        const deliver = vi.fn();
        const slow = loader.request(
            (await refresh())[0].statsRevision,
            ["a"],
            root,
            slowGit,
            deliver,
        );
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        const second = await refresh();
        release();
        await slow;
        expect(deliver).toHaveBeenCalledOnce();
        expect(mergeWorkingFileStats(second, deliver.mock.calls[0][0])[0]).toMatchObject({
            additions: 100,
            statsState: "ready",
        });
        expect((await refresh())[0]).toMatchObject({ additions: 100, statsState: "ready" });

        // The panel asks again on the new refresh while the slow read runs: no second read.
        write("a", "changed");
        const inFlight = loader.request(
            (await refresh())[0].statsRevision,
            ["a"],
            root,
            slowGit,
            deliver,
        );
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        hold = false;
        const again = loader.request(
            (await refresh())[0].statsRevision,
            ["a"],
            root,
            slowGit,
            deliver,
        );
        release();
        await Promise.all([inFlight, again]);
        expect(read).toHaveBeenCalledTimes(2);
        expect(deliver).toHaveBeenCalledTimes(2);

        // A file that changed while its read ran never shows the old count.
        hold = true;
        write("a", "changed again");
        const stale = loader.request(
            (await refresh())[0].statsRevision,
            ["a"],
            root,
            slowGit,
            deliver,
        );
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
        write("a", "changed a third time");
        await refresh();
        release();
        await stale;
        expect(deliver).toHaveBeenCalledTimes(2);
        loader.dispose();
    });

    it("keys counts per staged and unstaged row and carries a path only when all its rows match", async () => {
        const { root, git } = repository();
        const both = (stagedStatus: WorkingFile["status"]): WorkingFile[] => [
            { ...pending("a"), staged: true, status: stagedStatus },
            pending("a"),
        ];
        const counted = (rows: readonly WorkingFile[]) =>
            rows.map((row) => ({
                ...row,
                additions: row.staged ? 1 : 2,
                statsState: "ready" as const,
            }));
        git.getWorkingFileStats.mockImplementation(async (rows) => counted(rows));
        const loader = new WorkingFileStatsLoader();
        const refresh = async (status: WorkingFile[]) =>
            loader.reset(status, await loader.capture(status, git, root));
        await loader.request(
            (await refresh(both("M")))[0].statsRevision,
            ["a"],
            root,
            git,
            vi.fn(),
        );
        expect((await refresh(both("M"))).map((row) => row.additions)).toEqual([1, 2]);
        expect((await refresh(both("A"))).map((row) => row.statsState)).toEqual([
            "pending",
            "ready",
        ]);
        loader.dispose();

        let release = () => undefined as void;
        git.getWorkingFileStats.mockImplementationOnce(
            (rows) => new Promise((done) => (release = () => done(counted(rows)))),
        );
        const fresh = new WorkingFileStatsLoader();
        const freshRefresh = async (status: WorkingFile[]) =>
            fresh.reset(status, await fresh.capture(status, git, root));
        const deliver = vi.fn();
        const slow = fresh.request(
            (await freshRefresh(both("M")))[0].statsRevision,
            ["a"],
            root,
            git,
            deliver,
        );
        await vi.waitFor(() => expect(git.getWorkingFileStats).toHaveBeenCalledTimes(2));
        const next = await freshRefresh(both("A"));
        release();
        await slow;
        expect(deliver).not.toHaveBeenCalled();
        await fresh.request(next[0].statsRevision, ["a"], root, git, deliver);
        expect(deliver).toHaveBeenCalledOnce();
        fresh.dispose();
    });

    it("refuses unknown and oversized path arrays before the reader", async () => {
        const loader = new WorkingFileStatsLoader();
        const files = loader.reset([pending("a")]);
        const read = vi.fn(async () => []);
        for (const paths of [["outside"], Array.from({ length: 129 }, () => "a")])
            await expect(
                loader.request(
                    files[0].statsRevision,
                    paths,
                    "/repo",
                    { getWorkingFileStats: read },
                    vi.fn(),
                ),
            ).rejects.toThrow();
        expect(read).not.toHaveBeenCalled();
        loader.dispose();
    });

    it("marks read failures unavailable instead of presenting zero as an exact count", async () => {
        const loader = new WorkingFileStatsLoader();
        const files = loader.reset([pending("a")]);
        const deliver = vi.fn();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
            await loader.request(
                files[0].statsRevision,
                ["a"],
                "/repo",
                {
                    getWorkingFileStats: vi.fn(async () => {
                        throw new Error("read failed");
                    }),
                },
                deliver,
            );
            expect(deliver.mock.calls[0][0].files[0].statsState).toBe("unavailable");
        } finally {
            warn.mockRestore();
            loader.dispose();
        }
    });
});
