// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StashEntry, WorkingFile } from "../../../src/types";
import { StashTab } from "../../../src/webviews/react/commit-panel/components/StashTab";
import { StashUnstashDialog } from "../../../src/webviews/react/commit-panel/components/StashUnstashDialog";
import { formatDateTime } from "../../../src/webviews/react/shared/date";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const vscode = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
}));

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => vscode,
}));

initReactDomTestEnvironment();

const REQUEST_ID_PATTERN = /^stash-mutation-\d+$/;
const stashes: StashEntry[] = [
    { index: 0, message: "On main: Fix stash layout", date: "2026-07-21 10:00", hash: "abc" },
    { index: 1, message: "On feature/demo: Add tests", date: "2026-07-20 09:00", hash: "def" },
];
const files: WorkingFile[] = [
    { path: "src/first.ts", status: "M", staged: false, additions: 1, deletions: 0 },
    { path: "src/second.ts", status: "A", staged: false, additions: 2, deletions: 0 },
];

/** Renders StashTab with the smallest stable repository fixture. */
function renderStashTab(
    overrides: Partial<React.ComponentProps<typeof StashTab>> = {},
): ReturnType<typeof mount> {
    return mount(
        <ChakraProvider theme={theme}>
            <StashTab
                repositoryRoot="/repo"
                currentBranchName="main"
                stashes={stashes}
                stashFiles={files}
                selectedIndex={0}
                groupByDir={false}
                onToggleGroupBy={vi.fn()}
                {...overrides}
            />
        </ChakraProvider>,
    );
}

/** Finds the visible context-menu item with an exact label. */
function menuItem(label: string): HTMLElement {
    const item = Array.from(
        document.querySelectorAll<HTMLElement>(".intelligit-context-item"),
    ).find((element) => element.textContent?.trim() === label);
    if (!item) throw new Error(`Missing context-menu item: ${label}`);
    return item;
}

/** Finds a component-local button by exact visible text. */
function button(container: ParentNode, label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === label,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
}

/** Sends one standard tree key to a stash row, exactly as a user would. */
function pressOnStashRow(container: ParentNode, index: number, key: string): void {
    const row = container.querySelector(`[data-stash-index="${index}"]`) as HTMLElement;
    act(() => {
        row.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    });
}

/** Opens one stash row's file subtree through the standard tree key. */
function expandStash(container: ParentNode, index: number): void {
    pressOnStashRow(container, index, "ArrowRight");
}

/** Returns the file subtree rendered beneath the one expanded stash row. */
function stashSubtree(container: ParentNode): HTMLElement {
    const group = container.querySelector('[role="group"]');
    if (!group) throw new Error("Missing expanded stash subtree");
    return group as HTMLElement;
}

/** Dispatches a bubbling click for user-action contract assertions. */
function click(element: Element): void {
    act(() => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

/** Uses the native checkbox activation path so React observes checked state. */
function check(input: HTMLInputElement): void {
    act(() => {
        input.click();
    });
}

/** Updates a controlled input through its native setter before dispatching React input events. */
function changeInput(input: HTMLInputElement, value: string): void {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setValue) throw new Error("Missing native input value setter");
    act(() => {
        setValue.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

/** Opens the row menu through its browser context-menu event. */
function openRowMenu(row: HTMLElement): void {
    act(() => {
        row.dispatchEvent(
            new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: 20,
                clientY: 20,
            }),
        );
    });
}

/** Returns the last outbound message as an assertion-friendly record. */
function lastMessage(): Record<string, unknown> {
    const calls = vscode.postMessage.mock.calls;
    return (calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
}

/** Completes the currently pending mutation through the inbound host protocol. */
function completeMutation(requestId: string, repositoryRoot: string | null = "/repo"): void {
    act(() => {
        window.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    type: "stashMutationCompleted",
                    requestId,
                    ...(repositoryRoot ? { repositoryRoot } : {}),
                },
            }),
        );
    });
}

/** Extracts and validates a generated request ID from the last outbound message. */
function lastRequestId(): string {
    const requestId = lastMessage().requestId;
    expect(requestId).toEqual(expect.stringMatching(REQUEST_ID_PATTERN));
    return requestId as string;
}

beforeEach(() => {
    installWebviewI18n();
    vi.clearAllMocks();
});

