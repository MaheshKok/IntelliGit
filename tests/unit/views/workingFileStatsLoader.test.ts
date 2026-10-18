import { describe, expect, it, vi } from "vitest";
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

describe("WorkingFileStatsLoader", () => {
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

    it("aborts and discards an old refresh even if its Git read ignores cancellation", async () => {
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
