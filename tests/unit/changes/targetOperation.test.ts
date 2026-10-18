import { describe, expect, it } from "vitest";
import {
    parseTargetOperationEvidence,
    parseTargetOperationReceipt,
    parseTargetOperationRecord,
    summarizeTargetOperation,
    targetOperationEvidenceReferences,
    type TargetOperationEvidence,
    type TargetOperationRecord,
} from "../../../src/changes/targetOperation";

const id = "00000000-0000-4000-8000-000000000001";
const destinationId = "00000000-0000-4000-8000-000000000002";
const hash = (value: string) => value.repeat(64);
const head = "1".repeat(40);
const root = "/worktree";
const gitDir = "/worktree/.git";

function prepared(): TargetOperationRecord {
    return {
        version: 1,
        id,
        requestHash: hash("a"),
        beforeEvidenceHash: hash("b"),
        kind: "shelfRestore",
        phase: "prepared",
        destinationId,
        createdDestination: false,
        headBefore: head,
        evidenceHash: hash("b"),
        shelf: {
            id: "00000000-0000-4000-8000-000000000003",
            generation: 2,
            checksum: hash("c"),
            changeIds: ["change-1"],
            removeFromShelf: true,
        },
        draftChoice: { kind: "keep" },
    };
}

function evidence(): TargetOperationEvidence {
    return {
        version: 1,
        operationId: id,
        root,
        gitDir,
        checkpoint: "before",
        head,
        indexFingerprint: hash("d"),
        paths: [
            {
                path: "src/file.ts",
                state: {
                    kind: "regular",
                    executable: false,
                    content: { hash: hash("e"), size: 4 },
                    identity: {
                        device: "1",
                        inode: "2",
                        size: 4,
                        modifiedNs: "3",
                        changedNs: "4",
                    },
                },
            },
        ],
        index: [
            {
                path: "src/file.ts",
                stage: 0,
                mode: "100644",
                oid: head,
                object: { hash: hash("9"), size: 5 },
                assumeUnchanged: false,
                skipWorktree: false,
                intentToAdd: false,
            },
        ],
        native: [
            { name: "cherryPickHead", present: false },
            { name: "revertHead", present: false },
            { name: "mergeHead", present: false },
            { name: "sequencer", present: false },
        ],
        entries: [{ changeId: "change-1", path: "src/file.ts", outcome: "pending" }],
        previousEvidenceHash: hash("f"),
    };
}

