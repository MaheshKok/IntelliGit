// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileHistoryState } from "../../../src/webviews/protocol/fileHistory";
import type { DiffViewerHost } from "../../../src/webviews/react/diff-viewer/diffViewerHost";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

// Contract tests mock only the existing viewer; its rendering has a separate integration suite.
vi.mock("../../../src/webviews/react/diff-viewer/DiffViewer", () => ({
    DiffViewer: ({ host }: { host: DiffViewerHost }) => (
        <div data-testid="shared-viewer" data-editable={host.data?.editablePane ?? "none"}>
            {host.data?.leftLabel ?? host.error ?? "pending"}
            <button onClick={host.handleIgnoreMode}>whitespace</button>
        </div>
    ),
}));

const labels = Object.fromEntries(
    "branch refresh search more empty select details copy open local diff affected author date subject resize actions"
        .split(" ")
        .map((key) => [key, key]),
);
const state: FileHistoryState = {
    path: "src/main.ts",
    root: "/repo",
    ref: "HEAD",
    branches: ["main"],
    hasMore: true,
    labels,
    entries: ["Newest", "Middle", "Oldest"].map((subject, index) => ({
        hash: String(index + 1).repeat(40),
        parents: [],
        subject,
        authorName: "A Person",
        authorEmail: "a@example.test",
        authoredAt: "2026-09-12T10:00:00Z",
        committerName: "A Person",
        committerEmail: "a@example.test",
        committedAt: "2026-09-12T10:00:00Z",
        pathAtRevision: "src/main.ts",
        status: "modified",
    })),
};
let root: import("react-dom/client").Root | null;
let postMessage: ReturnType<typeof vi.fn>;

/** Delivers a host response inside React's update boundary. */
function message(data: unknown): void {
    act(() => window.dispatchEvent(new MessageEvent("message", { data })));
}
/** Clicks one history row with platform selection modifiers. */
function row(index: number, options: MouseEventInit = {}): void {
    const item = document.querySelectorAll('[role="option"]')[index];
    expect(item).toBeDefined();
    act(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true, ...options })));
}
/** Returns the latest request posted by selection. */
function selection(): {
    hashes: string[];
    requestId: number;
    local?: boolean;
    ignoreWhitespace?: boolean;
} {
    return postMessage.mock.calls
        .map(([value]) => value)
        .filter((value) => value.type === "historySelect")
        .at(-1);
}
/** Activates a localized toolbar action. */
function button(label: string): void {
    const target = [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
        (node) => node.textContent === label || node.getAttribute("aria-label") === label,
    );
    expect(target).toBeDefined();
    act(() => target!.click());
}

beforeEach(async () => {
    vi.resetModules();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    postMessage = vi.fn();
    Object.defineProperty(globalThis, "acquireVsCodeApi", {
        configurable: true,
        value: () => ({ postMessage, getState: () => null, setState: vi.fn() }),
    });
    installWebviewI18n();
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
        root = (await import("../../../src/webviews/react/file-history/FileHistoryApp")).root;
    });
});
afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = "";
});

