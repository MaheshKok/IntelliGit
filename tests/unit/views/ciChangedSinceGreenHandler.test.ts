// Host side of "Changed since last green" (PLAN.md §14): the file list a failed job's detail
// asks for, and the two-revision diff a file in it opens.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import { CiGenerations } from "../../../src/services/commitChecks/ciGenerations";
import type { ChangedSinceGreen } from "../../../src/services/commitChecks/changedSinceGreen";
import type { CommitCiDetailSource } from "../../../src/views/ciDetailHandler";
import {
    answerChangedSinceGreenRequest,
    answerOpenCiRangeDiff,
} from "../../../src/views/ciChangedSinceGreenHandler";
import type { ChangedSinceGreenMessage } from "../../../src/webviews/protocol/commitCiMessages";

// The hash validator lives in a module that imports the VS Code API.
vi.mock("vscode", () => ({}));

const HASH = "a".repeat(40);
const GREEN = "b".repeat(40);
const REPO = "/repo";
const FOUND: ChangedSinceGreen = {
    lastGreen: GREEN,
    files: [{ path: "src/a.ts", status: "M" }],
};

function source(walk = vi.fn(async () => FOUND as ChangedSinceGreen | undefined)) {
    const openRangeDiff = vi.fn(async () => undefined);
    const s: CommitCiDetailSource = {
        repoKey: () => REPO,
        generations: new CiGenerations(),
        getDetail: vi.fn(),
        changedSinceGreen: walk,
        openRangeDiff,
    };
    return { source: s, walk, openRangeDiff };
}

function request(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: "requestChangedSinceGreen",
        requestId: 7,
        repoKey: REPO,
        hash: HASH,
        logicalCheckId: "job\0ci\0test",
        scopeName: "ci",
        checkName: "test",
        loaded: [
            { hash: HASH, parents: [GREEN] },
            { hash: GREEN, parents: [] },
        ],
        ...extra,
    };
}

function openRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: "openCiRangeDiff",
        requestId: 8,
        repoKey: REPO,
        fromRev: GREEN,
        toRev: HASH,
        path: "src/new name.ts",
        oldPath: "src/old.ts",
        status: "R",
        ...extra,
    };
}

describe("answerChangedSinceGreenRequest", () => {
    beforeEach(() => setE2eControlChannelActive(true));
    afterEach(() => setE2eControlChannelActive(false));

    it("answers with the last green commit and the files changed since", async () => {
        const { source: s, walk } = source();
        const post = vi.fn<(reply: ChangedSinceGreenMessage) => void>();
        await answerChangedSinceGreenRequest(s, request(), post);
        expect(walk).toHaveBeenCalledWith(
            {
                hash: HASH,
                logicalCheckId: "job\0ci\0test",
                scopeName: "ci",
                checkName: "test",
                loaded: [
                    { hash: HASH, parents: [GREEN] },
                    { hash: GREEN, parents: [] },
                ],
            },
            REPO,
        );
        expect(post).toHaveBeenCalledWith({
            type: "changedSinceGreen",
            requestId: 7,
            repoKey: REPO,
            hash: HASH,
            logicalCheckId: "job\0ci\0test",
            scopeName: "ci",
            checkName: "test",
            ...FOUND,
        });
    });

    it("posts a Git failure as the reply's error", async () => {
        const { source: s } = source(
            vi.fn(async () => {
                throw new Error("bad object");
            }),
        );
        const post = vi.fn();
        await answerChangedSinceGreenRequest(s, request(), post);
        expect(post).toHaveBeenCalledWith(
            expect.objectContaining({ lastGreen: null, error: "bad object", files: [] }),
        );
    });

    it("answers nothing while the switch is off", async () => {
        setE2eControlChannelActive(false);
        const { source: s, walk } = source();
        const post = vi.fn();
        await answerChangedSinceGreenRequest(s, request(), post);
        expect(walk).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it("drops a request for another repository", async () => {
        const { source: s, walk } = source();
        const post = vi.fn();
        await answerChangedSinceGreenRequest(s, request({ repoKey: "/other" }), post);
        expect(walk).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it("drops the answer when the sign-in changed while it was read", async () => {
        const generations = new CiGenerations();
        const walk = vi.fn(async () => {
            generations.bumpAuth();
            return FOUND;
        });
        const s: CommitCiDetailSource = { ...source(walk).source, generations };
        const post = vi.fn();
        await answerChangedSinceGreenRequest(s, request(), post);
        expect(walk).toHaveBeenCalledTimes(1);
        expect(post).not.toHaveBeenCalled();
    });

    it("a disabled feature (undefined walk result) answers nothing", async () => {
        const { source: s } = source(vi.fn(async () => undefined));
        const post = vi.fn();
        await answerChangedSinceGreenRequest(s, request(), post);
        expect(post).not.toHaveBeenCalled();
    });

    it.each([
        ["request id", { requestId: "7" }],
        ["repository", { repoKey: 1 }],
        ["hash", { hash: "--output=x" }],
        ["logical id", { logicalCheckId: 3 }],
        ["check name", { checkName: null }],
        ["scope", { scopeName: 4 }],
        ["loaded list", { loaded: HASH }],
        ["loaded parent", { loaded: [{ hash: HASH, parents: ["-x"] }] }],
    ])("rejects a malformed %s", async (_name, extra) => {
        const { source: s, walk } = source();
        await expect(answerChangedSinceGreenRequest(s, request(extra), vi.fn())).rejects.toThrow();
        expect(walk).not.toHaveBeenCalled();
    });
});

describe("answerOpenCiRangeDiff", () => {
    beforeEach(() => setE2eControlChannelActive(true));
    afterEach(() => setE2eControlChannelActive(false));

    it("opens the file's diff between the two revisions", async () => {
        const { source: s, openRangeDiff } = source();
        await answerOpenCiRangeDiff(s, openRequest());
        expect(openRangeDiff).toHaveBeenCalledWith(GREEN, HASH, {
            path: "src/new name.ts",
            oldPath: "src/old.ts",
            status: "R",
        });
    });

    it("answers nothing while the switch is off", async () => {
        setE2eControlChannelActive(false);
        const { source: s, openRangeDiff } = source();
        await answerOpenCiRangeDiff(s, openRequest());
        expect(openRangeDiff).not.toHaveBeenCalled();
    });

    it("drops a request for another repository", async () => {
        const { source: s, openRangeDiff } = source();
        await answerOpenCiRangeDiff(s, openRequest({ repoKey: "/other" }));
        expect(openRangeDiff).not.toHaveBeenCalled();
    });

    it.each([
        ["request id", { requestId: 1.5 }],
        ["from revision", { fromRev: "HEAD~1" }],
        ["to revision", { toRev: "--upload-pack=x" }],
        ["path", { path: "" }],
        ["old path", { oldPath: 5 }],
        ["status", { status: "X" }],
    ])("rejects a malformed %s", async (_name, extra) => {
        const { source: s, openRangeDiff } = source();
        await expect(answerOpenCiRangeDiff(s, openRequest(extra))).rejects.toThrow();
        expect(openRangeDiff).not.toHaveBeenCalled();
    });
});
