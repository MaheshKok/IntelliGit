// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Commit, CommitDetail } from "../../../src/types";

// The sidebar graph (`NativeCommitGraph`) rings whichever row matches the `selectedHash` it hands
// `CommitList`. Capturing that prop reads the ring without laying out a virtualized list in jsdom.
const list = vi.hoisted(() => ({
    selectedHash: undefined as string | null | undefined,
    onSelectCommit: (_hash: string): void => undefined,
}));

vi.mock("../../../src/webviews/react/CommitList", () => ({
    CommitList: (props: {
        selectedHash: string | null;
        onSelectCommit: (hash: string) => void;
    }) => {
        list.selectedHash = props.selectedHash;
        list.onSelectCommit = props.onSelectCommit;
        return null;
    },
}));

import { NativeCommitGraph } from "../../../src/webviews/react/NativeCommitGraph";

function makeCommit(hash: string): Commit {
    return {
        hash,
        shortHash: hash,
        message: `commit ${hash}`,
        author: "Mahesh",
        email: "m@example.com",
        date: "2026-02-19T00:00:00Z",
        parentHashes: ["parent"],
        refs: [],
    };
}

function makeDetail(hash: string): CommitDetail {
    return { ...makeCommit(hash), body: "", files: [] };
}

function send(data: unknown): void {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });
}

function page(...hashes: string[]) {
    return { type: "loadCommits", append: false, hasMore: false, commits: hashes.map(makeCommit) };
}

async function mount() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const postMessage = vi.fn();
    const vscode = { postMessage } as unknown as React.ComponentProps<
        typeof NativeCommitGraph
    >["vscode"];
    await act(async () => {
        root.render(<NativeCommitGraph vscode={vscode} sendReady={false} />);
    });
    const unmount = async () => {
        await act(async () => {
            root.unmount();
        });
        host.remove();
    };
    return { postMessage, unmount };
}

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
});

// #246: the host fans one commit's detail out to every commit list. A list still ringing its own
// older pick showed a second selection ring beside the row whose changed files were on screen.
describe("NativeCommitGraph selection shared with other commit lists (#246)", () => {
    it("moves its ring to a commit picked in another list, instead of keeping its own older pick", async () => {
        const { unmount } = await mount();
        try {
            send(page("aa11", "bb22"));
            act(() => list.onSelectCommit("bb22"));
            send({ type: "setCommitDetail", detail: makeDetail("cc33") });
            expect(
                list.selectedHash,
                "the sidebar graph kept ringing bb22 while the detail pane showed cc33, so two " +
                    "commit lists showed a selection ring at once",
            ).toBe("cc33");
        } finally {
            await unmount();
        }
    });

    it("does not take the detail pane back on refresh when the picked commit is not in its own list", async () => {
        const { postMessage, unmount } = await mount();
        try {
            send(page("aa11", "bb22"));
            act(() => list.onSelectCommit("bb22"));
            postMessage.mockClear();
            // One act: the refresh lands before React renders the adopted pick, as two back-to-back
            // host messages can in the real webview.
            act(() => {
                for (const data of [
                    { type: "setCommitDetail", detail: makeDetail("cc33") },
                    page("aa11", "bb22"),
                ]) {
                    window.dispatchEvent(new MessageEvent("message", { data }));
                }
            });
            expect(
                postMessage,
                "a refresh replaced another list's pick with this list's first row and re-selected " +
                    "it, pulling the detail pane away from the commit the user clicked",
            ).not.toHaveBeenCalledWith(expect.objectContaining({ type: "selectCommit" }));
            expect(
                list.selectedHash,
                "a refresh arriving before the next render judged the list's old pick, not the " +
                    "commit another list had just selected",
            ).toBe("cc33");
        } finally {
            await unmount();
        }
    });

    it("still falls back to its first row when its own pick disappears from a refresh", async () => {
        const { postMessage, unmount } = await mount();
        try {
            send(page("aa11", "bb22"));
            act(() => list.onSelectCommit("bb22"));
            postMessage.mockClear();
            send(page("aa11"));
            expect(
                postMessage,
                "the keep-another-list's-pick rule swallowed this list's own vanished pick, leaving " +
                    "the detail pane on a commit the list no longer has",
            ).toHaveBeenCalledWith({ type: "selectCommit", hash: "aa11" });
        } finally {
            await unmount();
        }
    });

    it("keeps another list's pick of a commit it showed only before an earlier refresh", async () => {
        const { postMessage, unmount } = await mount();
        try {
            send(page("aa11", "bb22"));
            send(page("aa11"));
            send({ type: "setCommitDetail", detail: makeDetail("bb22") });
            postMessage.mockClear();
            send(page("aa11"));
            expect(
                postMessage,
                "the list judged bb22 by a page it no longer shows, so another list's pick of bb22 " +
                    "was taken back on the next refresh",
            ).not.toHaveBeenCalledWith(expect.objectContaining({ type: "selectCommit" }));
        } finally {
            await unmount();
        }
    });
});
