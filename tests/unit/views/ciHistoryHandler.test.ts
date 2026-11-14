// Host side of the Checks tab's history request: the parent and default-tip snapshots the
// tags are computed from, answered only for the repository and world the request started in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import { CiGenerations } from "../../../src/services/commitChecks/ciGenerations";
import type { CiHistory } from "../../../src/shared/ci/history";
import type { CommitCiDetailSource } from "../../../src/views/ciDetailHandler";
import { answerCiHistoryRequest } from "../../../src/views/ciHistoryHandler";
import type { CiHistoryMessage } from "../../../src/webviews/protocol/commitCiMessages";

// The hash validator lives in a module that imports the VS Code API.
vi.mock("vscode", () => ({}));

const HASH = "a".repeat(40);
const PARENT = "b".repeat(40);
const REPO = "/repo";
const HISTORY: CiHistory = {
    parent: { hash: PARENT, items: [] },
    defaultBranch: { name: "trunk", tipHash: "c".repeat(40), items: null },
};

function source(history = vi.fn(async (_parents: readonly string[]) => HISTORY)) {
    const s: CommitCiDetailSource = {
        repoKey: () => REPO,
        generations: new CiGenerations(),
        getDetail: vi.fn(),
        history,
    };
    return { source: s, history };
}

function request(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: "requestCiHistory",
        requestId: 4,
        repoKey: REPO,
        hash: HASH,
        parents: [PARENT],
        ...extra,
    };
}

describe("answerCiHistoryRequest", () => {
    beforeEach(() => setE2eControlChannelActive(true));
    afterEach(() => setE2eControlChannelActive(false));

    it("answers with the parent and default-tip snapshots under the request's id", async () => {
        const { source: s, history } = source();
        const post = vi.fn<(reply: CiHistoryMessage) => void>();
        await answerCiHistoryRequest(s, request({ parents: [PARENT, "d".repeat(40)] }), post);
        expect(history).toHaveBeenCalledWith([PARENT, "d".repeat(40)]);
        expect(post).toHaveBeenCalledWith({
            type: "ciHistory",
            requestId: 4,
            repoKey: REPO,
            hash: HASH,
            ...HISTORY,
        });
    });

    it("answers nothing while the switch is off", async () => {
        setE2eControlChannelActive(false);
        const { source: s, history } = source();
        const post = vi.fn();
        await answerCiHistoryRequest(s, request(), post);
        expect(history).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it("drops a request for another repository", async () => {
        const { source: s, history } = source();
        const post = vi.fn();
        await answerCiHistoryRequest(s, request({ repoKey: "/other" }), post);
        expect(history).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it("drops the answer when the sign-in changed while it was read", async () => {
        const generations = new CiGenerations();
        const history = vi.fn(async () => {
            generations.bumpAuth();
            return HISTORY;
        });
        const s: CommitCiDetailSource = { ...source(history).source, generations };
        const post = vi.fn();
        await answerCiHistoryRequest(s, request(), post);
        expect(history).toHaveBeenCalledTimes(1);
        expect(post).not.toHaveBeenCalled();
    });

    it("drops the answer when the repository changed while it was read", async () => {
        let repo = REPO;
        const history = vi.fn(async () => {
            repo = "/other";
            return HISTORY;
        });
        const s: CommitCiDetailSource = { ...source(history).source, repoKey: () => repo };
        const post = vi.fn();
        await answerCiHistoryRequest(s, request(), post);
        expect(post).not.toHaveBeenCalled();
    });

    it("a host without history answers nothing", async () => {
        const { source: s } = source();
        const post = vi.fn();
        await answerCiHistoryRequest({ ...s, history: undefined }, request(), post);
        expect(post).not.toHaveBeenCalled();
    });

    it.each([
        ["request id", { requestId: "4" }],
        ["repository", { repoKey: 1 }],
        ["hash", { hash: "not-a-hash" }],
        ["parents", { parents: PARENT }],
        ["parent hash", { parents: ["--upload-pack=x"] }],
    ])("rejects a malformed %s", async (_name, extra) => {
        const { source: s, history } = source();
        await expect(answerCiHistoryRequest(s, request(extra), vi.fn())).rejects.toThrow();
        expect(history).not.toHaveBeenCalled();
    });
});