describe("target operation persistence contracts", () => {
    it("validates operation attribution object references against the frozen path and entry set", () => {
        const input = {
            ...evidence(),
            attribution: [
                {
                    path: "src/file.ts",
                    changeIds: ["change-1"],
                    object: { hash: hash("a"), size: 12 },
                },
            ],
        };
        expect(
            parseTargetOperationEvidence(input, root, gitDir),
            "valid attribution references survive parsing",
        ).toEqual(input);
        expect(
            parseTargetOperationEvidence(
                { ...input, attribution: [{ ...input.attribution[0], path: "other.ts" }] },
                root,
                gitDir,
            ),
        ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                { ...input, attribution: [{ ...input.attribution[0], changeIds: ["foreign"] }] },
                root,
                gitDir,
            ),
        ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                { ...input, attribution: [input.attribution[0], input.attribution[0]] },
                root,
                gitDir,
            ),
        ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                {
                    ...input,
                    attribution: [
                        { ...input.attribution[0], object: { hash: "../unsafe", size: 12 } },
                    ],
                },
                root,
                gitDir,
            ),
        ).toBeUndefined();
        expect(targetOperationEvidenceReferences(input)).toContain(hash("a"));
    });

    it("requires immutable request identity and validates captured draft and creation evidence", () => {
        const valid = {
            ...prepared(),
            requestHash: hash("a"),
            beforeEvidenceHash: hash("b"),
        };
        expect(
            parseTargetOperationRecord(valid),
            "request identity survives durable parsing",
        ).toEqual(valid);
        expect(parseTargetOperationRecord({ ...valid, requestHash: undefined })).toBeUndefined();
        expect(
            parseTargetOperationRecord({ ...valid, beforeEvidenceHash: "invalid" }),
        ).toBeUndefined();
        expect(parseTargetOperationRecord({ ...valid, sourceDraft: "unselected" })).toBeUndefined();
        const copied = {
            ...valid,
            draftChoice: {
                kind: "copySource",
                sourceListId: destinationId,
                expectedDestinationDraft: "",
            },
            sourceDraft: "captured source draft",
        };
        expect(parseTargetOperationRecord(copied)).toEqual(copied);
        expect(parseTargetOperationRecord({ ...copied, sourceDraft: undefined })).toBeUndefined();
        expect(
            parseTargetOperationRecord({ ...copied, sourceDraft: "x".repeat(100_001) }),
        ).toBeUndefined();
        expect(parseTargetOperationRecord({ ...valid, createdDestination: true })).toBeUndefined();
        const created = {
            ...valid,
            createdDestination: true,
            destinationCreation: { name: "Destination", description: "", draft: "" },
        };
        expect(parseTargetOperationRecord(created)).toEqual(created);
        expect(
            parseTargetOperationRecord({ ...created, createdDestination: false }),
        ).toBeUndefined();
        expect(
            parseTargetOperationRecord({
                ...created,
                destinationCreation: { ...created.destinationCreation, draft: "modified" },
            }),
        ).toBeUndefined();
    });

    it("accepts a prepared record and rejects contradictory completion phases", () => {
        expect(parseTargetOperationRecord(prepared())).toEqual(prepared());
        expect(
            parseTargetOperationRecord({
                ...prepared(),
                completion: {
                    appliedChangeIds: [],
                    ownershipRevision: 1,
                    draft: "kept",
                    shelfPublication: "pending",
                },
            }),
            "prepared cannot claim ownership completion",
        ).toBeUndefined();
        expect(
            parseTargetOperationRecord({ ...prepared(), phase: "ownershipPublished" }),
            "ownership publication requires concrete completion",
        ).toBeUndefined();
        expect(
            parseTargetOperationRecord({
                ...prepared(),
                phase: "abortPrepared",
                completion: {
                    appliedChangeIds: [],
                    ownershipRevision: 1,
                    draft: "kept",
                    shelfPublication: "notRequired",
                },
            }),
            "abort checkpoints cannot masquerade as completion",
        ).toBeUndefined();
    });

    it("requires a published shelf receipt to agree with the record", () => {
        const completion = {
            appliedChangeIds: ["change-1"],
            ownershipRevision: 4,
            draft: "copied" as const,
            shelfPublication: "published" as const,
            publishedGeneration: 3,
            publishedChecksum: hash("f"),
        };
        expect(
            parseTargetOperationRecord({
                ...prepared(),
                phase: "shelfPublished",
                headAfter: head,
                completion,
            }),
        ).toMatchObject({ phase: "shelfPublished", completion });
        expect(
            parseTargetOperationRecord({
                ...prepared(),
                phase: "shelfPublished",
                headAfter: head,
                completion: { ...completion, shelfPublication: "pending" },
            }),
        ).toBeUndefined();
    });

    it("preserves completed ownership evidence when a later shelf mismatch requires review", () => {
        const reviewed = {
            ...prepared(),
            phase: "reviewRequired",
            headAfter: head,
            completion: {
                appliedChangeIds: ["change-1"],
                ownershipRevision: 4,
                draft: "copied",
                shelfPublication: "pending",
            },
        };
        expect(
            parseTargetOperationRecord(reviewed),
            "review cannot erase proof of the already copied draft",
        ).toEqual(reviewed);
        expect(parseTargetOperationRecord({ ...reviewed, headAfter: undefined })).toBeUndefined();
        expect(
            parseTargetOperationRecord({
                ...reviewed,
                completion: { ...reviewed.completion, shelfPublication: "notRequired" },
            }),
        ).toBeUndefined();
    });

    it("binds shelf completion to its kind, selection and removal policy", () => {
        const ownership = {
            appliedChangeIds: ["change-1"],
            ownershipRevision: 4,
            draft: "kept" as const,
            shelfPublication: "notRequired" as const,
        };
        const reusable = {
            ...prepared(),
            phase: "ownershipPublished" as const,
            headAfter: head,
            shelf: { ...prepared().shelf!, removeFromShelf: false },
            completion: ownership,
        };
        expect(parseTargetOperationRecord(reusable)).toEqual(reusable);
        expect(
            parseTargetOperationRecord({
                ...reusable,
                completion: { ...ownership, shelfPublication: "pending" },
            }),
            "a reusable shelf has no pending lifecycle publication",
        ).toBeUndefined();
        expect(
            parseTargetOperationRecord({
                ...reusable,
                completion: { ...ownership, appliedChangeIds: ["outside-selection"] },
            }),
            "ownership cannot publish an entry outside the captured shelf selection",
        ).toBeUndefined();
        expect(
            parseTargetOperationRecord({ ...prepared(), shelf: undefined }),
            "shelf restore requires an exact source shelf identity",
        ).toBeUndefined();
        expect(
            parseTargetOperationRecord({ ...prepared(), kind: "patchApply" }),
            "non-shelf operations cannot carry shelf lifecycle authority",
        ).toBeUndefined();
    });

    it("validates terminal receipts and projects no recovery evidence", () => {
        const receipt = {
            version: 1,
            id,
            requestHash: hash("a"),
            outcome: "applied" as const,
            evidenceHash: hash("b"),
        };
        expect(parseTargetOperationReceipt(receipt)).toEqual(receipt);
        expect(parseTargetOperationReceipt({ ...receipt, outcome: "aborted" })).toEqual({
            ...receipt,
            outcome: "aborted",
        });
        expect(parseTargetOperationReceipt({ ...receipt, outcome: "unknown" })).toBeUndefined();
        expect(summarizeTargetOperation(prepared())).toEqual({
            id,
            kind: "shelfRestore",
            phase: "prepared",
            destinationId,
        });
    });

    it("validates repository-bound path, index, native and object evidence", () => {
        const valid = evidence();
        expect(parseTargetOperationEvidence(valid, root, gitDir)).toEqual(valid);
        expect(targetOperationEvidenceReferences(valid)).toEqual([hash("e"), hash("9"), hash("f")]);
        expect(
            parseTargetOperationEvidence({ ...valid, root: "/other" }, root, gitDir),
        ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                { ...valid, paths: [{ ...valid.paths[0], path: "../outside" }] },
                root,
                gitDir,
            ),
        ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                { ...valid, index: [{ ...valid.index[0], stage: 4 }] },
                root,
                gitDir,
            ),
        ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                { ...valid, native: [{ name: "cherryPickHead", present: true }] },
                root,
                gitDir,
            ),
            "present native controls require an exact checksum",
        ).toBeUndefined();
    });

    it("validates concrete path and index-abort checkpoints", () => {
        const valid = evidence();
        const expectedCurrent = valid.paths[0].state;
        const abortPath = {
            path: "src/file.ts",
            recoveryPath: `.intelligit-recovery/${id}/src-file.ts`,
            expectedCurrent,
            desiredBefore: { kind: "absent" as const },
            move: { state: "moved" as const, observed: expectedCurrent },
            install: { state: "installed" as const, observed: { kind: "absent" as const } },
        };
        const identity = {
            device: "1",
            inode: "8",
            size: 32,
            modifiedNs: "9",
            changedNs: "10",
        };
        const abortIndex = {
            ...valid,
            checkpoint: "abortIndexPrepared",
            abortPaths: [abortPath],
            indexPublication: {
                state: "prepared",
                liveIndexFingerprint: hash("7"),
                candidate: {
                    path: `intelligit/target-operations/${id}/index.candidate`,
                    fingerprint: hash("8"),
                    identity,
                },
                lock: {
                    identity,
                    operationId: id,
                    owner: { pid: 123, processStart: "456" },
                },
            },
        };
        expect(parseTargetOperationEvidence(abortIndex, root, gitDir)).toEqual(abortIndex);
        expect(
            parseTargetOperationEvidence(
                {
                    ...abortIndex,
                    indexPublication: {
                        ...abortIndex.indexPublication,
                        lock: { ...abortIndex.indexPublication.lock, operationId: destinationId },
                    },
                },
                root,
                gitDir,
            ),
            "index lock recovery remains bound to the exact operation",
        ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                {
                    ...abortIndex,
                    abortPaths: [{ ...abortPath, recoveryPath: "../foreign" }],
                },
                root,
                gitDir,
            ),
            "recovery paths cannot escape the worktree-bound namespace",
        ).toBeUndefined();
    });

    it("requires one private recovery destination per affected path", () => {
        const valid = evidence();
        const abortPath = {
            path: "src/file.ts",
            recoveryPath: `.intelligit-recovery/${id}/shared`,
            expectedCurrent: valid.paths[0].state,
            desiredBefore: { kind: "absent" as const },
            move: { state: "planned" as const },
            install: { state: "pending" as const },
        };
        expect(
            parseTargetOperationEvidence(
                {
                    ...valid,
                    checkpoint: "abortPrepared",
                    paths: [valid.paths[0], { ...valid.paths[0], path: "src/other.ts" }],
                    abortPaths: [abortPath, { ...abortPath, path: "src/other.ts" }],
                },
                root,
                gitDir,
            ),
            "two paths cannot overwrite one recovery destination",
        ).toBeUndefined();
    });

    it("requires exact Git object identifier lengths", () => {
        const valid = evidence();
        expect(
            parseTargetOperationEvidence(
                {
                    ...valid,
                    index: [{ ...valid.index[0], oid: "1".repeat(41) }],
                },
                root,
                gitDir,
            ),
        ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                {
                    ...valid,
                    index: [{ ...valid.index[0], oid: "1".repeat(63) }],
                },
                root,
                gitDir,
            ),
        ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                {
                    ...valid,
                    index: [{ ...valid.index[0], oid: "1".repeat(64) }],
                },
                root,
                gitDir,
            ),
        ).toBeDefined();
    });
});
