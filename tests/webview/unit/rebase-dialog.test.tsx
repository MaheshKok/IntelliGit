// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractiveRebaseRangeCommit } from "../../../src/git/interactiveRebase/types";
import { validateRebaseSubmission } from "../../../src/git/interactiveRebase/todo";
import { RebaseDialog } from "../../../src/webviews/react/shared/components/RebaseDialog/RebaseDialog";
import { CommitGraphPanel } from "../../../src/webviews/react/CommitGraphPanel";
import { NativeCommitGraph } from "../../../src/webviews/react/NativeCommitGraph";
import { formatDateTime } from "../../../src/webviews/react/shared/date";
import theme from "../../../src/webviews/react/commit-panel/theme";
import {
    flush,
    initReactDomTestEnvironment,
    mount,
    unmount,
} from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

const commits: InteractiveRebaseRangeCommit[] = [
    {
        hash: "a".repeat(40),
        authorName: "Ada",
        authoredAt: "2026-01-01",
        body: "Oldest subject\nOldest body",
        isPushed: false,
    },
    {
        hash: "b".repeat(40),
        authorName: "Ben",
        authoredAt: "2026-01-02",
        body: "Middle subject\nMiddle body",
        isPushed: true,
    },
    {
        hash: "c".repeat(40),
        authorName: "Cy",
        authoredAt: "2026-01-03",
        body: "Newest subject",
        isPushed: false,
    },
];

function render(overrides: Partial<React.ComponentProps<typeof RebaseDialog>> = {}) {
    const onSubmit = vi.fn();
    const view = mount(
        <ChakraProvider theme={theme}>
            <RebaseDialog commits={commits} onCancel={vi.fn()} onSubmit={onSubmit} {...overrides} />
        </ChakraProvider>,
    );
    return { ...view, onSubmit };
}

