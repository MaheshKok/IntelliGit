// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkingFile } from "../../../src/types";
import { CommitTab } from "../../../src/webviews/react/commit-panel/components/CommitTab";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";

const vscode = vi.hoisted(() => ({ postMessage: vi.fn() }));

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => vscode }));

initReactDomTestEnvironment();

const files: WorkingFile[] = [
    { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
    { path: "src/b.ts", status: "A", staged: false, additions: 1, deletions: 0 },
];

function click(element: Element): void {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function menuItem(label: string): HTMLElement {
    const item = Array.from(
        document.querySelectorAll<HTMLElement>(".intelligit-context-item"),
    ).find((candidate) => candidate.textContent?.trim() === label);
    if (!item) throw new Error(`Missing menu item: ${label}`);
    return item;
}

function renderCommitTab({
    commitMessage = "draft shelf",
    activeOperation = "none",
    rebaseControl = undefined,
}: {
    commitMessage?: string;
    activeOperation?: "none" | "merge" | "cherry-pick" | "revert" | "rebase";
    rebaseControl?: "owned" | "unowned" | "foreign";
} = {}) {
    return mount(
        <ChakraProvider theme={theme}>
            <CommitTab
                repositoryRoot="/repo"
                files={files}
                commitMessage={commitMessage}
                isAmend={false}
                amendBranchCommits={[]}
                amendBranchHistoryLoaded
                isRefreshing={false}
                checkedPaths={new Set(["src/a.ts"])}
                onToggleFile={vi.fn()}
                onToggleFolder={vi.fn()}
                onToggleSection={vi.fn()}
                isAllChecked={() => false}
                isSomeChecked={() => false}
                onMessageChange={vi.fn()}
                onAmendChange={vi.fn()}
                onCommit={vi.fn()}
                canCommit={false}
                onPush={vi.fn()}
                canPush={false}
                pushLabel="Push"
                currentBranchName={null}
                currentBranchUpstream={null}
                groupByDir={false}
                showIgnoredFiles={false}
                onToggleGroupBy={vi.fn()}
                onToggleShowIgnoredFiles={vi.fn()}
                catalogGeneration={12}
                activeOperation={activeOperation}
                rebaseControl={rebaseControl}
            />
        </ChakraProvider>,
    );
}

describe("CommitTab shelving", () => {
    it("posts repository-scoped Continue Rebase and Abort Rebase commands", () => {
        vscode.postMessage.mockReset();
        const { root, container } = renderCommitTab({
            activeOperation: "rebase",
            rebaseControl: "owned",
        });

        const continueButton = Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent === "Continue Rebase",
        );
        const abortButton = Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent === "Abort Rebase",
        );
        if (!continueButton || !abortButton) throw new Error("Missing rebase controls");
        click(continueButton);
        click(abortButton);

        expect(vscode.postMessage).toHaveBeenNthCalledWith(1, {
            type: "continueRebase",
            repositoryRoot: "/repo",
        });
        expect(vscode.postMessage).toHaveBeenNthCalledWith(2, {
            type: "abortRebase",
            repositoryRoot: "/repo",
        });
        unmount(root, container);
    });

    it("suggests a date-free default shelf name when the menu opens", () => {
        const { root, container } = renderCommitTab({ commitMessage: "" });
        const tab = container.querySelector('[data-testid="commit-tab"]') as HTMLElement;
        act(() =>
            tab.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
            ),
        );
        click(menuItem("Shelve Changes…"));
        // The shelf row prints its creation date in the meta column, so the name is a
        // plain label rather than a second copy of the same timestamp.
        expect(
            (document.querySelector('input[aria-label="Shelf name"]') as HTMLInputElement).value,
        ).toBe("Uncommitted changes");
        unmount(root, container);
    });

    it("leaves FileRow context menus to VS Code and opens shelf actions at the cursor elsewhere", () => {
        const { root, container } = renderCommitTab();
        const tab = container.querySelector('[data-testid="commit-tab"]') as HTMLElement;
        const fileRow = container.querySelector("[data-vscode-context]") as HTMLElement;
        expect(fileRow).not.toBeNull();

        const fileEvent = new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 13,
            clientY: 17,
        });
        act(() => fileRow.dispatchEvent(fileEvent));
        expect(fileEvent.defaultPrevented).toBe(false);
        expect(document.querySelector(".intelligit-context-menu")).toBeNull();

        const emptyEvent = new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 31,
            clientY: 47,
        });
        act(() => tab.dispatchEvent(emptyEvent));
        const menu = document.querySelector('[role="menu"]') as HTMLElement;
        expect(emptyEvent.defaultPrevented).toBe(true);
        expect(menu.style.left).toBe("31px");
        expect(menu.style.top).toBe("47px");
        unmount(root, container);
    });

    it("leaves the commit message box to its native context menu", () => {
        const { root, container } = renderCommitTab();
        const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
        expect(textarea).not.toBeNull();

        const event = new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 5,
            clientY: 7,
        });
        act(() => textarea.dispatchEvent(event));
        // Shelving acts on the file list; hijacking the editor would also cost the
        // message box its native cut/copy/paste menu.
        expect(event.defaultPrevented).toBe(false);
        expect(document.querySelector('[role="menu"]')).toBeNull();
        unmount(root, container);
    });

    it("suppresses every context menu on the generate button", () => {
        const { root, container } = renderCommitTab();
        const generate = container.querySelector(
            '[aria-label="Generate commit message"]',
        ) as HTMLElement;
        expect(generate).not.toBeNull();

        const event = new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 5,
            clientY: 7,
        });
        act(() => generate.dispatchEvent(event));
        // An icon button has nothing to cut, copy, or paste, so the native menu is noise.
        expect(event.defaultPrevented).toBe(true);
        expect(document.querySelector('[role="menu"]')).toBeNull();
        unmount(root, container);
    });

    it("opens a per-file shelve dialog from the context menu and preserves draft-name whitespace", () => {
        vscode.postMessage.mockReset();
        const { root, container } = renderCommitTab();
        const tab = container.querySelector('[data-testid="commit-tab"]') as HTMLElement;

        act(() =>
            tab.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
            ),
        );
        click(menuItem("Shelve Changes…"));
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        expect(
            (dialog.querySelector('input[aria-label="Shelf name"]') as HTMLInputElement).value,
        ).toBe("draft shelf");
        click(
            Array.from(dialog.querySelectorAll("button")).find(
                (button) => button.textContent === "Shelve Changes",
            )!,
        );

        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "shelveSave",
                repositoryRoot: "/repo",
                name: "draft shelf",
                paths: ["src/a.ts"],
                silent: false,
                keepLocal: false,
                expectedCatalogGeneration: 12,
            }),
        );
        unmount(root, container);
    });

    it("offers silent and keep-local shelf actions", () => {
        vscode.postMessage.mockReset();
        const { root, container } = renderCommitTab();
        const tab = container.querySelector('[data-testid="commit-tab"]') as HTMLElement;

        act(() =>
            tab.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
            ),
        );
        click(menuItem("Shelve Silently"));
        expect(vscode.postMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                type: "shelveSave",
                paths: ["src/a.ts"],
                silent: true,
                keepLocal: false,
            }),
        );
        act(() =>
            tab.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
            ),
        );
        click(menuItem("Save to Shelf"));
        expect(vscode.postMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                type: "shelveSave",
                paths: ["src/a.ts"],
                keepLocal: true,
            }),
        );
        unmount(root, container);
    });

    it("exposes a focusable horizontal resize separator with clamped arrow controls", () => {
        const { root, container } = renderCommitTab();
        const tab = container.querySelector('[data-testid="commit-tab"]') as HTMLElement;
        Object.defineProperty(tab, "clientHeight", { configurable: true, value: 600 });
        const separator = container.querySelector('[role="separator"]') as HTMLElement;
        const bottomArea = separator.nextElementSibling as HTMLElement;

        expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
        expect(separator.tabIndex).toBe(0);
        act(() =>
            separator.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowUp" }),
            ),
        );
        expect(getComputedStyle(bottomArea).height).toBe("120px");
        act(() =>
            separator.dispatchEvent(
                new KeyboardEvent("keydown", {
                    bubbles: true,
                    cancelable: true,
                    key: "ArrowDown",
                }),
            ),
        );
        expect(getComputedStyle(bottomArea).height).toBe("110px");
        act(() =>
            separator.dispatchEvent(
                new KeyboardEvent("keydown", {
                    bubbles: true,
                    cancelable: true,
                    key: "ArrowDown",
                }),
            ),
        );
        expect(getComputedStyle(bottomArea).height).toBe("110px");
        act(() => {
            for (let count = 0; count < 50; count += 1) {
                separator.dispatchEvent(
                    new KeyboardEvent("keydown", {
                        bubbles: true,
                        cancelable: true,
                        key: "ArrowUp",
                    }),
                );
            }
        });
        expect(getComputedStyle(bottomArea).height).toBe("540px");
        const unhandled = new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
        });
        act(() => separator.dispatchEvent(unhandled));
        expect(unhandled.defaultPrevented).toBe(false);
        unmount(root, container);
    });
});
