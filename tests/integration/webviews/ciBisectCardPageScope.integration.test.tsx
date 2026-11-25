// @vitest-environment jsdom

// "Find where CI broke" in the card Git Log: the rows and the commit detail arrive as separate
// messages, so while the pane switches repository one can name A and the other B. A menu takes
// its repository from the page its rows came from, so A's rows are never sent as B, and B's rows
// never as A.

import React, { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Commit } from "../../../src/types";
import { CommitGraphPanel } from "../../../src/webviews/react/CommitGraphPanel";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const api = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));
initReactDomTestEnvironment();

// Both repositories share these SHAs, so the host's own repository check cannot tell them apart.
const ids = ["a", "b", "c"].map((letter) => letter.repeat(40));

const send = (data: unknown): void =>
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });
const makeRows = (repo: string): Commit[] =>
    ids.map((hash, at) => ({
        hash,
        shortHash: hash.slice(0, 7),
        message: `${repo} row ${at}`,
        author: "Fixture",
        email: "fixture@example.com",
        date: "2026-11-07T00:00:00Z",
        parentHashes: ids[at + 1] ? [ids[at + 1]] : [],
        refs: [],
    }));
const page = (repo: string): void =>
    send({
        type: "loadCommits",
        commits: makeRows(repo),
        append: false,
        hasMore: false,
        repoKey: repo,
    });
const detail = (repo: string): void =>
    send({
        type: "setCommitDetail",
        detail: { ...makeRows(repo)[0], body: "", files: [] },
        ciRepoKey: repo,
    });

const findItem = (): HTMLElement | undefined =>
    Array.from(document.querySelectorAll<HTMLElement>(".intelligit-context-item")).find((node) =>
        node.textContent?.includes("Find where CI broke"),
    );

function selectAndFind(container: HTMLElement, repo: string): void {
    openMenu(container, repo);
    const find = findItem();
    if (find) act(() => find.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function openMenu(container: HTMLElement, repo: string): void {
    const row = (at: number) =>
        Array.from(container.querySelectorAll<HTMLElement>(".commit-row")).find((el) =>
            el.textContent?.includes(`${repo} row ${at}`),
        );
    const click = (at: number, shiftKey = false): void => {
        const node = row(at);
        expect(node, `${repo} row ${at} is mounted`).toBeDefined();
        node!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }));
    };
    act(() => click(0));
    act(() => click(2, true));
    act(() =>
        row(1)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    const menu = Array.from(document.querySelectorAll<HTMLElement>(".intelligit-context-item"));
    expect(
        menu.some((node) => node.textContent?.includes("Squash Commits")),
        "the multi-row menu opened",
    ).toBe(true);
}

function graph(): ReturnType<typeof mount> {
    const mounted = mount(<CommitGraphPanel vscode={api as never} sendReady={false} />);
    send({ type: "setBranches", branches: [], commitChecksEnabled: true });
    page("/A");
    detail("/A");
    return mounted;
}

const starts = (): unknown[] =>
    api.postMessage.mock.calls
        .map(([message]) => message as { type: string })
        .filter(({ type }) => type === "startCiBisect");

beforeEach(() => {
    installWebviewI18n();
    window.intelligitE2E = true;
    api.postMessage.mockClear();
});
afterEach(() => {
    delete window.intelligitE2E;
});

it("card: a newly opened A-row menu does not send B when B detail arrives before the B page", () => {
    const { root, container } = graph();
    try {
        selectAndFind(container, "/A");
        expect(starts(), "control: A rows with A detail start in A").toEqual([
            expect.objectContaining({ repoKey: "/A" }),
        ]);
        api.postMessage.mockClear();

        send({ type: "clearCommitDetail", ciRepoKey: "/B", loading: true });
        detail("/B");
        selectAndFind(container, "/A");
        expect(starts(), "A rows must never be sent to the host as repository B").toEqual([]);

        page("/B");
        selectAndFind(container, "/B");
        expect(starts(), "once B's rows arrive a B menu starts in B").toEqual([
            expect.objectContaining({ repoKey: "/B" }),
        ]);
    } finally {
        unmount(root, container);
    }
});

it("card: new B rows never send a bisect labeled A while B detail is still loading", () => {
    const { root, container } = graph();
    try {
        send({ type: "clearCommitDetail", ciRepoKey: "/B", loading: true });
        page("/B");
        selectAndFind(container, "/B");
        // The clear already named B, so the host can answer B's rows.
        expect(starts(), "B rows must never be sent to the host as repository A").toEqual([
            expect.objectContaining({ repoKey: "/B" }),
        ]);
    } finally {
        unmount(root, container);
    }
});

it("card rejects an old menu as soon as clearCommitDetail announces the repository switch", () => {
    const { root, container } = graph();
    try {
        openMenu(container, "/A");
        send({ type: "clearCommitDetail", ciRepoKey: "/B", loading: true });
        const find = findItem();
        expect(find, "the A menu is still open after the switch").toBeDefined();
        act(() => find!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(starts(), "the host has switched to B and cannot answer a new A request").toEqual(
            [],
        );
    } finally {
        unmount(root, container);
    }
});

it("card: an appended page keeps the repository of the page it extends", () => {
    const { root, container } = graph();
    try {
        // A "load more" page carries no repository of its own.
        send({
            type: "loadCommits",
            commits: [
                {
                    ...makeRows("/A")[2],
                    hash: "d".repeat(40),
                    shortHash: "ddddddd",
                    message: "/A row 3",
                },
            ],
            append: true,
            hasMore: false,
        });
        selectAndFind(container, "/A");
        expect(starts(), "rows of an appended A page still start in A").toEqual([
            expect.objectContaining({ repoKey: "/A" }),
        ]);
    } finally {
        unmount(root, container);
    }
});
