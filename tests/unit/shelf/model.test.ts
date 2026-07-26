import { describe, expect, it } from "vitest";
import {
    assertShelfStateSupported,
    selectWholeShelfEntries,
    ShelfUnsupportedStateError,
    type ShelfFileEntry,
} from "../../../src/shelf/model";

const renameChain: ShelfFileEntry = {
    changeId: "rename-chain",
    indexBlock: {
        path: "b.txt",
        renamedFrom: "a.txt",
        status: "R",
        modeBefore: "100644",
        modeAfter: "100644",
        beforeContentHash: "a".repeat(64),
        afterContentHash: "b".repeat(64),
    },
    worktreeBlock: {
        path: "c.txt",
        renamedFrom: "b.txt",
        status: "R",
        modeBefore: "100644",
        modeAfter: "100755",
        beforeContentHash: "b".repeat(64),
        afterContentHash: "c".repeat(64),
    },
    binary: false,
    untracked: false,
    baseAvailability: "full",
    exactReconstruction: true,
    lifecycle: "shelved",
};

describe("ShelfFileEntry", () => {
    it("selects a complete logical entry so rename pairs remain atomic", () => {
        const ordinary: ShelfFileEntry = {
            ...renameChain,
            changeId: "ordinary",
            indexBlock: {
                ...renameChain.indexBlock!,
                path: "ordinary.txt",
                renamedFrom: undefined,
                status: "M",
            },
            worktreeBlock: undefined,
        };

        expect(selectWholeShelfEntries([renameChain, ordinary], new Set(["rename-chain"]))).toEqual(
            [renameChain],
        );
    });

    it("surfaces unsupported capture state with a typed per-file error", () => {
        expect(() => assertShelfStateSupported("rename-chain", "unmerged-stage")).toThrow(
            ShelfUnsupportedStateError,
        );
        expect(() => assertShelfStateSupported("rename-chain", "unmerged-stage")).toThrow(
            "Cannot shelve rename-chain: unmerged-stage is unsupported.",
        );
    });
});
