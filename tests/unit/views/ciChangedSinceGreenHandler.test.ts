// Host side of "Changed since last green" (PLAN.md §14): the file list a failed job's detail
// asks for, and the two-revision diff a file in it opens.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import { CiGenerations } from "../../../src/services/commitChecks/ciGenerations";
import type { ChangedSinceGreen } from "../../../src/services/commitChecks/changedSinceGreen";
import { openRevisionRangeFileDiff } from "../../../src/services/diffService";
import type { CommitCiDetailSource } from "../../../src/views/ciDetailHandler";
import {
    answerChangedSinceGreenRequest,
    answerOpenCiRangeDiff,
    CiRangeDiffGrant,
} from "../../../src/views/ciChangedSinceGreenHandler";
import type { ChangedSinceGreenMessage } from "../../../src/webviews/protocol/commitCiMessages";

// The real range-diff opener builds read-only documents and runs `vscode.diff`.
vi.mock("vscode", () => ({
    Uri: {
        from: (components: { scheme: string; path: string; query?: string }) => components,
        file: (fsPath: string) => ({ fsPath, scheme: "file", path: fsPath }),
    },
    env: { language: "en" },
    l10n: { t: (text: string) => text },
    commands: { executeCommand: vi.fn() },
    window: {},
    workspace: {
        registerTextDocumentContentProvider: vi.fn(),
        onDidCloseTextDocument: vi.fn(),
    },
}));

