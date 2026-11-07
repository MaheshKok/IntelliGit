// @vitest-environment jsdom
// Issue #340: the Git Log's Changed Files pane can list a commit's files flat instead of as a
// directory tree, and remembers that choice in the webview's saved state.

import React, { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitDetail } from "../../../src/types";
import { CommitInfoPane } from "../../../src/webviews/react/commit-info/CommitInfoPane";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

const mockVscodeApi = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn((): unknown => undefined),
    setState: vi.fn(),
}));

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => mockVscodeApi,
}));

initReactDomTestEnvironment();

beforeEach(() => {
    installWebviewI18n();
    mockVscodeApi.getState.mockReset();
    mockVscodeApi.getState.mockReturnValue(undefined);
    mockVscodeApi.setState.mockReset();
});

const detail: CommitDetail = {
    hash: "abc1234",
    shortHash: "abc1234",
    message: "Touch nested files",
    body: "",
    author: "Mahesh Kokare",
    email: "mahesh@example.com",
    date: "2026-07-08T12:00:00.000Z",
    parentHashes: [],
    refs: [],
    files: [
        { path: "src/a.ts", status: "M", additions: 1, deletions: 0 },
        { path: "src/nested/leaf.ts", status: "A", additions: 2, deletions: 0 },
        { path: "README.md", status: "M", additions: 0, deletions: 1 },
    ],
};

function folderRows(container: HTMLElement): Element[] {
    return Array.from(container.querySelectorAll('[role="treeitem"][aria-expanded]'));
}

function fileRow(container: HTMLElement, path: string): HTMLElement {
    const row = container.querySelector<HTMLElement>(`[role="treeitem"][title="${path}"]`);
    expect(row, `file row for ${path}`).not.toBeNull();
    return row!;
}

function groupingToggle(container: HTMLElement): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>("button[aria-pressed]");
    expect(button, "the Changed Files grouping toggle").not.toBeNull();
    return button!;
}

describe("Commit info changed-files grouping", () => {
    it("shows a directory tree by default with a pressed grouping toggle", () => {
        const { root, container } = mount(<CommitInfoPane detail={detail} />);

        expect(folderRows(container).length).toBeGreaterThan(0);
        expect(groupingToggle(container).getAttribute("aria-pressed")).toBe("true");
        expect(fileRow(container, "src/nested/leaf.ts").textContent).not.toContain("src/nested");

        unmount(root, container);
    });

    it("switches to a flat list showing each file's folder and saves the choice", () => {
        mockVscodeApi.getState.mockReturnValue({ branchColumn: { scrollTop: 7 } });
        const { root, container } = mount(<CommitInfoPane detail={detail} />);

        act(() => groupingToggle(container).click());

        expect(folderRows(container)).toHaveLength(0);
        expect(fileRow(container, "src/nested/leaf.ts").textContent).toContain("src/nested");
        expect(fileRow(container, "README.md")).toBeTruthy();
        expect(groupingToggle(container).getAttribute("aria-pressed")).toBe("false");
        expect(mockVscodeApi.setState).toHaveBeenLastCalledWith({
            branchColumn: { scrollTop: 7 },
            commitInfoGroupByDir: false,
        });
        // The toggle sits beside the section's collapse control, so it must not collapse it.
        expect(fileRow(container, "src/a.ts")).toBeTruthy();

        act(() => groupingToggle(container).click());
        expect(folderRows(container).length).toBeGreaterThan(0);

        unmount(root, container);
    });

    it("opens flat when the saved state says files were ungrouped", () => {
        mockVscodeApi.getState.mockReturnValue({ commitInfoGroupByDir: false });
        const { root, container } = mount(<CommitInfoPane detail={detail} />);

        expect(folderRows(container)).toHaveLength(0);
        expect(fileRow(container, "src/nested/leaf.ts").textContent).toContain("src/nested");

        unmount(root, container);
    });
});
