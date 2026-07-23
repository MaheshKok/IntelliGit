import { describe, expect, it } from "vitest";
import {
    parseShelfPersistenceContract,
    ShelfPersistenceContractError,
} from "../../../src/shelf/model";

const contract = {
    metadata: { name: "Saved", lifecycle: "shelved", createdAt: 123 },
    files: [
        {
            changeId: "change-a",
            worktreeBlock: { path: "a.ts", status: "M", patchObjectHash: "a".repeat(64) },
            binary: false,
            untracked: false,
            baseAvailability: "none",
            exactReconstruction: true,
            lifecycle: "shelved",
        },
    ],
};

describe("ShelfMetadata.createdAt", () => {
    it("preserves a valid epoch timestamp through persistence parsing", () => {
        expect(parseShelfPersistenceContract(contract).metadata.createdAt).toBe(123);
    });

    it("rejects a non-integer epoch timestamp", () => {
        expect(() =>
            parseShelfPersistenceContract({
                ...contract,
                metadata: { ...contract.metadata, createdAt: 1.5 },
            }),
        ).toThrow(ShelfPersistenceContractError);
    });
});
