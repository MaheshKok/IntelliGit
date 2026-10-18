import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as partialSnapshot from "../../../src/git/partialSnapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    captureSelectedShelf,
    type SelectedShelfInput,
} from "../../../src/services/shelfSelectedCapture";
import type { ShelfCaptureDependencies } from "../../../src/services/shelfServiceCapture";

describe("selected capture admission", () => {
    it.each(["empty", "duplicate whole path", "unsafe path", "too many paths"] as const)(
        "rejects %s before Git or object capture",
        async (kind) => {
            const request: SelectedShelfInput = {
                name: "capture",
                baseCommit: "a".repeat(40),
                scope: "files",
                sourceLists: [{ id: "default", name: "Default", description: "", draft: "" }],
                selected: [],
                whole:
                    kind === "empty"
                        ? []
                        : kind === "too many paths"
                          ? Array.from({ length: 20_001 }, (_, i) => ({
                                path: `file-${i}`,
                                sourceListIds: ["default"],
                            }))
                          : kind === "unsafe path"
                            ? [{ path: "../outside", sourceListIds: ["default"] }]
                            : [
                                  { path: "file", sourceListIds: ["default"] },
                                  { path: "file", sourceListIds: ["default"] },
                              ],
            };
            const object = vi.fn();
            const run = vi.fn();
            const dependencies = {
                store: { assertMutationReady: async () => undefined, putObject: object },
                executor: { runBinary: run },
            } as unknown as ShelfCaptureDependencies;
            await expect(captureSelectedShelf(request, dependencies)).rejects.toThrow();
            expect(object).not.toHaveBeenCalled();
            expect(run).not.toHaveBeenCalled();
        },
    );
});

afterEach(() => vi.restoreAllMocks());
describe("partial capture output admission", () => {
    it.each([
        [65, 4, "Partial shelf capture supports at most 64 selected text files."],
        [64, 256 * 1024 + 1, "Partial shelf capture exceeds 16 MiB of selected output."],
        [64, 4, "admitted partial bounds"],
        [64, 256 * 1024, "admitted partial bounds"],
    ] as const)(
        "checks %s files of %s selected output bytes before Git or object writes",
        async (count, bytes, message) => {
            const root = await realpath(tmpdir());
            const assertCurrent = vi
                .spyOn(partialSnapshot, "assertPartialSnapshotCurrent")
                .mockRejectedValue(new Error("admitted partial bounds"));
            const selected = Array.from({ length: count }, (_, i) => ({
                snapshot: {
                    root,
                    head: "a".repeat(40),
                    working: "",
                    view: {
                        path: `file-${i}`,
                        base: "",
                        blocks: [
                            {
                                oldStart: 0,
                                oldCount: 0,
                                lines: [{ id: "added", kind: "add", text: "x".repeat(bytes) }],
                            },
                        ],
                    },
                },
                lineIds: ["added"],
                patch: Buffer.from("small patch"),
                owners: {},
            })) as unknown as SelectedShelfInput["selected"];
            const run = vi.fn();
            const object = vi.fn();
            await expect(
                captureSelectedShelf(
                    {
                        name: "bounds",
                        baseCommit: "a".repeat(40),
                        scope: "selection",
                        sourceLists: [],
                        selected,
                        whole: [],
                    },
                    {
                        repositoryRoot: root,
                        store: { assertMutationReady: async () => undefined, putObject: object },
                        executor: { runBinary: run },
                    } as unknown as ShelfCaptureDependencies,
                ),
            ).rejects.toThrow(message);
            expect(run).not.toHaveBeenCalled();
            expect(object).not.toHaveBeenCalled();
            expect(assertCurrent).toHaveBeenCalledTimes(
                message === "admitted partial bounds" ? 1 : 0,
            );
        },
    );
});