function click(element: Element): void {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function change(element: HTMLSelectElement | HTMLTextAreaElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    if (!setter) throw new Error("Missing native value setter");
    act(() => {
        setter.call(element, value);
        element.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

function row(container: HTMLElement, hash: string): HTMLElement {
    return container.querySelector(`[data-rebase-hash="${hash}"]`) as HTMLElement;
}

function createDataTransfer(): DataTransfer {
    if (typeof DataTransfer === "function") return new DataTransfer();
    const data = new Map<string, string>();
    return {
        effectAllowed: "uninitialized",
        dropEffect: "none",
        getData: (format) => data.get(format) ?? "",
        setData: (format, value) => data.set(format, value),
    } as DataTransfer;
}

function dispatchDrag(
    element: HTMLElement,
    type: "dragstart" | "dragover" | "drop",
    dataTransfer: DataTransfer,
): DragEvent {
    const event =
        typeof DragEvent === "function"
            ? new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer })
            : new Event(type, { bubbles: true, cancelable: true });
    if (!("dataTransfer" in event)) {
        Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    }
    act(() => element.dispatchEvent(event));
    return event as DragEvent;
}

describe("RebaseDialog", () => {
    it("renders offered commits oldest first with the pushed warning", () => {
        const { root, container } = render();
        expect(
            Array.from(container.querySelectorAll("[data-rebase-hash]")).map((entry) =>
                entry.getAttribute("data-rebase-hash"),
            ),
        ).toEqual(commits.map((commit) => commit.hash));
        expect(container.textContent).toContain("Oldest subject");
        expect(container.textContent).toContain("Ada");
        expect(container.textContent).toContain(formatDateTime(commits[0].authoredAt));
        expect(container.textContent).toContain("Some commits have already been pushed");
        expect(
            (
                row(container, commits[0].hash).querySelector(
                    'option[value="squash"]',
                ) as HTMLOptionElement
            ).disabled,
        ).toBe(true);
        unmount(root, container);
    });

    it("edits reword and squash messages, including squash target prefill", () => {
        const { root, container } = render();
        const middle = row(container, commits[1].hash);
        change(middle.querySelector("select") as HTMLSelectElement, "reword");
        const reword = middle.querySelector("textarea") as HTMLTextAreaElement;
        expect(reword.value).toBe(commits[1].body);
        change(reword, "Edited message");
        change(middle.querySelector("select") as HTMLSelectElement, "squash");
        const squash = middle.querySelector("textarea") as HTMLTextAreaElement;
        expect(squash.value).toBe(`${commits[0].body}\n\n${commits[1].body}`);
        unmount(root, container);
    });

    it("reorders by buttons and drag-and-drop", () => {
        const { root, container } = render();
        click(
            row(container, commits[1].hash).querySelector(
                '[aria-label="Move commit up"]',
            ) as HTMLButtonElement,
        );
        expect(
            Array.from(container.querySelectorAll("[data-rebase-hash]")).map((entry) =>
                entry.getAttribute("data-rebase-hash"),
            ),
        ).toEqual([commits[1].hash, commits[0].hash, commits[2].hash]);
        const dataTransfer = createDataTransfer();
        dispatchDrag(row(container, commits[2].hash), "dragstart", dataTransfer);
        expect(dataTransfer.getData("text/plain")).toBe(commits[2].hash);
        expect(dataTransfer.effectAllowed).toBe("move");
        const dragOver = dispatchDrag(row(container, commits[1].hash), "dragover", dataTransfer);
        expect(dragOver.defaultPrevented).toBe(true);
        expect(dataTransfer.dropEffect).toBe("move");
        dispatchDrag(row(container, commits[1].hash), "drop", dataTransfer);
        expect(
            Array.from(container.querySelectorAll("[data-rebase-hash]")).map((entry) =>
                entry.getAttribute("data-rebase-hash"),
            ),
        ).toEqual([commits[2].hash, commits[1].hash, commits[0].hash]);
        unmount(root, container);
    });

    it("clears a promoted squash action and shows a notice after action, reorder, and drop changes", () => {
        const { root, container } = render();
        change(
            row(container, commits[1].hash).querySelector("select") as HTMLSelectElement,
            "squash",
        );
        change(
            row(container, commits[0].hash).querySelector("select") as HTMLSelectElement,
            "drop",
        );
        expect(row(container, commits[1].hash).querySelector("select")?.value).toBe("pick");
        expect(container.textContent).toContain("changed to pick");
        unmount(root, container);
    });

    it("clears a squash action promoted to first by button reordering", () => {
        const { root, container } = render();
        change(
            row(container, commits[1].hash).querySelector("select") as HTMLSelectElement,
            "squash",
        );
        click(
            row(container, commits[1].hash).querySelector(
                '[aria-label="Move commit up"]',
            ) as HTMLButtonElement,
        );
        expect(row(container, commits[1].hash).querySelector("select")?.value).toBe("pick");
        expect(container.textContent).toContain("changed to pick");
        unmount(root, container);
    });

    it("submits exactly the current ordered entries and hides the warning when none are pushed", () => {
        const { root, container, onSubmit } = render({
            commits: commits.map((commit) => ({ ...commit, isPushed: false })),
        });
        expect(container.textContent).not.toContain("Some commits have already been pushed");
        change(
            row(container, commits[1].hash).querySelector("select") as HTMLSelectElement,
            "reword",
        );
        change(
            row(container, commits[1].hash).querySelector("textarea") as HTMLTextAreaElement,
            "Edited middle",
        );
        click(
            Array.from(container.querySelectorAll("button")).find(
                (button) => button.textContent === "Start Rebasing",
            ) as HTMLButtonElement,
        );
        expect(onSubmit).toHaveBeenCalledWith([
            { hash: commits[0].hash, action: "pick" },
            { hash: commits[1].hash, action: "reword", message: "Edited middle" },
            { hash: commits[2].hash, action: "pick" },
        ]);
        unmount(root, container);
    });

    it("disables submission and identifies every reword or squash row with a missing message", () => {
        const { root, container } = render();
        const middle = row(container, commits[1].hash);
        change(middle.querySelector("select") as HTMLSelectElement, "reword");
        change(middle.querySelector("textarea") as HTMLTextAreaElement, " \n ");

        expect(
            Array.from(container.querySelectorAll("button")).find(
                (button) => button.textContent === "Start Rebasing",
            ),
        ).toHaveProperty("disabled", true);
        expect(middle.querySelector("textarea")?.getAttribute("aria-invalid")).toBe("true");
        expect(container.querySelector("[data-rebase-missing-message]")?.textContent).toBe(
            `A commit message is required for: ${commits[1].hash.slice(0, 8)}`,
        );
        unmount(root, container);
    });

    it("traps Tab navigation inside the modal while retaining the initial focus target", () => {
        const { root, container } = render();
        const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
        const controls = Array.from(
            dialog.querySelectorAll<HTMLElement>("button:not([disabled]), select, textarea"),
        );
        const first = controls[0];
        const last = controls.at(-1) as HTMLElement;

        expect(document.activeElement).toBe(
            Array.from(container.querySelectorAll("button")).find(
                (button) => button.textContent === "Cancel",
            ),
        );
        last.focus();
        act(() => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
        expect(document.activeElement).toBe(first);
        unmount(root, container);
    });

    it("reseeds for a changed offered range without clobbering edits for the same hashes", () => {
        const onSubmit = vi.fn();
        const onCancel = vi.fn();
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
                <RebaseDialog commits={commits} onCancel={onCancel} onSubmit={onSubmit} />
            </ChakraProvider>,
        );
        const middle = row(container, commits[1].hash);
        change(middle.querySelector("select") as HTMLSelectElement, "reword");
        change(middle.querySelector("textarea") as HTMLTextAreaElement, "User draft");

        act(() => {
            root.render(
                <ChakraProvider theme={theme}>
                    <RebaseDialog
                        commits={commits.map((commit) => ({ ...commit }))}
                        onCancel={onCancel}
                        onSubmit={onSubmit}
                    />
                </ChakraProvider>,
            );
        });
        expect(row(container, commits[1].hash).querySelector("textarea")?.value).toBe("User draft");

        const replacement = [commits[2], commits[0]];
        act(() => {
            root.render(
                <ChakraProvider theme={theme}>
                    <RebaseDialog commits={replacement} onCancel={onCancel} onSubmit={onSubmit} />
                </ChakraProvider>,
            );
        });
        expect(
            Array.from(container.querySelectorAll("[data-rebase-hash]")).map((entry) =>
                entry.getAttribute("data-rebase-hash"),
            ),
        ).toEqual(replacement.map((commit) => commit.hash));
        unmount(root, container);
    });

    it("submits dialog output accepted by the real validator after realistic rebase editing", () => {
        const range = [
            ...commits,
            {
                hash: "d".repeat(40),
                authorName: "Dee",
                authoredAt: "2026-01-04",
                body: "Second squash subject\nSecond squash body",
                isPushed: false,
            },
            {
                hash: "e".repeat(40),
                authorName: "Eve",
                authoredAt: "2026-01-05",
                body: "Fixup subject\nFixup body",
                isPushed: false,
            },
            {
                hash: "f".repeat(40),
                authorName: "Fox",
                authoredAt: "2026-01-06",
                body: "Drop subject\nDrop body",
                isPushed: false,
            },
        ];
        const { root, container, onSubmit } = render({ commits: range });

        change(
            row(container, range[1].hash).querySelector("select") as HTMLSelectElement,
            "reword",
        );
        change(
            row(container, range[1].hash).querySelector("textarea") as HTMLTextAreaElement,
            "Reworded subject\n\nReworded body",
        );
        change(
            row(container, range[2].hash).querySelector("select") as HTMLSelectElement,
            "squash",
        );
        change(
            row(container, range[3].hash).querySelector("select") as HTMLSelectElement,
            "squash",
        );
        change(row(container, range[4].hash).querySelector("select") as HTMLSelectElement, "fixup");
        change(row(container, range[5].hash).querySelector("select") as HTMLSelectElement, "drop");
        click(
            row(container, range[5].hash).querySelector(
                '[aria-label="Move commit up"]',
            ) as HTMLButtonElement,
        );
        click(
            Array.from(container.querySelectorAll("button")).find(
                (button) => button.textContent === "Start Rebasing",
            ) as HTMLButtonElement,
        );

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(
            validateRebaseSubmission(
                onSubmit.mock.calls[0][0],
                new Set(range.map((commit) => commit.hash)),
            ),
        ).toMatchObject({ status: "valid" });
        unmount(root, container);
    });
});

describe("commit-list rebase dialog hosts", () => {
    const offer = (requestId: string) => ({
        type: "showRebaseDialog" as const,
        requestId,
        commits,
        branch: "main",
        hasPushed: true,
    });

    function exerciseHost(Host: typeof CommitGraphPanel | typeof NativeCommitGraph): void {
        const postMessage = vi.fn();
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
                <Host
                    vscode={{ postMessage, getState: () => undefined, setState: vi.fn() } as never}
                    sendReady={false}
                />
            </ChakraProvider>,
        );
        act(() => window.dispatchEvent(new MessageEvent("message", { data: offer("first") })));
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
        act(() => window.dispatchEvent(new MessageEvent("message", { data: offer("second") })));
        expect(postMessage).toHaveBeenCalledWith({
            type: "cancelRebaseDialog",
            requestId: "first",
        });
        click(
            Array.from(container.querySelectorAll("button")).find(
                (button) => button.textContent === "Start Rebasing",
            ) as HTMLButtonElement,
        );
        expect(postMessage).toHaveBeenLastCalledWith({
            type: "startInteractiveRebase",
            requestId: "second",
            entries: commits.map((commit) => ({ hash: commit.hash, action: "pick" })),
        });
        expect(container.querySelector('[role="dialog"]')).toBeNull();
        act(() => window.dispatchEvent(new MessageEvent("message", { data: offer("third") })));
        click(
            Array.from(container.querySelectorAll("button")).find(
                (button) => button.textContent === "Cancel",
            ) as HTMLButtonElement,
        );
        expect(postMessage).toHaveBeenLastCalledWith({
            type: "cancelRebaseDialog",
            requestId: "third",
        });
        unmount(root, container);
    }

    it("mounts and settles the dialog in the docked graph host", () => {
        exerciseHost(CommitGraphPanel);
    });

    it("mounts and settles the dialog in the compact graph host", () => {
        exerciseHost(NativeCommitGraph);
    });
});

describe("UndockedApp rebase dialog host", () => {
    const offer = (requestId: string) => ({
        type: "showRebaseDialog" as const,
        requestId,
        commits,
        branch: "main",
        hasPushed: true,
    });

    function installVsCodeMock() {
        const api = {
            postMessage: vi.fn(),
            getState: vi.fn(() => ({})),
            setState: vi.fn(),
        };
        Object.defineProperty(globalThis, "acquireVsCodeApi", {
            configurable: true,
            value: vi.fn(() => api),
        });
        installWebviewI18n();
        return api;
    }

    function mockUndockedChildren(): void {
        vi.doMock("../../../src/webviews/react/BranchColumn", () => ({
            BranchColumn: () => <div>Branches</div>,
        }));
        vi.doMock("../../../src/webviews/react/CommitList", () => ({
            CommitList: () => <div>Graph</div>,
        }));
        vi.doMock("../../../src/webviews/react/commit-info/CommitInfoPane", () => ({
            CommitInfoPane: () => <div>Info</div>,
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/TabBar", () => ({
            TabBar: ({ commitContent }: { commitContent: React.ReactNode }) => (
                <div>{commitContent}</div>
            ),
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/CommitTab", () => ({
            CommitTab: () => <div>Commit</div>,
        }));
        vi.doMock("../../../src/webviews/react/commit-panel/components/StashTab", () => ({
            StashTab: () => <div>Stash</div>,
        }));
    }

    async function mountUndocked() {
        const root = document.createElement("div");
        root.id = "root";
        document.body.appendChild(root);
        const vscode = installVsCodeMock();
        mockUndockedChildren();
        await act(async () => {
            await import("../../../src/webviews/react/UndockedApp");
        });
        await flush();
        return vscode;
    }

    function send(message: ReturnType<typeof offer>): void {
        act(() => window.dispatchEvent(new MessageEvent("message", { data: message })));
    }

    function rebaseMessages(vscode: ReturnType<typeof installVsCodeMock>) {
        return vscode.postMessage.mock.calls
            .map(([message]) => message)
            .filter(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    "type" in message &&
                    (message.type === "startInteractiveRebase" ||
                        message.type === "cancelRebaseDialog"),
            );
    }

    beforeEach(() => {
        vi.resetModules();
        document.body.replaceChildren();
    });

    afterEach(() => {
        vi.doUnmock("../../../src/webviews/react/BranchColumn");
        vi.doUnmock("../../../src/webviews/react/CommitList");
        vi.doUnmock("../../../src/webviews/react/commit-info/CommitInfoPane");
        vi.doUnmock("../../../src/webviews/react/commit-panel/components/TabBar");
        vi.doUnmock("../../../src/webviews/react/commit-panel/components/CommitTab");
        vi.doUnmock("../../../src/webviews/react/commit-panel/components/StashTab");
    });

    it("settles each offered dialog exactly once with its own request id and current entries", async () => {
        const vscode = await mountUndocked();
        vscode.postMessage.mockClear();

        send(offer("submit-request"));
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        click(
            row(document.body, commits[1].hash).querySelector(
                '[aria-label="Move commit up"]',
            ) as HTMLButtonElement,
        );
        click(
            Array.from(document.querySelectorAll("button")).find(
                (button) => button.textContent === "Start Rebasing",
            ) as HTMLButtonElement,
        );
        expect(rebaseMessages(vscode)).toEqual([
            {
                type: "startInteractiveRebase",
                requestId: "submit-request",
                entries: [
                    { hash: commits[1].hash, action: "pick" },
                    { hash: commits[0].hash, action: "pick" },
                    { hash: commits[2].hash, action: "pick" },
                ],
            },
        ]);
        expect(document.querySelector('[role="dialog"]')).toBeNull();

        vscode.postMessage.mockClear();
        send(offer("cancel-request"));
        click(
            Array.from(document.querySelectorAll("button")).find(
                (button) => button.textContent === "Cancel",
            ) as HTMLButtonElement,
        );
        expect(rebaseMessages(vscode)).toEqual([
            { type: "cancelRebaseDialog", requestId: "cancel-request" },
        ]);

        vscode.postMessage.mockClear();
        send(offer("superseded-request"));
        send(offer("replacement-request"));
        expect(rebaseMessages(vscode)).toEqual([
            { type: "cancelRebaseDialog", requestId: "superseded-request" },
        ]);
        click(
            Array.from(document.querySelectorAll("button")).find(
                (button) => button.textContent === "Cancel",
            ) as HTMLButtonElement,
        );
        expect(rebaseMessages(vscode)).toEqual([
            { type: "cancelRebaseDialog", requestId: "superseded-request" },
            { type: "cancelRebaseDialog", requestId: "replacement-request" },
        ]);
    });
});
