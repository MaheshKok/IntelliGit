// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import type { Commit, CommitDetail } from "../../../src/types";
import { CommitGraphPanel } from "../../../src/webviews/react/CommitGraphPanel";
import { NativeCommitGraph } from "../../../src/webviews/react/NativeCommitGraph";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";

initReactDomTestEnvironment();

/**
 * #226: the sidebar and bottom graphs share the details panes, so the blue selected-row ring
 * follows the commit whose changed files are on show. Every graph that lists that commit rings
 * it -- both graphs ring it when both list it -- and a graph that does not list it shows no
 * ring. Refreshes must never move a ring onto another row, and never pull the details back to a
 * graph that does not hold the shown commit.
 */

function commit(hash: string, parentHashes: string[]): Commit {
    return {
        hash,
        shortHash: hash.slice(0, 7),
        message: `Commit ${hash.slice(0, 7)}`,
        author: "Ada",
        email: "ada@example.com",
        date: "2026-01-01T00:00:00Z",
        parentHashes,
        refs: [],
    };
}

function detail(hash: string): CommitDetail {
    return { ...commit(hash, []), body: "", files: [] };
}

const tip = commit("b".repeat(40), ["a".repeat(40)]);
const parent = commit("a".repeat(40), []);
/** A commit neither page below lists, standing in for a pick made in a list these graphs share. */
const unlisted = "c".repeat(40);

const page = {
    type: "loadCommits",
    commits: [tip, parent],
    hasMore: false,
    append: false,
    unpushedHashes: [],
};

function send(data: unknown): void {
    act(() => window.dispatchEvent(new MessageEvent("message", { data })));
}

const hosts: Array<[string, typeof CommitGraphPanel | typeof NativeCommitGraph]> = [
    ["bottom panel graph", CommitGraphPanel],
    ["sidebar graph", NativeCommitGraph],
];

function renderHost(Host: (typeof hosts)[number][1]) {
    const postMessage = vi.fn();
    const { container } = mount(
        <ChakraProvider theme={theme}>
            <Host
                vscode={{ postMessage, getState: () => undefined, setState: vi.fn() } as never}
                sendReady={false}
            />
        </ChakraProvider>,
    );
    /** The message text of every row currently drawn with the blue selection ring. */
    const ringedRows = () =>
        Array.from(container.querySelectorAll('.commit-row[aria-current="true"]')).map(
            (row) => row.textContent ?? "",
        );
    return { postMessage, ringedRows };
}

describe.each(hosts)("the %s's selected-row ring (#226)", (_name, Host) => {
    it("rings the row the details name when this graph lists it, and holds it across a refresh", () => {
        const { postMessage, ringedRows } = renderHost(Host);

        send(page);
        expect(ringedRows().length, "the control: a fresh page selects its first row").toBe(1);
        postMessage.mockClear();

        send({ type: "setCommitDetail", detail: detail(parent.hash) });
        expect(
            ringedRows(),
            "the details now show a commit this graph also lists, but this graph kept ringing a " +
                "different row, so the changed files were attributed to two commits",
        ).toEqual([expect.stringContaining(parent.shortHash)]);

        send(page);
        expect(
            ringedRows(),
            "a refresh moved the ring off the commit whose changed files are on show",
        ).toEqual([expect.stringContaining(parent.shortHash)]);
        expect(
            postMessage,
            "a refresh re-selected a row and pulled the details back to this graph",
        ).not.toHaveBeenCalledWith(expect.objectContaining({ type: "selectCommit" }));
    });

    it("shows no ring for a commit this graph does not list, and a refresh keeps it that way", () => {
        const { postMessage, ringedRows } = renderHost(Host);

        send(page);
        postMessage.mockClear();

        send({ type: "setCommitDetail", detail: detail(unlisted) });
        expect(
            ringedRows(),
            "this graph does not list the commit whose changed files are on show, yet one of its " +
                "rows is still outlined as selected",
        ).toEqual([]);

        send(page);
        expect(
            ringedRows(),
            "a refresh of a graph that does not hold the shown commit put a ring back on one of " +
                "its own rows",
        ).toEqual([]);
        expect(
            postMessage,
            "a refresh pulled the details away from the shown commit and over to this graph",
        ).not.toHaveBeenCalledWith(expect.objectContaining({ type: "selectCommit" }));
    });

    it("selects its first commit again after a branch change", () => {
        const { postMessage, ringedRows } = renderHost(Host);

        send(page);
        send({ type: "setCommitDetail", detail: detail(unlisted) });
        expect(
            ringedRows(),
            "the control: no ring while the shown commit is not in this list",
        ).toEqual([]);
        postMessage.mockClear();

        send({ type: "setSelectedBranch", branch: "main" });
        send(page);
        expect(ringedRows(), "a branch change must select its first commit again").toEqual([
            expect.stringContaining(tip.shortHash),
        ]);
        expect(postMessage).toHaveBeenCalledWith({ type: "selectCommit", hash: tip.hash });
    });
});
