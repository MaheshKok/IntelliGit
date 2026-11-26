// @vitest-environment jsdom
// "Find where CI broke" in the Changed Files view (PLAN.md section 13): a repository switch
// retires the bisect the webview shows even while its Checks tab is unmounted, so returning to the
// first repository restores neither its progress nor its late result.

import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CommitDetail } from "../../../src/types";
import { initReactDomTestEnvironment } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const api = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();

const [A, B] = ["a", "b"].map((letter) => letter.repeat(40));
const RANGE = [
    { hash: A, parents: [B] },
    { hash: B, parents: [] },
];
const detail: CommitDetail = {
    hash: A,
    shortHash: A.slice(0, 7),
    message: "Build",
    author: "Test",
    email: "test@example.com",
    date: "2026-11-07T12:00:00.000Z",
    parentHashes: [B],
    refs: [],
    body: "",
    files: [],
};
const host = document.createElement("div");
const send = (data: unknown): void =>
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });
const show = (repoKey: string): void =>
    send({ type: "setCommitDetail", detail, ciRepoKey: repoKey, commitChecksEnabled: true });

function startInChecks(repoKey: string): number {
    api.postMessage.mockClear();
    send({ type: "startCiBisectInChecks", repoKey, commits: RANGE });
    const start = api.postMessage.mock.calls
        .map(([message]) => message as { type: string; requestId: number })
        .find(({ type }) => type === "startCiBisect");
    if (!start) throw new Error("No startCiBisect was posted");
    return start.requestId;
}

beforeAll(async () => {
    installWebviewI18n();
    window.intelligitE2E = true;
    host.id = "root";
    document.body.appendChild(host);
    await act(async () => {
        await import("../../../src/webviews/react/CommitInfoApp");
    });
});

describe("CI bisect across a repository switch", () => {
    it("never restores progress or a late result after A to B to A with nothing shown in B", () => {
        show("/A");
        const requestId = startInChecks("/A");
        expect(host.textContent).toContain("0 / 2 commits");

        // The switch clears the pane twice and B never shows a commit: the Checks tab is unmounted.
        send({ type: "clear", ciRepoKey: "/B" });
        send({ type: "clear", ciRepoKey: "/A" });
        show("/A");
        expect(
            host.textContent,
            "the Checks tab must not restore the progress of a retired A run",
        ).not.toContain("0 / 2 commits");

        send({
            type: "ciBisectResult",
            requestId,
            repoKey: "/A",
            linear: true,
            commits: [B, A],
            jobs: [],
        });
        expect(
            host.querySelector('[data-testid="ci-bisect"]'),
            "the late result is dropped",
        ).toBeNull();
    });

    it("keeps the bisect through a clear that stays in the same repository", () => {
        show("/A");
        startInChecks("/A");
        // A branch filter clears the pane while the repository stays A.
        send({ type: "clear", loading: true, ciRepoKey: "/A" });
        show("/A");
        expect(host.textContent).toContain("0 / 2 commits");
        send({ type: "clear", ciRepoKey: "/B" });
    });
});