describe("standalone file history message and shared viewer contract", () => {
    it("subscribes before announcing ready and previews the first commit", () => {
        expect(postMessage).toHaveBeenCalledWith({ type: "historyReady" });
        message({ type: "historyState", state });
        expect(selection().hashes).toEqual([state.entries[0].hash]);
        expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
    });
    it("clears the existing preview immediately and rejects a late previous response", () => {
        message({ type: "historyState", state });
        const first = selection().requestId;
        message({
            type: "historyDiff",
            requestId: first,
            data: { leftLabel: "first-preview", segments: [] },
        });
        expect(document.body.textContent).toContain("first-preview");
        row(1);
        expect(document.body.textContent).not.toContain("first-preview");
        message({
            type: "historyDiff",
            requestId: first,
            data: { leftLabel: "stale-preview", segments: [] },
        });
        expect(document.body.textContent).not.toContain("stale-preview");
        message({
            type: "historyDiff",
            requestId: selection().requestId,
            data: { leftLabel: "current-preview", segments: [], editablePane: "left" },
        });
        expect(document.querySelector('[data-testid="shared-viewer"]')?.textContent).toContain(
            "current-preview",
        );
        expect(
            document.querySelector('[data-testid="shared-viewer"]')?.getAttribute("data-editable"),
        ).toBe("none");
    });
    it("compares ordered selection endpoints for modifier and range selection", () => {
        message({ type: "historyState", state });
        row(2, { metaKey: true });
        expect(selection().hashes).toEqual([state.entries[0].hash, state.entries[2].hash]);
        row(0);
        row(2, { shiftKey: true });
        expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(3);
        expect(selection().hashes).toEqual([state.entries[0].hash, state.entries[2].hash]);
    });
    it("reloads whitespace and local comparison through history messages and delegates actions", () => {
        message({ type: "historyState", state });
        button("actions");
        button("local");
        expect(selection().local).toBe(true);
        message({
            type: "historyDiff",
            requestId: selection().requestId,
            data: { leftLabel: "local-preview", segments: [] },
        });
        button("whitespace");
        expect(selection()).toMatchObject({ local: true, ignoreWhitespace: true });
        button("actions");
        button("copy");
        expect(postMessage).toHaveBeenCalledWith({
            type: "historyAction",
            action: "copy",
            hash: state.entries[0].hash,
        });
        button("more");
        expect(postMessage).toHaveBeenCalledWith({ type: "historyMore" });
    });
    it("refreshes the selected revision preview when the ref is unchanged", () => {
        message({ type: "historyState", state });
        row(1);
        const oldRequest = selection().requestId;
        message({ type: "historyDiff", requestId: oldRequest, data: { leftLabel: "old-preview", segments: [] } });
        button("refresh");
        expect(document.body.textContent).not.toContain("old-preview");
        expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
        message({ type: "historyState", state });
        expect(selection().hashes).toEqual([state.entries[1].hash]);
        expect(selection().requestId).toBeGreaterThan(oldRequest);
        message({ type: "historyDiff", requestId: selection().requestId, data: { leftLabel: "refreshed-preview", segments: [] } });
        expect(document.body.textContent).toContain("refreshed-preview");
    });
    it("invalidates preview on refresh and renders host failures", () => {
        message({ type: "historyState", state });
        const oldRequest = selection().requestId;
        button("refresh");
        expect(postMessage).toHaveBeenCalledWith({ type: "historyRefresh", ref: "HEAD" });
        message({
            type: "historyDiff",
            requestId: oldRequest,
            data: { leftLabel: "stale-refresh", segments: [] },
        });
        expect(document.body.textContent).not.toContain("stale-refresh");
        message({ type: "historyError", message: "Git unavailable" });
        expect(document.querySelector('[role="alert"]')?.textContent).toContain("Git unavailable");
    });
    it("filters loaded rows, clears the preview, and rejects its late response", () => {
        message({ type: "historyState", state });
        const oldRequest = selection().requestId;
        button("search");
        const input = document.querySelector("input")!;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
                input,
                "Oldest",
            );
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
        expect(document.querySelector('[data-testid="shared-viewer"]')).toBeNull();
        const messagesBeforeReload = postMessage.mock.calls.length;
        message({ type: "historyState", state });
        expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(0);
        expect(postMessage.mock.calls).toHaveLength(messagesBeforeReload);
        message({
            type: "historyDiff",
            requestId: oldRequest,
            data: { leftLabel: "stale-search", segments: [] },
        });
        row(0);
        expect(selection().hashes).toEqual([state.entries[2].hash]);
        expect(document.body.textContent).not.toContain("stale-search");
        const visibleRow = document.querySelector<HTMLElement>('[role="option"]')!;
        act(() => {
            visibleRow.focus();
            visibleRow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        expect(document.activeElement).toBe(visibleRow);
        button("search");
        expect(document.querySelector("input")).toBeNull();
        expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
    });
    it("changes branch through the host and disables old rows until the new snapshot", () => {
        message({ type: "historyState", state });
        const select = document.querySelector("select")!;
        act(() => {
            select.value = "main";
            select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(postMessage).toHaveBeenCalledWith({ type: "historyRefresh", ref: "main" });
        expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
        message({ type: "historyState", state: { ...state, ref: "main" } });
        expect(selection().hashes).toEqual([state.entries[0].hash]);
    });
    it("extends keyboard selection, resizes with arrow keys, and preserves selection on more history", () => {
        message({ type: "historyState", state });
        row(0);
        const first = document.querySelector<HTMLElement>('[role="option"]')!;
        act(() => {
            first.focus();
            first.dispatchEvent(
                new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }),
            );
        });
        expect(selection().hashes).toEqual([state.entries[0].hash, state.entries[1].hash]);
        expect(document.activeElement?.textContent).toContain("Middle");
        message({ type: "historyState", state: { ...state, hasMore: false } });
        expect(selection().hashes).toEqual([state.entries[0].hash, state.entries[1].hash]);
        const divider = document.querySelector('[role="separator"]')!;
        act(() =>
            divider.dispatchEvent(
                new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
            ),
        );
        expect(divider.getAttribute("aria-valuenow")).toBe("43");
    });
    it("keeps the compact controls in the list and hides details until requested", () => {
        message({ type: "historyState", state });
        expect(
            document.querySelector(".file-history-list-panel .file-history-toolbar"),
        ).not.toBeNull();
        expect(
            document.querySelector(
                ".file-history-path, .file-history-columns, .file-history-actions",
            ),
        ).toBeNull();
        expect(document.querySelector(".file-history-details")).toBeNull();
        expect(document.querySelector('[role="option"] time')?.textContent).toBe(
            new Date(state.entries[0].authoredAt).toLocaleString(undefined, {
                year: "2-digit",
                month: "numeric",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
            }),
        );
        button("details");
        expect(document.querySelector(".file-history-details")?.textContent).toContain(
            state.entries[0].hash,
        );
    });
    it("opens revision actions from the row with keyboard focus and preserves disabled multi-selection", () => {
        message({ type: "historyState", state });
        const second = document.querySelectorAll<HTMLElement>('[role="option"]')[1];
        act(() =>
            second.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 50 }),
            ),
        );
        expect(selection().hashes).toEqual([state.entries[1].hash]);
        expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
        act(() =>
            document.activeElement?.dispatchEvent(
                new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
            ),
        );
        expect(document.activeElement?.textContent).toBe("open");
        button("open");
        expect(postMessage).toHaveBeenCalledWith({
            type: "historyAction",
            action: "open",
            hash: state.entries[1].hash,
        });
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(second);
        row(0, { metaKey: true });
        button("actions");
        expect(document.querySelectorAll('[role="menuitem"][aria-disabled="true"]')).toHaveLength(
            5,
        );
        const before = postMessage.mock.calls.length;
        button("copy");
        expect(postMessage).toHaveBeenCalledTimes(before);
        act(() =>
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
        );
        expect(document.querySelector('[role="menu"]')).toBeNull();
        button("actions");
        const overflow = document.querySelector<HTMLElement>('button[aria-label="actions"]')!;
        act(() => overflow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
        act(() => overflow.click());
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });
    it("uses graph ref presentation with overflow and only known parent edges", () => {
        message({
            type: "historyState",
            state: {
                ...state,
                entries: state.entries.map((entry, index) => ({
                    ...entry,
                    parents: index === 0 ? [state.entries[1].hash] : [],
                    refs:
                        index === 0
                            ? [
                                  { name: "v1.2.3", kind: "tag" },
                                  { name: "main", kind: "branch" },
                                  { name: "origin/main", kind: "remote" },
                                  { name: "v2", kind: "tag" },
                                  { name: "v3", kind: "tag" },
                              ]
                            : [],
                })),
            },
        });
        const cell = document.querySelector("[data-commit-tooltip]")!;
        expect(cell).not.toBeNull();
        expect(cell.textContent).toBe("Newest2v1.2.3v2+1");
        expect(cell.getAttribute("data-commit-tooltip")).toContain("origin/main");
        expect(cell.getAttribute("data-commit-tooltip")).toContain("v3");
        expect(cell.querySelector('[title="v1.2.3"] svg')).not.toBeNull();
        act(() => cell.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(selection().hashes).toEqual([state.entries[0].hash]);
        expect(document.querySelectorAll(".file-history-graph line")).toHaveLength(2);
        expect(
            document
                .querySelectorAll('[role="option"]')[2]
                .querySelector(".file-history-graph line"),
        ).toBeNull();
    });
});
