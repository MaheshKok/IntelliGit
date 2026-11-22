// @vitest-environment jsdom
// The optional CI column in the Git Log (PLAN.md Phase 15, section 12): a fixed-width cell between
// the subject and Author/Date with a stacked bar of passed, failed and running checks and a
// `passed/total` count. It replaces the old check badge, a click selects the row and opens the
// Checks tab through `openChecksTab()`, and it never takes room from Author or Date.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit, CommitChecksSnapshot, CommitDetail } from "../../../src/types";
import { CommitList } from "../../../src/webviews/react/CommitList";
import { CommitInfoPane } from "../../../src/webviews/react/commit-info/CommitInfoPane";
import {
    OPEN_CHECKS_TAB_EVENT,
    openChecksTab,
} from "../../../src/webviews/react/commit-info/checks/checksTabState";
import { LANE_WIDTH } from "../../../src/webviews/react/graph";
import {
    AUTHOR_COL_WIDTH,
    CI_COL_WIDTH,
    DATE_COL_WIDTH,
    MESSAGE_MIN_WIDTH,
    METADATA_COLUMN_MARGIN,
    ROW_SIDE_PADDING,
} from "../../../src/webviews/react/commit-list/styles";
import { flush, initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";
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
const originalRect = HTMLElement.prototype.getBoundingClientRect;
// One graph lane plus the row chrome CommitList subtracts before laying out the metadata.
const ROW_CHROME = LANE_WIDTH + 12 + ROW_SIDE_PADDING + 2;
/** The narrowest viewport where the CI column fits beside both Author and Date. */
const CI_FITS_WIDTH =
    ROW_CHROME +
    MESSAGE_MIN_WIDTH +
    CI_COL_WIDTH +
    METADATA_COLUMN_MARGIN +
    AUTHOR_COL_WIDTH +
    METADATA_COLUMN_MARGIN +
    DATE_COL_WIDTH +
    METADATA_COLUMN_MARGIN;

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

const mixed: CommitChecksSnapshot = {
    hash: HASH,
    state: "failure",
    summary: "1 failing, 1 pending, 2 successful checks",
    items: [
        { name: "unit", description: "Passed", state: "success", source: "check-run" },
        { name: "lint", description: "Passed", state: "success", source: "check-run" },
        { name: "e2e", description: "Failed", state: "failure", source: "check-run" },
        { name: "deploy", description: "Running", state: "pending", source: "check-run" },
    ],
};

function setViewportWidth(width: number): void {
    HTMLElement.prototype.getBoundingClientRect = () =>
        ({ width, height: 400, top: 0, left: 0, right: width, bottom: 400 }) as DOMRect;
}

async function renderList(options: {
    showCiColumn?: boolean;
    checks?: CommitChecksSnapshot;
    onOpenCommitInChecks?: (hash: string) => void;
    onSelectCommit?: (hash: string) => void;
    withPane?: boolean;
}): Promise<HTMLElement> {
    const list = (
        <CommitList
            commits={[commit]}
            selectedHash={null}
            filterText=""
            hasMore={false}
            unpushedHashes={new Set()}
            selectedBranch={null}
            onSelectCommit={options.onSelectCommit ?? vi.fn()}
            onFilterText={vi.fn()}
            onLoadMore={vi.fn()}
            onCommitAction={vi.fn()}
            commitChecks={new Map([[HASH, options.checks ?? mixed]])}
            onRequestCommitChecks={vi.fn()}
            onOpenCommitCheckUrl={vi.fn()}
            onOpenCommitInChecks={options.onOpenCommitInChecks ?? vi.fn()}
            {...(options.showCiColumn === undefined ? {} : { showCiColumn: options.showCiColumn })}
        />
    );
    const { container } = mount(
        options.withPane ? (
            <>
                {list}
                <CommitInfoPane detail={detail} ciRepoKey="/repo" commitChecksEnabled />
            </>
        ) : (
            list
        ),
    );
    await flush();
    return container;
}

function headerTexts(container: HTMLElement): string[] {
    const header = container.querySelector('[data-testid="commit-list-header"]');
    if (!header) throw new Error("commit list header not rendered");
    return Array.from(header.children).map((child) => child.textContent?.trim() ?? "");
}

const ciCell = (container: HTMLElement): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-testid="commit-ci-cell-${HASH}"]`);
const badge = (container: HTMLElement): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-testid="commit-checks-button-${HASH}"]`);

