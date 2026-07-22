// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StashEntry, WorkingFile } from "../../../src/types";
import { StashTab } from "../../../src/webviews/react/commit-panel/components/StashTab";
import { StashUnstashDialog } from "../../../src/webviews/react/commit-panel/components/StashUnstashDialog";
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

/** Finds one visible selected-stash section header by its localized label. */
function stashSectionHeader(filePane: HTMLElement, label: string): HTMLElement {
    const header = Array.from(filePane.children).find((child) =>
        child.textContent?.includes(label),
    ) as HTMLElement | undefined;
    if (!header) throw new Error(`Missing stash section header: ${label}`);
    return header;
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
    it("renders flat stash rows and an honest selected-file region", () => {
        const { root, container } = renderStashTab();
        const list = container.querySelector('[role="listbox"][aria-label="Stashed changes"]');
        const rows = list?.querySelectorAll('[role="option"]') ?? [];
        const filePane = container.querySelector('[data-testid="stash-file-pane"]');

        expect(list).toBeTruthy();
        expect(rows).toHaveLength(2);
        expect(rows[0]?.getAttribute("aria-selected")).toBe("true");
        expect(rows[0]?.querySelector("[aria-expanded]")).toBeNull();
        expect(filePane?.getAttribute("role")).toBe("region");
        expect(filePane?.querySelector('[role="option"]')).toBeNull();
        expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);

        unmount(root, container);
    });

    it("renders flat stash files with only the 18px chevron-equivalent spacer before each icon", () => {
        const ignoredFile: WorkingFile = {
            path: "ignored.log",
            status: "!",
            staged: false,
            additions: 0,
            deletions: 0,
        };
        const { root, container } = renderStashTab({ stashFiles: [...files, ignoredFile] });
        const filePane = container.querySelector('[data-testid="stash-file-pane"]') as HTMLElement;
        const file = container.querySelector('[data-stash-file="src/first.ts"]') as HTMLElement;
        const otherFile = container.querySelector('[data-stash-file="src/second.ts"]') as HTMLElement;
        const ignored = container.querySelector('[data-stash-file="ignored.log"]') as HTMLElement;

        expect(file.tagName).toBe("BUTTON");
        expect(file.textContent).toContain("first.ts");
        expect(file.textContent).toContain("src");
        expect(file.textContent).toContain("+1");
        expect(file.textContent).toContain("M");
        expect(filePane.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
        for (const stashFile of [file, otherFile, ignored]) {
            const chevronSpacer = stashFile.querySelector('[data-tree-icon="file"]')
                ?.previousElementSibling as HTMLElement;
            expect(getComputedStyle(chevronSpacer).width).toBe("18px");
        }
        expect(file.getAttribute("data-vscode-context")).toBeNull();
        expect(file.getAttribute("aria-selected")).toBe("true");
        expect(otherFile.getAttribute("aria-selected")).toBe("false");

        click(otherFile);
        expect(file.getAttribute("aria-selected")).toBe("false");
        expect(otherFile.getAttribute("aria-selected")).toBe("true");
        expect(otherFile.getAttribute("aria-current")).toBe("true");

        unmount(root, container);
    });

    it("separates stash changes from unversioned files with counts, stats, and labels directly after chevrons", () => {
        const unversionedFile: WorkingFile = {
            path: "new-file.ts",
            status: "?",
            staged: false,
            additions: 4,
            deletions: 2,
        };
        const { root, container } = renderStashTab({ stashFiles: [...files, unversionedFile] });
        const filePane = container.querySelector('[data-testid="stash-file-pane"]') as HTMLElement;
        const changes = stashSectionHeader(filePane, "Changes");
        const unversioned = stashSectionHeader(filePane, "Unversioned Files");
        const labelAfterChevron = changes.querySelector("svg")?.nextElementSibling as HTMLElement;

        expect(changes.textContent).toContain("2 files");
        expect(changes.textContent).toContain("+3");
        expect(unversioned.textContent).toContain("1 file");
        expect(unversioned.textContent).toContain("+4");
        expect(changes.querySelector("svg")).toBeTruthy();
        expect(unversioned.querySelector("svg")).toBeTruthy();
        expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
        expect(labelAfterChevron.textContent).toBe("Changes");
        expect(labelAfterChevron.getAttribute("aria-hidden")).toBeNull();

        unmount(root, container);
    });

    it("keeps a zero-count Changes section for an unversioned-only stash", () => {
        const unversionedFile: WorkingFile = {
            path: "only-new.ts",
            status: "?",
            staged: false,
            additions: 1,
            deletions: 0,
        };
        const { root, container } = renderStashTab({ stashFiles: [unversionedFile] });
        const filePane = container.querySelector('[data-testid="stash-file-pane"]') as HTMLElement;

        expect(stashSectionHeader(filePane, "Changes").textContent).toContain("0 files");
        expect(stashSectionHeader(filePane, "Unversioned Files").textContent).toContain("1 file");
        expect(container.querySelector('[data-stash-file="only-new.ts"]')).toBeTruthy();

        unmount(root, container);
    });

    it("preserves stash-file selection across section collapse and reopen", () => {
        const unversionedFile: WorkingFile = {
            path: "new-file.ts",
            status: "?",
            staged: false,
            additions: 1,
            deletions: 0,
        };
        const { root, container } = renderStashTab({ stashFiles: [...files, unversionedFile] });
        const filePane = container.querySelector('[data-testid="stash-file-pane"]') as HTMLElement;
        const file = container.querySelector('[data-stash-file="src/second.ts"]') as HTMLElement;
        const changes = stashSectionHeader(filePane, "Changes");

        click(file);
        expect(file.getAttribute("aria-current")).toBe("true");
        click(changes);
        expect(container.querySelector('[data-stash-file="src/second.ts"]')).toBeNull();
        click(changes);
        expect(container.querySelector('[data-stash-file="src/second.ts"]')?.getAttribute("aria-current")).toBe(
            "true",
        );

        unmount(root, container);
    });

    it("preserves collapsed stash sections while the selected stash changes", () => {
        const { root, container } = renderStashTab();
        const filePane = container.querySelector('[data-testid="stash-file-pane"]') as HTMLElement;

        click(stashSectionHeader(filePane, "Changes"));
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

        expect(container.querySelector('[data-stash-file="src/first.ts"]')).toBeNull();
        expect(
            stashSectionHeader(
                container.querySelector('[data-testid="stash-file-pane"]') as HTMLElement,
                "Changes",
            ),
        ).toBeTruthy();

        unmount(root, container);
    });

    it("uses stash files, not directories, to enable section expand and collapse controls", () => {
        const { root, container } = renderStashTab();
        const collapse = container.querySelector('button[aria-label="Collapse All"]') as HTMLButtonElement;
        const expand = container.querySelector('button[aria-label="Expand All"]') as HTMLButtonElement;

        expect(collapse.disabled).toBe(false);
        expect(expand.disabled).toBe(false);
        click(collapse);
        expect(container.querySelector('[data-stash-file="src/first.ts"]')).toBeNull();
        click(expand);
        expect(container.querySelector('[data-stash-file="src/first.ts"]')).toBeTruthy();

        unmount(root, container);
    });

    it("expands collapsed stash sections and grouped directories together", () => {
        const { root, container } = renderStashTab({ groupByDir: true });
        const collapse = container.querySelector('button[aria-label="Collapse All"]') as HTMLButtonElement;
        const expand = container.querySelector('button[aria-label="Expand All"]') as HTMLButtonElement;

        click(collapse);
        expect(container.querySelector('button[title="src"]')).toBeNull();
        click(expand);
        expect(container.querySelector('button[title="src"]')).toBeTruthy();
        expect(container.querySelector('[data-stash-file="src/first.ts"]')).toBeTruthy();

        unmount(root, container);
    });

    it("renders grouped stash folders with icons directly after chevrons and no inputs or redundant parent paths", () => {
        const { root, container } = renderStashTab({ groupByDir: true });
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
        expect(getComputedStyle(fileChevronSpacer).width).toBe("18px");

        click(folder);
        expect(container.querySelector('[data-stash-file="src/first.ts"]')).toBeNull();
        expect(folder.getAttribute("aria-expanded")).toBe("false");

        unmount(root, container);
    });

    it("supports listbox navigation and keyboard context-menu activation", () => {
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

    it("shows loading for optimistic selection before showing a completed empty response", () => {
        const { root, container } = renderStashTab();
        click(container.querySelector('[data-stash-index="1"]') as HTMLElement);
        expect(container.querySelector('[data-testid="stash-file-pane"]')?.textContent).toContain(
            "Loading...",
        );
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
        expect(container.querySelector('[data-testid="stash-file-pane"]')?.textContent).toContain(
            "No files in this stashed change.",
        );

        unmount(root, container);
    });

    it("keeps truthful splitter values and clamps after container resize or input", () => {
        let tabHeight = 400;
        let triggerResize = (): void => undefined;
        const resizeObserverInstance = {
            observe: vi.fn(),
            unobserve: vi.fn(),
            disconnect: vi.fn(),
        };
        const ResizeObserverMock = vi.fn(function (callback: ResizeObserverCallback) {
            triggerResize = () => callback([], resizeObserverInstance as unknown as ResizeObserver);
            return resizeObserverInstance;
        });
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        const clientHeightSpy = vi
            .spyOn(HTMLElement.prototype, "clientHeight", "get")
            .mockImplementation(function (this: HTMLElement) {
                return this.dataset.testid === "stash-tab" ? tabHeight : 0;
            });
        const { root, container } = renderStashTab();
        const splitter = container.querySelector('[role="separator"]') as HTMLElement;
        const list = container.querySelector('[data-testid="stash-list"]') as HTMLElement;

        expect(splitter.getAttribute("aria-valuemin")).toBe("100");
        expect(splitter.getAttribute("aria-valuemax")).toBe("234");
        expect(splitter.getAttribute("aria-valuenow")).toBe("220");

        tabHeight = 300;
        act(() => triggerResize());
        expect(splitter.getAttribute("aria-valuemax")).toBe("134");
        expect(splitter.getAttribute("aria-valuenow")).toBe("134");
        expect(Number.parseFloat(list.style.height)).toBe(134);

        tabHeight = 400;
        act(() => triggerResize());
        expect(splitter.getAttribute("aria-valuemax")).toBe("234");

        act(() => {
            splitter.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 100 }),
            );
            document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 1000 }));
            document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
        const pointerHeight = Number.parseFloat(list.style.height);
        expect(pointerHeight).toBeLessThanOrEqual(234);

        act(() => {
            splitter.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }),
            );
        });
        expect(Number.parseFloat(list.style.height)).toBeLessThanOrEqual(234);
        act(() => {
            splitter.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
        });
        expect(Number.parseFloat(list.style.height)).toBeLessThan(pointerHeight);

        unmount(root, container);
        clientHeightSpy.mockRestore();
        vi.unstubAllGlobals();
    });
});
