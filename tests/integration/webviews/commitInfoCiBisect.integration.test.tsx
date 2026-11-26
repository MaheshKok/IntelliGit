// @vitest-environment jsdom
// The Changed Files view runs "Find where CI broke" for the compact Git Log (owner 2026-11-24,
// "compact now"): the host's `startCiBisectInChecks` starts the bisect in this view's Checks tab.

import { act } from "react";
import { expect, it, vi } from "vitest";
import type { CommitDetail } from "../../../src/types";
import { initReactDomTestEnvironment } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const mockVscodeApi = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn((): unknown => undefined),
    setState: vi.fn(),
}));

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => mockVscodeApi,
}));

initReactDomTestEnvironment();

const SHOWN = "a".repeat(40);
const REPO = "/repo";
const detail: CommitDetail = {
    hash: SHOWN,
    shortHash: SHOWN.slice(0, 7),
    message: "Fix the build",
    author: "Mahesh Kokare",
    email: "mahesh@example.com",
    date: "2026-11-07T12:00:00.000Z",
    parentHashes: [],
    refs: [],
    body: "",
    files: [],
};
const commits = [
    { hash: SHOWN, parents: ["b".repeat(40)] },
    { hash: "b".repeat(40), parents: ["c".repeat(40)] },
];

it("starts the sidebar graph's bisect in the Checks tab and shows its progress", async () => {
    installWebviewI18n();
    window.intelligitE2E = true;
    const host = document.createElement("div");
    host.id = "root";
    document.body.appendChild(host);
    vi.resetModules();
    await act(async () => {
        await import("../../../src/webviews/react/CommitInfoApp");
    });
    const send = (data: unknown): void =>
        act(() => {
            window.dispatchEvent(new MessageEvent("message", { data }));
        });

    send({ type: "setCommitDetail", detail, ciRepoKey: REPO, commitChecksEnabled: true });
    send({ type: "startCiBisectInChecks", repoKey: REPO, commits });

    expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
        type: "startCiBisect",
        requestId: expect.any(Number),
        repoKey: REPO,
        commits,
    });
    expect(
        host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
        "the view switched to Checks",
    ).toBe("Checks");
    expect(
        host.querySelector('[data-testid="ci-bisect-cancel"]'),
        "progress with Cancel",
    ).not.toBeNull();
});