describe("StashTab", () => {
    it("renders one stash tree whose rows expand in place into their own files", () => {
        const { root, container } = renderStashTab();
        const tree = container.querySelector('[data-testid="stash-list"]');
        const rows = tree?.querySelectorAll('[role="treeitem"]') ?? [];

        expect(tree?.getAttribute("role")).toBe("tree");
        expect(rows).toHaveLength(2);
        expect(rows[0]?.getAttribute("aria-selected")).toBe("true");
        expect(rows[0]?.getAttribute("aria-expanded")).toBe("false");
        expect(rows[0]?.getAttribute("aria-level")).toBe("1");
        // The splitter and its lower pane are gone: files live under their own row.
        expect(container.querySelector('[role="group"]')).toBeNull();
        expect(container.querySelectorAll('[role="separator"]')).toHaveLength(0);

        expandStash(container, 0);
        expect(rows[0]?.getAttribute("aria-expanded")).toBe("true");
        expect(
            stashSubtree(container).querySelector('[data-stash-file="src/first.ts"]'),
        ).toBeTruthy();

        unmount(root, container);
    });

    it("shows PyCharm's file-count and date meta only once a stash's files are cached", () => {
        const { root, container } = renderStashTab();
        const cached = container.querySelector(
            '[data-stash-index="0"] [data-stash-meta]',
        ) as HTMLElement;
        const unloaded = container.querySelector(
            '[data-stash-index="1"] [data-stash-meta]',
        ) as HTMLElement;

        expect(cached.textContent).toBe(`2 files, ${formatDateTime(stashes[0]!.date)}`);
        expect(cached.textContent).not.toContain(stashes[0]!.date);
        expect(unloaded.textContent).toBe(formatDateTime(stashes[1]!.date));
        expect(unloaded.textContent).not.toContain("file");
        expect(getComputedStyle(cached).fontSize).toBe("11px");

        unmount(root, container);
    });

    it("renders flat stash files as Changed-Files tree items with one chevron-width spacer", () => {
        const ignoredFile: WorkingFile = {
            path: "ignored.log",
            status: "!",
            staged: false,
            additions: 0,
            deletions: 0,
        };
        const { root, container } = renderStashTab({ stashFiles: [...files, ignoredFile] });
        expandStash(container, 0);
        const filePane = stashSubtree(container);
        const file = container.querySelector('[data-stash-file="src/first.ts"]') as HTMLElement;
        const otherFile = container.querySelector(
            '[data-stash-file="src/second.ts"]',
        ) as HTMLElement;
        const ignored = container.querySelector('[data-stash-file="ignored.log"]') as HTMLElement;

        // Rows are focusable tree items, exactly as the Changed Files tree renders them.
        expect(file.getAttribute("role")).toBe("treeitem");
        expect(file.getAttribute("tabindex")).toBe("0");
        expect(file.textContent).toContain("first.ts");
        expect(file.textContent).toContain("src");
        expect(file.textContent).toContain("+1");
        expect(file.textContent).toContain("M");
        expect(filePane.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
        for (const stashFile of [file, otherFile, ignored]) {
            const chevronSpacer = stashFile.querySelector('[data-tree-icon="file"]')
                ?.previousElementSibling as HTMLElement;
            // One Changed-Files indent step stands in for the chevron a file has no room for.
            expect(getComputedStyle(chevronSpacer).width).toBe("14px");
        }
        expect(file.getAttribute("data-vscode-context")).toBeNull();
        // Each row reports its own selection, so an unselected file says so rather than staying silent.
        expect(file.getAttribute("aria-selected")).toBe("false");
        expect(otherFile.getAttribute("aria-selected")).toBe("false");
        // Expanding a row selects the stash, never one of its files.
        expect(file.hasAttribute("aria-current")).toBe(false);

        click(file);
        expect(file.getAttribute("aria-selected")).toBe("true");
        expect(file.getAttribute("aria-current")).toBe("true");
        click(otherFile);
        expect(file.getAttribute("aria-selected")).toBe("false");
        expect(otherFile.getAttribute("aria-selected")).toBe("true");
        expect(file.hasAttribute("aria-current")).toBe(false);
        expect(otherFile.getAttribute("aria-current")).toBe("true");

        unmount(root, container);
    });

    it("selects flat and grouped stash files before showing the exact file-only menu", () => {
        for (const groupByDir of [false, true]) {
            const { root, container } = renderStashTab({ groupByDir });
            expandStash(container, 0);
            const stashRow = container.querySelector('[data-stash-index="0"]') as HTMLElement;
            const file = container.querySelector(
                '[data-stash-file="src/second.ts"]',
            ) as HTMLElement;

            openRowMenu(stashRow);
            expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
            openRowMenu(file);

            expect(file.getAttribute("aria-current")).toBe("true");
            expect(file.getAttribute("data-vscode-context")).toBeNull();
            expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
            expect(
                Array.from(document.querySelectorAll(".intelligit-context-item")).map((item) =>
                    item.textContent?.trim(),
                ),
            ).toEqual(["Open Diff", "Edit Source", "Cherry-Pick Selected Changes"]);

            unmount(root, container);
        }
    });

    it("renders unversioned stash files in the same subtree without checkboxes", () => {
        const unversionedFile: WorkingFile = {
            path: "new-file.ts",
            status: "?",
            staged: false,
            additions: 4,
            deletions: 2,
        };
        const { root, container } = renderStashTab({ stashFiles: [...files, unversionedFile] });
        expandStash(container, 0);
        const subtree = stashSubtree(container);

        // The entry row replaced the Changes / Unversioned Files section headers.
        expect(subtree.textContent).not.toContain("Unversioned Files");
        expect(subtree.querySelector('[data-stash-file="new-file.ts"]')).toBeTruthy();
        expect(subtree.querySelector('[data-stash-file="src/first.ts"]')).toBeTruthy();
        expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
        expect(
            container.querySelector('[data-stash-index="0"] [data-stash-meta]')?.textContent,
        ).toContain("3 files");

        unmount(root, container);
    });

    it("keeps stash-file selection and per-stash directory state across a row collapse", () => {
        const { root, container } = renderStashTab({ groupByDir: true });
        expandStash(container, 0);
        click(container.querySelector('[data-stash-file="src/second.ts"]') as HTMLElement);
        expect(
            container
                .querySelector('[data-stash-file="src/second.ts"]')
                ?.getAttribute("aria-current"),
        ).toBe("true");

        click(container.querySelector('button[title="src"]') as HTMLElement);
        expect(container.querySelector('[data-stash-file="src/second.ts"]')).toBeNull();
        pressOnStashRow(container, 0, "ArrowLeft");
        expect(container.querySelector('[role="group"]')).toBeNull();

        // Reopening restores the collapsed directory and the selection beneath it.
        expandStash(container, 0);
        const folder = container.querySelector('button[title="src"]') as HTMLElement;
        expect(folder.getAttribute("aria-expanded")).toBe("false");
        click(folder);
        expect(
            container
                .querySelector('[data-stash-file="src/second.ts"]')
                ?.getAttribute("aria-current"),
        ).toBe("true");

        unmount(root, container);
    });

    it("enables expand and collapse for every stash row whenever the tab has entries", () => {
        const empty = renderStashTab({ stashes: [], stashFiles: [], selectedIndex: null });
        expect(
            (empty.container.querySelector('button[aria-label="Expand All"]') as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        unmount(empty.root, empty.container);

        const { root, container } = renderStashTab();
        const collapse = container.querySelector(
            'button[aria-label="Collapse All"]',
        ) as HTMLButtonElement;
        const expand = container.querySelector(
            'button[aria-label="Expand All"]',
        ) as HTMLButtonElement;

        expect(collapse.disabled).toBe(false);
        expect(expand.disabled).toBe(false);
        click(expand);
        expect(container.querySelector('[data-stash-file="src/first.ts"]')).toBeTruthy();
        click(collapse);
        expect(container.querySelector('[role="group"]')).toBeNull();

        unmount(root, container);
    });

    it("expands collapsed stash rows and grouped directories together", () => {
        const { root, container } = renderStashTab({ groupByDir: true });
        const collapse = container.querySelector(
            'button[aria-label="Collapse All"]',
        ) as HTMLButtonElement;
        const expand = container.querySelector(
            'button[aria-label="Expand All"]',
        ) as HTMLButtonElement;

        click(expand);
        click(container.querySelector('button[title="src"]') as HTMLElement);
        expect(container.querySelector('[data-stash-file="src/first.ts"]')).toBeNull();

        click(collapse);
        expect(container.querySelector('button[title="src"]')).toBeNull();
        // Expand-all reopens every row and clears the per-entry directory state.
        click(expand);
        expect(container.querySelector('button[title="src"]')).toBeTruthy();
        expect(container.querySelector('[data-stash-file="src/first.ts"]')).toBeTruthy();

        unmount(root, container);
    });

    it("hydrates every expanded cache miss in source order without duplicate selection requests", () => {
        const orderedStashes: StashEntry[] = [
            ...stashes,
            { index: 2, message: "On feature/third: Last", date: "2026-07-19 08:00", hash: "ghi" },
        ];
        const secondFiles: WorkingFile[] = [
            { path: "src/second-stash.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        ];
        const thirdFiles: WorkingFile[] = [
            { path: "src/third-stash.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        ];
        const { root, container } = renderStashTab({ stashes: orderedStashes });

        click(container.querySelector('button[aria-label="Expand All"]') as HTMLButtonElement);
        expect(lastMessage()).toEqual({ type: "stashSelect", repositoryRoot: "/repo", index: 1 });
        act(() =>
            root.render(
                <ChakraProvider theme={theme}>
                    <StashTab
                        repositoryRoot="/repo"
                        currentBranchName="main"
                        stashes={orderedStashes}
                        stashFiles={secondFiles}
                        selectedIndex={1}
                        groupByDir={false}
                        onToggleGroupBy={vi.fn()}
                    />
                </ChakraProvider>,
            ),
        );
        expect(lastMessage()).toEqual({ type: "stashSelect", repositoryRoot: "/repo", index: 2 });
        act(() =>
            root.render(
                <ChakraProvider theme={theme}>
                    <StashTab
                        repositoryRoot="/repo"
                        currentBranchName="main"
                        stashes={orderedStashes}
                        stashFiles={thirdFiles}
                        selectedIndex={2}
                        groupByDir={false}
                        onToggleGroupBy={vi.fn()}
                    />
                </ChakraProvider>,
            ),
        );
        expect(vscode.postMessage).toHaveBeenCalledTimes(2);
        unmount(root, container);
    });

    it("cancels an expand-all scan before a delayed host response can load the next stash", () => {
        const orderedStashes: StashEntry[] = [
            ...stashes,
            { index: 2, message: "On feature/third: Last", date: "2026-07-19 08:00", hash: "ghi" },
        ];
        const secondFiles: WorkingFile[] = [
            { path: "src/second-stash.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        ];
        const { root, container } = renderStashTab({ stashes: orderedStashes });

        click(container.querySelector('button[aria-label="Expand All"]') as HTMLButtonElement);
        expect(lastMessage()).toEqual({ type: "stashSelect", repositoryRoot: "/repo", index: 1 });
        click(container.querySelector('button[aria-label="Collapse All"]') as HTMLButtonElement);
        act(() =>
            root.render(
                <ChakraProvider theme={theme}>
                    <StashTab
                        repositoryRoot="/repo"
                        currentBranchName="main"
                        stashes={orderedStashes}
                        stashFiles={secondFiles}
                        selectedIndex={1}
                        groupByDir={false}
                        onToggleGroupBy={vi.fn()}
                    />
                </ChakraProvider>,
            ),
        );
        expect(vscode.postMessage).toHaveBeenCalledTimes(1);
        unmount(root, container);
    });

    it("renders grouped stash folders with icons directly after chevrons and no inputs or redundant parent paths", () => {
        const { root, container } = renderStashTab({ groupByDir: true });
        expandStash(container, 0);
        const folder = container.querySelector('button[title="src"]') as HTMLElement;
        const file = container.querySelector('[data-stash-file="src/first.ts"]') as HTMLElement;

        expect(folder.textContent).toContain("src");
        expect(folder.textContent).toContain("2 files");
        expect(folder.querySelector('input[type="checkbox"]')).toBeNull();
        const chevronBeforeFolderIcon = folder.querySelector('[data-tree-icon="folder"]')
            ?.previousElementSibling as HTMLElement;
        expect(chevronBeforeFolderIcon.tagName).toBe("svg");
        expect(folder.getAttribute("aria-expanded")).toBe("true");
        expect(file.textContent).toContain("first.ts");
        expect(file.textContent).not.toContain("src");
        expect(file.querySelector('input[type="checkbox"]')).toBeNull();
        const fileChevronSpacer = file.querySelector('[data-tree-icon="file"]')
            ?.previousElementSibling as HTMLElement;
        expect(getComputedStyle(fileChevronSpacer).width).toBe("14px");

        click(folder);
        expect(container.querySelector('[data-stash-file="src/first.ts"]')).toBeNull();
        expect(folder.getAttribute("aria-expanded")).toBe("false");

        unmount(root, container);
    });

    it("supports tree navigation and keyboard context-menu activation", () => {
        const { root, container } = renderStashTab();
        const first = container.querySelector('[data-stash-index="0"]') as HTMLElement;
        const second = container.querySelector('[data-stash-index="1"]') as HTMLElement;

        first.focus();
        act(() => {
            first.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
        });
        expect(document.activeElement).toBe(second);
        expect(lastMessage()).toEqual({ type: "stashSelect", repositoryRoot: "/repo", index: 1 });

        act(() => {
            second.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" }));
        });
        expect(document.activeElement).toBe(first);
        expect(lastMessage()).toEqual({ type: "stashSelect", repositoryRoot: "/repo", index: 0 });

        act(() => {
            first.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "ContextMenu" }),
            );
        });
        expect(
            Array.from(document.querySelectorAll(".intelligit-context-item")).map((item) =>
                item.textContent?.trim(),
            ),
        ).toEqual([
            "Pop",
            "Apply",
            "Unstash…",
            "Drop",
            "Clear",
            "Show Diff",
            "Show Diff in a New Tab",
        ]);
        expect(document.querySelectorAll('[role="menu"] hr')).toHaveLength(1);
        expect(document.body.textContent).not.toContain("⌘D");

        unmount(root, container);
    });

    it("returns focus to the initiating stash row after cancelling Unstash", () => {
        const { root, container } = renderStashTab();
        const row = container.querySelector('[data-stash-index="0"]') as HTMLElement;

        for (const dismissal of ["Escape", "Cancel"] as const) {
            row.focus();
            act(() => {
                row.dispatchEvent(
                    new KeyboardEvent("keydown", { bubbles: true, key: "ContextMenu" }),
                );
            });
            const unstashItem = menuItem("Unstash…");
            unstashItem.focus();
            act(() => {
                unstashItem.dispatchEvent(
                    new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
                );
            });
            expect(document.querySelector('[role="dialog"]')).toBeTruthy();

            if (dismissal === "Escape") {
                act(() => {
                    document.dispatchEvent(
                        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
                    );
                });
            } else {
                click(button(document, "Cancel"));
            }
            expect(document.activeElement).toBe(row);
        }

        unmount(root, container);
    });

    it("opens the stash-file menu from both keyboard gestures and restores focus on Escape", () => {
        const { root, container } = renderStashTab();
        expandStash(container, 0);
        const file = container.querySelector('[data-stash-file="src/second.ts"]') as HTMLElement;
        vi.spyOn(file, "getBoundingClientRect").mockReturnValue({
            left: 31,
            bottom: 47,
            top: 25,
            right: 131,
            width: 100,
            height: 22,
            x: 31,
            y: 25,
            toJSON: () => undefined,
        });

        for (const event of [
            new KeyboardEvent("keydown", { bubbles: true, key: "ContextMenu" }),
            new KeyboardEvent("keydown", { bubbles: true, key: "F10", shiftKey: true }),
        ]) {
            file.focus();
            act(() => file.dispatchEvent(event));
            const menu = document.querySelector('[role="menu"]') as HTMLElement;
            expect(menu.style.left).toBe("31px");
            expect(menu.style.top).toBe("47px");
            menuItem("Open Diff").focus();
            act(() => {
                document.dispatchEvent(
                    new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
                );
            });
            expect(document.querySelector('[role="menu"]')).toBeNull();
            expect(document.activeElement).toBe(file);
        }

        unmount(root, container);
    });

    it("keeps dialog focus and latest Escape handler when onClose changes", () => {
        const firstOnClose = vi.fn();
        const secondOnClose = vi.fn();
        const returnFocusTarget = document.createElement("button");
        document.body.append(returnFocusTarget);
        const returnFocusSpy = vi.spyOn(returnFocusTarget, "focus");
        const onCurrentBranchSubmit = vi.fn();
        const onBranchSubmit = vi.fn();
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
                <StashUnstashDialog
                    currentBranchName="main"
                    returnFocusTarget={returnFocusTarget}
                    onClose={firstOnClose}
                    onCurrentBranchSubmit={onCurrentBranchSubmit}
                    onBranchSubmit={onBranchSubmit}
                />
            </ChakraProvider>,
        );
        const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
        const input = dialog.querySelector('[aria-label="As new branch"]') as HTMLInputElement;
        const inputFocusSpy = vi.spyOn(input, "focus");

        expect(document.activeElement).toBe(input);
        const cancel = button(dialog, "Cancel");
        cancel.focus();
        expect(document.activeElement).toBe(cancel);
        returnFocusSpy.mockClear();
        inputFocusSpy.mockClear();

        act(() => {
            root.render(
                <ChakraProvider theme={theme}>
                    <StashUnstashDialog
                        currentBranchName="main"
                        returnFocusTarget={returnFocusTarget}
                        onClose={secondOnClose}
                        onCurrentBranchSubmit={onCurrentBranchSubmit}
                        onBranchSubmit={onBranchSubmit}
                    />
                </ChakraProvider>,
            );
        });

        expect(returnFocusSpy).not.toHaveBeenCalled();
        expect(inputFocusSpy).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(cancel);

        act(() => {
            document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
        });
        expect(firstOnClose).not.toHaveBeenCalled();
        expect(secondOnClose).toHaveBeenCalledTimes(1);

        unmount(root, container);
        expect(returnFocusSpy).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(returnFocusTarget);
        returnFocusTarget.remove();
    });

    it("selects a stash file before opening its diff by double-click or Enter", () => {
        const { root, container } = renderStashTab();
        expandStash(container, 0);
        const file = container.querySelector('[data-stash-file="src/second.ts"]') as HTMLElement;

        click(file);
        expect(file.getAttribute("aria-current")).toBe("true");
        expect(vscode.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "showStashDiff" }),
        );

        act(() => {
            file.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        });
        expect(lastMessage()).toEqual({
            type: "showStashDiff",
            repositoryRoot: "/repo",
            index: 0,
            path: "src/second.ts",
        });

        act(() => {
            file.focus();
            file.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
        });
        expect(document.activeElement).toBe(file);
        expect(lastMessage()).toEqual({
            type: "showStashDiff",
            repositoryRoot: "/repo",
            index: 0,
            path: "src/second.ts",
        });

        unmount(root, container);
    });

    it("posts exact stash-file actions and blocks duplicate cherry-pick mutations", () => {
        const { root, container } = renderStashTab();
        expandStash(container, 0);
        const file = container.querySelector('[data-stash-file="src/second.ts"]') as HTMLElement;

        openRowMenu(file);
        click(menuItem("Open Diff"));
        expect(lastMessage()).toEqual({
            type: "showStashDiff",
            repositoryRoot: "/repo",
            index: 0,
            path: "src/second.ts",
        });

        openRowMenu(file);
        click(menuItem("Edit Source"));
        expect(lastMessage()).toEqual({
            type: "openFile",
            repositoryRoot: "/repo",
            path: "src/second.ts",
        });

        vscode.postMessage.mockClear();
        openRowMenu(file);
        click(menuItem("Cherry-Pick Selected Changes"));
        const requestId = lastRequestId();
        expect(lastMessage()).toEqual({
            type: "cherryPickStashFile",
            repositoryRoot: "/repo",
            index: 0,
            stashHash: "abc",
            path: "src/second.ts",
            requestId,
        });

        openRowMenu(file);
        const pendingAction = menuItem("Cherry-Pick Selected Changes");
        expect(pendingAction.getAttribute("data-disabled")).toBe("true");
        click(pendingAction);
        expect(vscode.postMessage).toHaveBeenCalledTimes(1);

        unmount(root, container);
    });

    it("posts a rootless stash-file cherry-pick from the undocked tab", () => {
        const { root, container } = renderStashTab({ repositoryRoot: undefined });
        expandStash(container, 0);
        const file = container.querySelector('[data-stash-file="src/second.ts"]') as HTMLElement;

        openRowMenu(file);
        const cherryPick = menuItem("Cherry-Pick Selected Changes");
        expect(cherryPick.getAttribute("data-disabled")).toBe("false");
        click(cherryPick);
        const requestId = lastRequestId();
        expect(lastMessage()).toEqual({
            type: "cherryPickStashFile",
            index: 0,
            stashHash: "abc",
            path: "src/second.ts",
            requestId,
        });

        unmount(root, container);
    });

    it("posts every context action with exact mutation and diff payloads", () => {
        const { root, container } = renderStashTab();
        const row = container.querySelector('[data-stash-index="0"]') as HTMLElement;
        const requestIds = new Set<string>();

        for (const [label, expected] of [
            [
                "Pop",
                {
                    type: "stashUnstash",
                    mode: "currentBranch",
                    action: "pop",
                    reinstateIndex: false,
                    index: 0,
                },
            ],
            [
                "Apply",
                {
                    type: "stashUnstash",
                    mode: "currentBranch",
                    action: "apply",
                    reinstateIndex: false,
                    index: 0,
                },
            ],
            ["Drop", { type: "stashDelete", index: 0 }],
            ["Clear", { type: "stashClear" }],
        ] as const) {
            openRowMenu(row);
            click(menuItem(label));
            expect(lastMessage()).toEqual({
                ...expected,
                repositoryRoot: "/repo",
                requestId: expect.stringMatching(REQUEST_ID_PATTERN),
            });
            const requestId = lastRequestId();
            requestIds.add(requestId);
            completeMutation(requestId);
        }
        expect(requestIds.size).toBe(4);

        openRowMenu(row);
        click(menuItem("Unstash…"));
        expect(document.querySelector('[role="dialog"]')).toBeTruthy();
        act(() => {
            document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
        });

        openRowMenu(row);
        click(menuItem("Show Diff"));
        expect(lastMessage()).toEqual({ type: "showStashDiff", repositoryRoot: "/repo", index: 0 });

        openRowMenu(row);
        click(menuItem("Show Diff in a New Tab"));
        expect(lastMessage()).toEqual({
            type: "showStashDiff",
            repositoryRoot: "/repo",
            index: 0,
            preview: false,
        });

        unmount(root, container);
    });

    it("posts Apply and Pop with Reinstate Index from the unstash dialog", () => {
        const { root, container } = renderStashTab();
        const row = container.querySelector('[data-stash-index="0"]') as HTMLElement;

        for (const [checkboxLabel, buttonLabel, action] of [
            [null, "Apply Stash", "apply"],
            ["Pop Stash", "Pop Stash", "pop"],
        ] as const) {
            openRowMenu(row);
            click(menuItem("Unstash…"));
            const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
            if (checkboxLabel) {
                check(
                    dialog.querySelector(
                        `input[aria-label="${checkboxLabel}"]`,
                    ) as HTMLInputElement,
                );
            }
            check(dialog.querySelector('input[aria-label="Reinstate Index"]') as HTMLInputElement);
            click(button(dialog, buttonLabel));
            expect(lastMessage()).toEqual({
                type: "stashUnstash",
                repositoryRoot: "/repo",
                index: 0,
                mode: "currentBranch",
                action,
                reinstateIndex: true,
                requestId: expect.stringMatching(REQUEST_ID_PATTERN),
            });
            completeMutation(lastRequestId());
        }

        unmount(root, container);
    });

    it("validates branch mode and unlocks only on a correlated scoped completion", () => {
        const { root, container } = renderStashTab();
        const row = container.querySelector('[data-stash-index="0"]') as HTMLElement;

        openRowMenu(row);
        click(menuItem("Unstash…"));
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        const branch = dialog.querySelector(
            'input[aria-label="As new branch"]',
        ) as HTMLInputElement;
        const pop = dialog.querySelector('input[aria-label="Pop Stash"]') as HTMLInputElement;
        const reinstate = dialog.querySelector(
            'input[aria-label="Reinstate Index"]',
        ) as HTMLInputElement;
        expect(document.activeElement).toBe(branch);

        changeInput(branch, "bad branch");
        expect(pop.disabled).toBe(true);
        expect(reinstate.disabled).toBe(true);
        click(button(dialog, "Branch"));
        expect(vscode.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "stashUnstash" }),
        );

        changeInput(branch, "feature/restored");
        click(button(dialog, "Branch"));
        expect(lastMessage()).toEqual({
            type: "stashUnstash",
            repositoryRoot: "/repo",
            index: 0,
            mode: "branch",
            branchName: "feature/restored",
            requestId: expect.stringMatching(REQUEST_ID_PATTERN),
        });
        const requestId = lastRequestId();
        const apply = button(container, "Apply");
        expect(apply.disabled).toBe(true);

        completeMutation("wrong-request");
        completeMutation(requestId, "/other-repo");
        expect(apply.disabled).toBe(true);
        completeMutation(requestId);
        expect(apply.disabled).toBe(false);

        click(apply);
        click(apply);
        expect(vscode.postMessage).toHaveBeenCalledTimes(2);

        unmount(root, container);
    });

    it("accepts rootless completion for the undocked tab", () => {
        const { root, container } = renderStashTab({ repositoryRoot: undefined });
        const apply = button(container, "Apply");

        click(apply);
        const requestId = lastRequestId();
        expect(lastMessage()).toEqual({
            type: "stashUnstash",
            index: 0,
            mode: "currentBranch",
            action: "apply",
            reinstateIndex: false,
            requestId,
        });
        expect(apply.disabled).toBe(true);
        completeMutation(requestId, null);
        expect(apply.disabled).toBe(false);

        unmount(root, container);
    });

    it("parses standard WIP messages and hides no-branch labels", () => {
        const wipStashes: StashEntry[] = [
            {
                index: 0,
                message:
                    "WIP on feature/demo: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef Fix the parser",
                date: "2026-07-21",
                hash: "wip",
            },
            {
                index: 1,
                message: "On (no branch): Detached work",
                date: "2026-07-20",
                hash: "detached",
            },
        ];
        const { root, container } = renderStashTab({ stashes: wipStashes });
        const first = container.querySelector('[data-stash-index="0"]') as HTMLElement;
        const second = container.querySelector('[data-stash-index="1"]') as HTMLElement;

        expect(first.textContent).toContain("Fix the parser");
        expect(first.textContent).toContain("feature/demo");
        expect(first.textContent).not.toContain("0123456789abcdef");
        expect(first.textContent).not.toContain("WIP on");
        expect(second.textContent).toContain("Detached work");
        expect(second.textContent).not.toContain("(no branch)");

        unmount(root, container);
    });

    it("shows loading while an expanded stash's files arrive, then its empty state", () => {
        const { root, container } = renderStashTab();
        expandStash(container, 1);
        expect(lastMessage()).toEqual({ type: "stashSelect", repositoryRoot: "/repo", index: 1 });
        expect(stashSubtree(container).textContent).toContain("Loading…");
        expect(container.textContent).not.toContain("No files in this stashed change.");

        act(() => {
            root.render(
                <ChakraProvider theme={theme}>
                    <StashTab
                        repositoryRoot="/repo"
                        currentBranchName="main"
                        stashes={stashes}
                        stashFiles={[]}
                        selectedIndex={1}
                        groupByDir={false}
                        onToggleGroupBy={vi.fn()}
                    />
                </ChakraProvider>,
            );
        });
        expect(stashSubtree(container).textContent).toContain("No files in this stashed change.");

        unmount(root, container);
    });

    it("loads an expanded stash's files once and serves the reopen from cache", () => {
        const { root, container } = renderStashTab();

        expandStash(container, 1);
        expect(lastMessage()).toEqual({ type: "stashSelect", repositoryRoot: "/repo", index: 1 });
        act(() => {
            root.render(
                <ChakraProvider theme={theme}>
                    <StashTab
                        repositoryRoot="/repo"
                        currentBranchName="main"
                        stashes={stashes}
                        stashFiles={files}
                        selectedIndex={1}
                        groupByDir={false}
                        onToggleGroupBy={vi.fn()}
                    />
                </ChakraProvider>,
            );
        });
        expect(container.querySelector('[data-stash-file="src/first.ts"]')).toBeTruthy();

        pressOnStashRow(container, 1, "ArrowLeft");
        expect(container.querySelector('[role="group"]')).toBeNull();
        vscode.postMessage.mockClear();

        // The hash is cached now, so reopening the row costs no second request.
        expandStash(container, 1);
        expect(container.querySelector('[data-stash-file="src/first.ts"]')).toBeTruthy();
        expect(vscode.postMessage).not.toHaveBeenCalled();

        unmount(root, container);
    });

    it("keys cached stash files by hash so a shifted index still shows its own files", () => {
        const { root, container } = renderStashTab();
        expandStash(container, 0);
        expect(container.querySelector('[data-stash-file="src/first.ts"]')).toBeTruthy();

        // Pushing a stash moves "abc" from index 0 to 1; its files travel with its hash.
        const pushed: StashEntry[] = [
            { index: 0, message: "On main: Newest work", date: "2026-07-22 11:00", hash: "ghi" },
            { ...stashes[0]!, index: 1 },
            { ...stashes[1]!, index: 2 },
        ];
        act(() => {
            root.render(
                <ChakraProvider theme={theme}>
                    <StashTab
                        repositoryRoot="/repo"
                        currentBranchName="main"
                        stashes={pushed}
                        stashFiles={[]}
                        selectedIndex={0}
                        groupByDir={false}
                        onToggleGroupBy={vi.fn()}
                    />
                </ChakraProvider>,
            );
        });

        const shifted = container.querySelector('[data-stash-index="1"]') as HTMLElement;
        expect(shifted.getAttribute("aria-expanded")).toBe("true");
        expect(
            container.querySelector('[data-stash-index="0"]')?.getAttribute("aria-expanded"),
        ).toBe("false");
        expect(shifted.querySelector("[data-stash-meta]")?.textContent).toContain("2 files");
        const subtree = stashSubtree(container);
        expect(subtree.querySelector('[data-stash-file="src/first.ts"]')).toBeTruthy();
        expect(subtree.textContent).not.toContain("No files in this stashed change.");

        unmount(root, container);
    });
});
