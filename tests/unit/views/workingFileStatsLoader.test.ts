import { describe, expect, it, vi } from "vitest";
import type { WorkingFile } from "../../../src/types";
import { WorkingFileStatsLoader } from "../../../src/views/workingFileStatsLoader";
import { mergeWorkingFileStats } from "../../../src/webviews/protocol/workingFileStats";

const pending = (path: string): WorkingFile => ({
    path,
    status: "M",
    staged: false,
    additions: 0,
    deletions: 0,
    statsState: "pending",
});

describe("WorkingFileStatsLoader", () => {
    it("deduplicates concurrent requests and preserves status and icons when applying counts", async () => {
        const loader = new WorkingFileStatsLoader();
        const files = loader.reset([pending("a"), pending("b")]);
        const read = vi.fn(async (rows: readonly WorkingFile[]) =>
            rows.map((file) => ({ ...file, additions: 9, statsState: "ready" as const })),
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
        let resolve!: (files: WorkingFile[]) => void;
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

    it("refuses unknown and oversized paths before the reader", async () => {
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