beforeEach(() => {
    installWebviewI18n();
    mockVscodeApi.postMessage.mockReset();
    mockVscodeApi.getState.mockReset();
    mockVscodeApi.setState.mockReset();
    setViewportWidth(1000);
});

afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    delete window.intelligitE2E;
});

describe("Git Log CI column", () => {
    it("off by default, layout unchanged", async () => {
        const container = await renderList({});

        expect(ciCell(container), "no CI cell without the column flag").toBeNull();
        expect(
            container.querySelector('[data-testid="commit-ci-header"]'),
            "no CI header without the column flag",
        ).toBeNull();
        expect(badge(container), "the old check badge renders as today").not.toBeNull();
        expect(headerTexts(container)).toEqual(["Commit", "Author", "Date", ""]);
    });

    it("bar proportions and passed/total", async () => {
        const container = await renderList({ showCiColumn: true });

        const cell = ciCell(container);
        expect(cell, "the CI cell renders when the column is on").not.toBeNull();
        expect(cell!.textContent, "passed/total counts only successful checks").toBe("2/4");
        expect(cell!.style.width, "the Figma frame 1:2 width").toBe(`${CI_COL_WIDTH}px`);
        expect(cell!.title, "hover shows the snapshot's summary").toBe(mixed.summary);
        const segment = (state: string): string | undefined =>
            cell!.querySelector<HTMLElement>(`[data-testid="commit-ci-bar-${state}"]`)?.style.width;
        expect(segment("success")).toBe("50%");
        expect(segment("failure")).toBe("25%");
        expect(segment("pending")).toBe("25%");
        expect(headerTexts(container), "the CI header sits between Commit and Author").toEqual([
            "Commit",
            "CI",
            "Author",
            "Date",
        ]);
    });

    it("a commit without checks shows a dash in place of the count", async () => {
        const container = await renderList({
            showCiColumn: true,
            checks: { hash: HASH, state: "none", summary: "No checks", items: [] },
        });

        expect(ciCell(container)!.textContent).toBe("—");
        expect(ciCell(container)!.querySelector('[data-testid^="commit-ci-bar-"]')).toBeNull();
    });

    it("old badge hidden when column on", async () => {
        const container = await renderList({ showCiColumn: true });

        expect(ciCell(container)).not.toBeNull();
        expect(badge(container), "the row shows one checks control, not two").toBeNull();
        expect(
            container.querySelector(`[data-testid="commit-checks-slot-${HASH}"]`),
            "no empty badge slot either",
        ).toBeNull();
    });

    it("the CI column drops before Author and Date when the pane is too narrow for all three", async () => {
        setViewportWidth(CI_FITS_WIDTH);
        const wide = await renderList({ showCiColumn: true });
        expect(ciCell(wide), "fits beside Author and Date").not.toBeNull();
        expect(headerTexts(wide)).toEqual(["Commit", "CI", "Author", "Date"]);

        document.body.replaceChildren();
        setViewportWidth(CI_FITS_WIDTH - 1);
        const narrow = await renderList({ showCiColumn: true });
        expect(ciCell(narrow), "one pixel short: the CI column gives way").toBeNull();
        expect(
            headerTexts(narrow),
            "Author and Date keep their place, and the old badge column returns",
        ).toEqual(["Commit", "Author", "Date", ""]);
        expect(badge(narrow), "the old badge is back while the column is dropped").not.toBeNull();
    });

    it("click opens Checks tab", async () => {
        window.intelligitE2E = true;
        const onSelectCommit = vi.fn();
        const opened = vi.fn();
        window.addEventListener(OPEN_CHECKS_TAB_EVENT, opened);
        try {
            const container = await renderList({
                showCiColumn: true,
                onSelectCommit,
                onOpenCommitInChecks: () => openChecksTab(),
                withPane: true,
            });
            const selectedTab = (): string | null | undefined =>
                container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
            expect(selectedTab(), "Files is the default tab").toBe("Files");

            act(() => ciCell(container)!.click());

            expect(onSelectCommit, "the row is selected").toHaveBeenCalledWith(HASH);
            expect(opened, "the Checks tab was asked to open").toHaveBeenCalledTimes(1);
            expect(selectedTab(), "the details pane switched to Checks").toBe("Checks");
        } finally {
            window.removeEventListener(OPEN_CHECKS_TAB_EVENT, opened);
        }
    });

    it("the CI cell's click does not open the Checks tab while the switch is off", async () => {
        // window.intelligitE2E stays unset: the Checks tab switch is off.
        const opened = vi.fn();
        window.addEventListener(OPEN_CHECKS_TAB_EVENT, opened);
        try {
            const container = await renderList({
                showCiColumn: true,
                onOpenCommitInChecks: () => openChecksTab(),
                withPane: true,
            });
            const selectedTab = (): string | null | undefined =>
                container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
            const before = selectedTab();

            act(() => ciCell(container)!.click());

            expect(opened, "no open-Checks event fires").not.toHaveBeenCalled();
            expect(selectedTab(), "the details pane stays on its tab").toBe(before);
        } finally {
            window.removeEventListener(OPEN_CHECKS_TAB_EVENT, opened);
        }
    });
});

