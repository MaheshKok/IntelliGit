// @vitest-environment jsdom
// The popover's "Open in Checks" closes the popover, selects the commit row and switches the
// commit details pane to its Checks tab (PLAN.md Phase 4, build step 8). The row and the pane are
// wired the way the graph apps wire them: the row's callback calls `openChecksTab`.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit, CommitChecksSnapshot, CommitDetail } from "../../../src/types";
import { CommitInfoPane } from "../../../src/webviews/react/commit-info/CommitInfoPane";
import { openChecksTab } from "../../../src/webviews/react/commit-info/checks/checksTabState";
import { CommitRow } from "../../../src/webviews/react/commit-list/CommitRow";
import { initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";
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

const HASH = "c".repeat(40);

beforeEach(() => {
    installWebviewI18n();
    mockVscodeApi.postMessage.mockReset();
    mockVscodeApi.getState.mockReset();
    mockVscodeApi.setState.mockReset();
    // The Checks tab switch is on only in an E2E control channel webview.
    window.intelligitE2E = true;
});

afterEach(() => {
    delete window.intelligitE2E;
});

const commit: Commit = {
    hash: HASH,
    shortHash: HASH.slice(0, 7),
    message: "Fix the build",
    author: "Mahesh Kokare",
    email: "mahesh@example.com",
    date: "2026-11-07T12:00:00.000Z",
    parentHashes: [],
    refs: [],
};

const detail: CommitDetail = { ...commit, body: "", files: [] };

const checks: CommitChecksSnapshot = {
    hash: HASH,
    state: "failure",
    summary: "1 failing check",
    items: [{ name: "unit-tests", description: "Failed", state: "failure", source: "check-run" }],
};

function openInChecksButton(): HTMLButtonElement | undefined {
    return Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => candidate.textContent?.trim() === "Open in Checks",
    );
}

describe("Commit checks popover", () => {
    it("Open in Checks selects row and switches tab", () => {
        const onSelect = vi.fn();
        const { container } = mount(
            <>
                <CommitRow
                    commit={commit}
                    graphWidth={0}
                    isPrimary={false}
                    isSelected={false}
                    isUnpushed={false}
                    onSelect={onSelect}
                    onContextMenu={() => undefined}
                    checks={checks}
                    onRequestChecks={() => undefined}
                    onOpenCheckUrl={() => undefined}
                    onOpenInChecks={() => openChecksTab()}
                />
                <CommitInfoPane detail={detail} ciRepoKey="/repo" commitChecksEnabled />
            </>,
        );
        const selectedTab = (): string | null | undefined =>
            container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
        expect(selectedTab(), "Files is the default tab").toBe("Files");

        act(() => {
            container
                .querySelector<HTMLButtonElement>(`[data-testid="commit-checks-button-${HASH}"]`)!
                .click();
        });
        const open = openInChecksButton();
        expect(open, "the popover offers Open in Checks").toBeDefined();
        act(() => open!.click());

        expect(onSelect, "the row is selected").toHaveBeenCalledWith(HASH);
        expect(openInChecksButton(), "the popover closed").toBeUndefined();
        expect(selectedTab(), "the details pane switched to Checks").toBe("Checks");
        expect(container.querySelector('[data-testid="checks-tab"]')).not.toBeNull();
    });
});
