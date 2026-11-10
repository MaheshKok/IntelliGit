// @vitest-environment jsdom
// The unfinished Checks tab stays hidden behind one switch until its last phase turns it on:
// only a webview of the E2E control channel (`window.intelligitE2E`, which the host injects only
// while that channel is active) shows the tab or any way into it.

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

const HASH = "d".repeat(40);

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

beforeEach(() => {
    installWebviewI18n();
    mockVscodeApi.postMessage.mockReset();
    mockVscodeApi.getState.mockReset();
    mockVscodeApi.setState.mockReset();
});

afterEach(() => {
    delete window.intelligitE2E;
});

function openInChecksButton(): HTMLButtonElement | undefined {
    return Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => candidate.textContent?.trim() === "Open in Checks",
    );
}

/** A graph row with its CI popover open, beside a commit details pane that has a repository. */
function mountRowAndPane(): HTMLElement {
    const { container } = mount(
        <>
            <CommitRow
                commit={commit}
                graphWidth={0}
                isPrimary={false}
                isSelected={false}
                isUnpushed={false}
                onSelect={() => undefined}
                onContextMenu={() => undefined}
                checks={checks}
                onRequestChecks={() => undefined}
                onOpenCheckUrl={() => undefined}
                onOpenInChecks={() => openChecksTab()}
            />
            <CommitInfoPane detail={detail} ciRepoKey="/repo" commitChecksEnabled />
        </>,
    );
    act(() => {
        container
            .querySelector<HTMLButtonElement>(`[data-testid="commit-checks-button-${HASH}"]`)!
            .click();
    });
    return container;
}

describe("Checks tab switch", () => {
    it("while off, hides the Checks tab and every way into it, even a saved Checks choice", () => {
        mockVscodeApi.getState.mockReturnValue({ commitInfoTab: "checks" });
        const container = mountRowAndPane();

        expect(container.querySelector('[role="tab"]'), "no Files | Checks tab bar").toBeNull();
        expect(container.querySelector('[data-testid="checks-tab"]'), "no Checks tab").toBeNull();
        expect(openInChecksButton(), "the popover offers no Open in Checks").toBeUndefined();

        act(() => openChecksTab());
        expect(mockVscodeApi.setState, "openChecksTab saves nothing").not.toHaveBeenCalled();
        expect(
            container.querySelector('[data-testid="checks-tab"]'),
            "openChecksTab opens nothing",
        ).toBeNull();
    });

    it("while on, shows the Checks tab and Open in Checks switches to it", () => {
        window.intelligitE2E = true;
        const container = mountRowAndPane();
        const selectedTab = (): string | null | undefined =>
            container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
        expect(selectedTab(), "the tab bar shows with Files selected").toBe("Files");

        const open = openInChecksButton();
        expect(open, "the popover offers Open in Checks").toBeDefined();
        act(() => open!.click());

        expect(selectedTab(), "the details pane switched to Checks").toBe("Checks");
        expect(container.querySelector('[data-testid="checks-tab"]')).not.toBeNull();
    });
});
