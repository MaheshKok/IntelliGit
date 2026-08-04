// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useExtensionMessages } from "../../../src/webviews/react/commit-panel/hooks/useExtensionMessages";
import type { MultiRepositoryCommitPanelState } from "../../../src/webviews/react/commit-panel/types";

const postMessage = vi.fn();
let latestState: MultiRepositoryCommitPanelState;

vi.mock("../../../src/webviews/react/commit-panel/hooks/useVsCodeApi", () => ({
    getVsCodeApi: () => ({ postMessage }),
}));

function Harness(): null {
    [latestState] = useExtensionMessages();
    return null;
}

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
});

afterEach(() => {
    postMessage.mockReset();
    document.body.innerHTML = "";
});

function stateFor(root: string): MultiRepositoryCommitPanelState["repositories"][number] {
    const state = latestState.repositories.find((candidate) => candidate.root === root);
    if (!state) throw new Error(`Missing repository state for ${root}`);
    return state;
}

function send(data: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data }));
}

/** Builds an `update` payload that carries only the fields this suite reasons about. */
function update(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        type: "update",
        repositoryRoot: "/repo",
        files: [],
        stashes: [],
        stashFiles: [],
        selectedStashIndex: null,
        currentBranchName: "main",
        ...overrides,
    };
}

async function renderHarness(): Promise<{ root: Root; host: HTMLDivElement }> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(<Harness />);
    });
    await act(async () => {
        send({
            type: "setRepositories",
            repositories: [
                { root: "/repo", label: "Repo", kind: "repository", changedFileCount: 0 },
            ],
            activeRepositoryRoot: "/repo",
        });
    });
    postMessage.mockClear();
    return { root, host };
}

describe("commit-panel operation snapshot", () => {
    it("keeps the rebase classification across an update that omits it", async () => {
        const { root, host } = await renderHarness();
        try {
            await act(async () => {
                send(update({ activeOperation: "rebase", rebaseControl: "owned" }));
            });
            expect(stateFor("/repo").activeOperation).toBe("rebase");
            expect(stateFor("/repo").rebaseControl).toBe("owned");

            // A refresh triggered by something unrelated — a file watcher, a stash listing —
            // is a partial update. Treating its absent classification as "no rebase" would
            // make the Continue/Abort controls disappear mid-rebase.
            await act(async () => {
                send(update({ changedFileCount: 3 }));
            });
            expect(stateFor("/repo").activeOperation).toBe("rebase");
            expect(stateFor("/repo").rebaseControl).toBe("owned");
        } finally {
            await act(async () => root.unmount());
            host.remove();
        }
    });

    it("clears the ownership when the host reports the rebase has ended", async () => {
        const { root, host } = await renderHarness();
        try {
            await act(async () => {
                send(update({ activeOperation: "rebase", rebaseControl: "foreign" }));
            });
            expect(stateFor("/repo").rebaseControl).toBe("foreign");

            // The pair moves together: preserving `rebaseControl` field-by-field would strand
            // a finished rebase's ownership behind the new operation and keep Abort Rebase
            // rendered after the rebase is gone.
            await act(async () => {
                send(update({ activeOperation: "none" }));
            });
            expect(stateFor("/repo").activeOperation).toBe("none");
            expect(stateFor("/repo").rebaseControl).toBeUndefined();
        } finally {
            await act(async () => root.unmount());
            host.remove();
        }
    });
});