const HASH = "a".repeat(40);
const GREEN = "b".repeat(40);
const REPO = "/repo";
const FOUND: ChangedSinceGreen = {
    lastGreen: GREEN,
    files: [
        { path: "src/new name.ts", oldPath: "src/old.ts", status: "R", additions: 1, deletions: 0 },
    ],
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

    it.each([
        ["with generations", new CiGenerations()],
        ["without generations", undefined],
    ])(
        "drops the answer when the repository changed during the walk, %s",
        async (_name, generations) => {
            let repo = REPO;
            const walk = vi.fn(async () => {
                repo = "/other";
                return FOUND;
            });
            const s: CommitCiDetailSource = {
                ...source(walk).source,
                repoKey: () => repo,
                generations,
            };
            const post = vi.fn();
            await answerChangedSinceGreenRequest(s, request(), post);
            expect(walk).toHaveBeenCalledTimes(1);
            expect(
                post,
                "an answer for the repository left behind is never posted",
            ).not.toHaveBeenCalled();
        },
    );

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

/** A grant holding the answer a host posted for `request()`, as the hosts record it. */
async function granted(s: CommitCiDetailSource, extra: Record<string, unknown> = {}) {
    const grant = new CiRangeDiffGrant();
    await answerChangedSinceGreenRequest(s, request(extra), (reply) => grant.record(reply));
    return grant;
}

describe("answerOpenCiRangeDiff", () => {
    beforeEach(() => setE2eControlChannelActive(true));
    afterEach(() => setE2eControlChannelActive(false));

    it("opens the file's diff between the two revisions", async () => {
        const { source: s, openRangeDiff } = source();
        await answerOpenCiRangeDiff(s, openRequest(), await granted(s));
        expect(openRangeDiff).toHaveBeenCalledWith(GREEN, HASH, {
            path: "src/new name.ts",
            oldPath: "src/old.ts",
            status: "R",
        });
    });

    it("answers nothing while the switch is off", async () => {
        const { source: s, openRangeDiff } = source();
        const grant = await granted(s);
        setE2eControlChannelActive(false);
        await answerOpenCiRangeDiff(s, openRequest(), grant);
        expect(openRangeDiff).not.toHaveBeenCalled();
    });

    it("drops a request for another repository", async () => {
        const { source: s, openRangeDiff } = source();
        await answerOpenCiRangeDiff(s, openRequest({ repoKey: "/other" }), await granted(s));
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
        const grant = await granted(s);
        await expect(answerOpenCiRangeDiff(s, openRequest(extra), grant)).rejects.toThrow();
        expect(openRangeDiff).not.toHaveBeenCalled();
    });
});

// Steer 2 (owner answer 2026-11-16): a webview may open only a pair the host itself sent it in
// its latest answer. Each case runs the real opener, so a refusal is proven by Git never read.
describe("openCiRangeDiff opens only what the latest answer listed", () => {
    beforeEach(() => setE2eControlChannelActive(true));
    afterEach(() => setE2eControlChannelActive(false));

    function gitSource(repoKey = () => REPO, walk = vi.fn(async () => FOUND)) {
        const getFileContentAtRef = vi.fn(async () => "");
        const s: CommitCiDetailSource = {
            ...source(walk).source,
            repoKey,
            openRangeDiff: (fromRev, toRev, file) =>
                openRevisionRangeFileDiff(fromRev, toRev, file, { getFileContentAtRef }),
        };
        return { source: s, getFileContentAtRef };
    }

    it("the control: the listed file opens and both sides are read from Git", async () => {
        const { source: s, getFileContentAtRef } = gitSource();
        await answerOpenCiRangeDiff(s, openRequest(), await granted(s));
        expect(getFileContentAtRef, "a listed pair opens").toHaveBeenCalledTimes(2);
    });

    it("refuses a path the latest answer did not list", async () => {
        const { source: s, getFileContentAtRef } = gitSource();
        const grant = await granted(s);
        // The listed rename with only its destination changed.
        await answerOpenCiRangeDiff(s, openRequest({ path: ".env" }), grant);
        await answerOpenCiRangeDiff(
            s,
            openRequest({ path: ".env", oldPath: undefined, status: "M" }),
            grant,
        );
        await answerOpenCiRangeDiff(s, openRequest({ oldPath: "secrets.txt" }), grant);
        await answerOpenCiRangeDiff(s, openRequest({ status: "M", oldPath: undefined }), grant);
        expect(getFileContentAtRef, "an unlisted path is never read").not.toHaveBeenCalled();
    });

    it("refuses a short hash of the listed revisions", async () => {
        const { source: s, getFileContentAtRef } = gitSource();
        const grant = await granted(s);
        await answerOpenCiRangeDiff(s, openRequest({ fromRev: GREEN.slice(0, 12) }), grant);
        await answerOpenCiRangeDiff(s, openRequest({ toRev: HASH.slice(0, 7) }), grant);
        expect(
            getFileContentAtRef,
            "a short hash is not the pair the host sent",
        ).not.toHaveBeenCalled();
    });

    it("refuses a pair from an older answer once a newer one was sent", async () => {
        const newer = "c".repeat(40);
        const walk = vi
            .fn(async (): Promise<ChangedSinceGreen> => FOUND)
            .mockResolvedValueOnce(FOUND)
            .mockResolvedValueOnce({
                lastGreen: newer,
                files: [{ path: "src/other.ts", status: "M", additions: 2, deletions: 1 }],
            });
        const { source: s, getFileContentAtRef } = gitSource(() => REPO, walk);
        const grant = await granted(s);
        await answerChangedSinceGreenRequest(s, request(), (reply) => grant.record(reply));
        await answerOpenCiRangeDiff(s, openRequest(), grant);
        expect(getFileContentAtRef, "the older answer's pair is never read").not.toHaveBeenCalled();
        await answerOpenCiRangeDiff(
            s,
            openRequest({ fromRev: newer, path: "src/other.ts", oldPath: undefined, status: "M" }),
            grant,
        );
        expect(
            getFileContentAtRef,
            "the control: the newer answer's pair opens",
        ).toHaveBeenCalledTimes(2);
    });

    it("keeps the newest request's file list openable when an older reply arrives last", async () => {
        const newer = "c".repeat(40);
        const answers = new Map<number, (found: ChangedSinceGreen) => void>();
        const walk = vi.fn(
            (_request: unknown, _repoKey: string) =>
                new Promise<ChangedSinceGreen>((resolve) => {
                    answers.set(answers.size, resolve);
                }),
        );
        const { source: s, getFileContentAtRef } = gitSource(() => REPO, walk);
        const grant = new CiRangeDiffGrant();
        const older = answerChangedSinceGreenRequest(s, request({ requestId: 7 }), (reply) =>
            grant.record(reply),
        );
        const newest = answerChangedSinceGreenRequest(s, request({ requestId: 9 }), (reply) =>
            grant.record(reply),
        );
        // The newest request finishes first; the older one finishes last and must not replace it.
        answers.get(1)?.({
            lastGreen: newer,
            files: [{ path: "src/other.ts", status: "M", additions: 2, deletions: 1 }],
        });
        await newest;
        answers.get(0)?.(FOUND);
        await older;
        await answerOpenCiRangeDiff(
            s,
            openRequest({ fromRev: newer, path: "src/other.ts", oldPath: undefined, status: "M" }),
            grant,
        );
        expect(
            getFileContentAtRef,
            "the newest displayed answer must remain openable after an older reply arrives",
        ).toHaveBeenCalledTimes(2);
    });

    it("refuses a listed file opened under another valid status", async () => {
        const walk = vi.fn(async (): Promise<ChangedSinceGreen> => ({
            lastGreen: GREEN,
            files: [{ path: "src/a.ts", status: "M", additions: 1, deletions: 1 }],
        }));
        const { source: s, getFileContentAtRef } = gitSource(() => REPO, walk);
        const grant = await granted(s);
        await answerOpenCiRangeDiff(
            s,
            openRequest({ path: "src/a.ts", oldPath: undefined, status: "D" }),
            grant,
        );
        expect(
            getFileContentAtRef,
            "a status the host did not list is never read",
        ).not.toHaveBeenCalled();
    });

    it("refuses every pair after the webview is retired", async () => {
        const { source: s, getFileContentAtRef } = gitSource();
        const grant = await granted(s);
        grant.clear();
        await answerOpenCiRangeDiff(s, openRequest(), grant);
        expect(
            getFileContentAtRef,
            "a retired webview's pair is never read",
        ).not.toHaveBeenCalled();
    });

    it("drops the record when another repository checks it, so a switch back finds nothing", async () => {
        const grant = new CiRangeDiffGrant();
        grant.record({
            type: "changedSinceGreen",
            requestId: 7,
            repoKey: REPO,
            hash: HASH,
            logicalCheckId: "job\0ci\0test",
            scopeName: "ci",
            checkName: "test",
            ...FOUND,
        });
        const listed = FOUND.files[0];
        expect(grant.allows("/other", GREEN, HASH, listed), "another repository").toBe(false);
        expect(
            grant.allows(REPO, GREEN, HASH, listed),
            "the record the other repository's check dropped",
        ).toBe(false);
    });

    it("refuses the old repository's pair after a repository switch", async () => {
        let repo = REPO;
        const { source: s, getFileContentAtRef } = gitSource(() => repo);
        const grant = await granted(s);
        repo = "/other";
        await answerOpenCiRangeDiff(s, openRequest({ repoKey: "/other" }), grant);
        expect(
            getFileContentAtRef,
            "a pair listed for another repository is never read",
        ).not.toHaveBeenCalled();
    });
});
