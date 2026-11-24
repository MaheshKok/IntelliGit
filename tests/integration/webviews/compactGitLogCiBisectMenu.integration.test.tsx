// @vitest-environment jsdom
// "Find where CI broke" in the compact Git Log (sidebar graph), owner 2026-11-24 "B + compact now":
// the same row action as the card layout, behind the same Checks tab switch. The compact graph has
// no Checks tab of its own, so the range goes to its host, which hands it to the Changed Files view.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit } from "../../../src/types";
import { NativeCommitGraph } from "../../../src/webviews/react/NativeCommitGraph";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

const commit = (hash: string, parent: string, message: string): Commit => ({
    hash,
    shortHash: hash,
    message,
    author: "Mahesh",
    email: "m@example.com",
    date: "2026-02-18T00:00:00Z",
    parentHashes: [parent],
    refs: [],
});

const COMMITS = [
    commit("aaa1111", "bbb2222", "feat: head"),
    commit("bbb2222", "ccc3333", "feat: middle"),
    commit("ccc3333", "ddd4444", "feat: oldest selected"),
];

function send(data: unknown): void {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });
}

function row(container: HTMLElement, message: string): HTMLElement {
    const found = Array.from(container.querySelectorAll<HTMLElement>(".commit-row")).find((el) =>
        el.textContent?.includes(message),
    );
    if (!found) throw new Error(`Missing commit row containing ${message}`);
    return found;
}

function menuItems(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(".intelligit-context-item"));
}

function renderCompact() {
    const vscode = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
    const mounted = mount(<NativeCommitGraph vscode={vscode as never} sendReady={false} />);
    send({ type: "setBranches", branches: [], commitChecksEnabled: true });
    send({ type: "loadCommits", commits: COMMITS, append: false, hasMore: false });
    act(() => {
        row(mounted.container, "feat: oldest selected").dispatchEvent(
            new MouseEvent("click", { bubbles: true, shiftKey: true }),
        );
    });
    act(() => {
        row(mounted.container, "feat: middle").dispatchEvent(
            new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: 40,
                clientY: 20,
            }),
        );
    });
    return { ...mounted, vscode };
}

beforeEach(() => installWebviewI18n());
afterEach(() => {
    delete window.intelligitE2E;
});

describe("compact Git Log Find where CI broke", () => {
    it("the compact row menu shows no Find where CI broke while the Checks tab switch is off", () => {
        delete window.intelligitE2E;
        const { root, container, vscode } = renderCompact();
        const labels = menuItems().map((item) => item.textContent ?? "");
        expect(
            labels.some((label) => label.includes("Squash Commits")),
            "control: the range menu opened",
        ).toBe(true);
        expect(labels.some((label) => label.includes("Find where CI broke"))).toBe(false);
        expect(vscode.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "findCiBreakInChecks" }),
        );
        unmount(root, container);
    });

    it("sends the selected range to its host for the Changed Files view's Checks tab", () => {
        window.intelligitE2E = true;
        const { root, container, vscode } = renderCompact();
        const item = menuItems().find((el) => el.textContent?.includes("Find where CI broke"));
        expect(item, "the switch is on: the compact menu offers the action").toBeDefined();
        act(() => item!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "findCiBreakInChecks",
            commits: [
                { hash: "aaa1111", parents: ["bbb2222"] },
                { hash: "bbb2222", parents: ["ccc3333"] },
                { hash: "ccc3333", parents: ["ddd4444"] },
            ],
        });
        unmount(root, container);
    });

    it("offers nothing while CI checks are turned off in the settings", () => {
        window.intelligitE2E = true;
        const vscode = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
        const { root, container } = mount(
            <NativeCommitGraph vscode={vscode as never} sendReady={false} />,
        );
        send({ type: "setBranches", branches: [], commitChecksEnabled: false });
        send({ type: "loadCommits", commits: COMMITS, append: false, hasMore: false });
        act(() => {
            row(container, "feat: oldest selected").dispatchEvent(
                new MouseEvent("click", { bubbles: true, shiftKey: true }),
            );
        });
        act(() => {
            row(container, "feat: middle").dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
            );
        });
        expect(menuItems().some((el) => el.textContent?.includes("Find where CI broke"))).toBe(
            false,
        );
        unmount(root, container);
    });
});