// Each graph app reads the column flag from the host's setBranches message; an absent flag is off.
describe.each([
    {
        name: "NativeCommitGraph",
        load: async () =>
            (await import("../../../src/webviews/react/NativeCommitGraph")).NativeCommitGraph,
    },
    {
        name: "CommitGraphPanel",
        load: async () =>
            (await import("../../../src/webviews/react/CommitGraphPanel")).CommitGraphPanel,
    },
    { name: "UndockedApp", load: undefined },
])("CI column flag from setBranches: $name", ({ load }) => {
    let lastProps: { showCiColumn?: unknown } | null = null;

    async function mountApp(): Promise<void> {
        vi.resetModules();
        document.body.replaceChildren();
        const root = document.createElement("div");
        root.id = "root";
        document.body.appendChild(root);
        vi.doMock("../../../src/webviews/react/CommitList", () => ({
            CommitList: (props: { showCiColumn?: unknown }) => {
                lastProps = props;
                return <div>Graph</div>;
            },
        }));
        vi.doMock("../../../src/webviews/react/BranchColumn", () => ({
            BranchColumn: () => <div>Branches</div>,
        }));
        vi.doMock("../../../src/webviews/react/commit-info/CommitInfoPane", () => ({
            CommitInfoPane: () => <div>Info</div>,
        }));
        Object.defineProperty(globalThis, "acquireVsCodeApi", {
            configurable: true,
            value: vi.fn(() => mockVscodeApi),
        });
        if (load) {
            const { createRoot } = await import("react-dom/client");
            const Component = await load();
            act(() => {
                createRoot(root).render(
                    <Component vscode={mockVscodeApi as never} sendReady={false} />,
                );
            });
        } else {
            // UndockedApp renders itself into #root on import.
            await import("../../../src/webviews/react/UndockedApp");
        }
        await flush();
    }

    function sendBranches(extra: Record<string, unknown>): void {
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setBranches",
                        branches: [
                            {
                                name: "main",
                                hash: "a1",
                                isRemote: false,
                                isCurrent: true,
                                ahead: 0,
                                behind: 0,
                            },
                        ],
                        ...extra,
                    },
                }),
            );
        });
    }

    afterEach(() => {
        vi.doUnmock("../../../src/webviews/react/CommitList");
        vi.doUnmock("../../../src/webviews/react/BranchColumn");
        vi.doUnmock("../../../src/webviews/react/commit-info/CommitInfoPane");
        lastProps = null;
    });

    it("an absent flag keeps the column off", async () => {
        await mountApp();
        sendBranches({});
        await flush();
        expect(lastProps, "CommitList rendered").not.toBeNull();
        expect(lastProps!.showCiColumn).toBe(false);
    });

    it("the host's true flag turns the column on", async () => {
        await mountApp();
        sendBranches({ showCiColumn: true });
        await flush();
        expect(lastProps!.showCiColumn).toBe(true);
    });
});
