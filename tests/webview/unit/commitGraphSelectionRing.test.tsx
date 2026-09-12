// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import type { Commit } from "../../../src/types";
import { CommitGraphPanel } from "../../../src/webviews/react/CommitGraphPanel";
import { NativeCommitGraph } from "../../../src/webviews/react/NativeCommitGraph";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";

initReactDomTestEnvironment();

/**
 * #226: the sidebar and bottom graphs share the details panes, so only the graph whose commit
 * fills them may keep its selected-row ring. The host tells the other graph with
 * `deselectCommit`; this pins what each webview does with it, including across the refreshes the
 * file watcher fires on its own.
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

const tip = commit("b".repeat(40), ["a".repeat(40)]);
const page = {
    type: "loadCommits",
    commits: [tip, commit("a".repeat(40), [])],
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

describe.each(hosts)("the %s's selected-row ring (#226)", (_name, Host) => {
    it("drops when another view's commit fills the details, and stays off across refreshes", () => {
        const postMessage = vi.fn();
        const { container } = mount(
            <ChakraProvider theme={theme}>
                <Host
                    vscode={{ postMessage, getState: () => undefined, setState: vi.fn() } as never}
                    sendReady={false}
                />
            </ChakraProvider>,
        );
        const ringedRows = () =>
            container.querySelectorAll('.commit-row[aria-current="true"]').length;

        send(page);
        expect(
            ringedRows(),
            "the control: a fresh page selects its first row, so there is a ring to drop",
        ).toBe(1);
        postMessage.mockClear();

        send({ type: "deselectCommit" });
        expect(
            ringedRows(),
            "the host said another view's commit now fills the details, but this graph kept its " +
                "own row outlined, so two commits looked selected",
        ).toBe(0);

        send(page);
        expect(
            ringedRows(),
            "a refresh put the ring back on a graph whose commit is no longer the one on show",
        ).toBe(0);
        expect(
            postMessage,
            "a refresh re-selected a row and pulled the details back to this graph",
        ).not.toHaveBeenCalledWith(expect.objectContaining({ type: "selectCommit" }));

        send({ type: "setSelectedBranch", branch: "main" });
        send(page);
        expect(ringedRows(), "a branch change must select its first commit again").toBe(1);
        expect(postMessage).toHaveBeenCalledWith({ type: "selectCommit", hash: tip.hash });
    });
});
