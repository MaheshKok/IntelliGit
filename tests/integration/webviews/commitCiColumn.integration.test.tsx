// @vitest-environment jsdom
// The optional CI column in the Git Log (PLAN.md Phase 15, section 12): a fixed-width cell between
// the subject and Author/Date with a stacked bar of passed, failed and running checks and a
// `passed/total` count. It replaces the old check badge, a click selects the row and opens the
// Checks tab through `openChecksTab()`, and it never takes room from Author or Date.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit, CommitChecksSnapshot, CommitDetail } from "../../../src/types";
import { CommitList } from "../../../src/webviews/react/CommitList";
import { CiColumnHeader } from "../../../src/webviews/react/commit-list/CiColumnCell";
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
    commitChecks?: ReadonlyMap<string, CommitChecksSnapshot | "loading">;
    onOpenCommitInChecks?: (hash: string) => void;
    omitOpenInChecks?: boolean;
    onSelectCommit?: (hash: string) => void;
    withPane?: boolean;
    omitChecksRequester?: boolean;
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
            commitChecks={options.commitChecks ?? new Map([[HASH, options.checks ?? mixed]])}
            {...(options.omitChecksRequester ? {} : { onRequestCommitChecks: vi.fn() })}
            onOpenCommitCheckUrl={vi.fn()}
            {...(options.omitOpenInChecks
                ? {}
                : { onOpenCommitInChecks: options.onOpenCommitInChecks ?? vi.fn() })}
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
        expect(cell!.style.width, "the Figma frame 1:2 width").toBe("99px");
        expect(cell!.title, "hover shows the snapshot's summary").toBe(mixed.summary);
        expect(cell!.getAttribute("aria-label"), "screen readers read the summary").toBe(
            "CI checks: 1 failing, 1 pending, 2 successful checks",
        );
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

    // The Figma frame 1:2 numbers are written out here on purpose: importing the production
    // constants would let a changed constant move the test with it.
    it("keeps the Figma frame 1:2 dimensions: 99 px cell, 8 px inset, 44 x 8 px bar, 6 px gap", async () => {
        const container = await renderList({ showCiColumn: true });

        const cell = ciCell(container)!;
        expect(cell.style.width, "cell width").toBe("99px");
        expect(cell.style.paddingLeft, "cell inset before the bar").toBe("8px");
        expect(cell.style.gap, "gap between bar and count").toBe("6px");
        const bar = cell.querySelector<HTMLElement>('[aria-hidden="true"]')!;
        expect(bar.style.width, "bar width").toBe("44px");
        expect(bar.style.height, "bar height").toBe("8px");
        const header = container.querySelector<HTMLElement>('[data-testid="commit-ci-header"]')!;
        expect(header.style.width, "header width matches the cell").toBe("99px");
        expect(header.style.paddingLeft, "header inset matches the cell").toBe("8px");
        // METADATA_COLUMN_MARGIN is 4 px: cell and header sit 4 px from the column before them,
        // and the header keeps 4 px before Author, so the header stays over its cells.
        expect(cell.style.marginLeft, "cell margin before the column").toBe("4px");
        expect(header.style.marginLeft, "header margin before the column").toBe("4px");
        expect(header.style.marginRight, "header margin before Author").toBe("4px");
    });

    it("the header drops its right margin when no Author header follows it", () => {
        // CommitList only shows the CI column beside Author, so `beforeAuthor: false` is reached
        // through the component alone.
        const { container } = mount(<CiColumnHeader shown beforeAuthor={false} />);

        const header = container.querySelector<HTMLElement>('[data-testid="commit-ci-header"]')!;
        expect(header.style.marginRight, "no margin without an Author header").toBe("0px");
        expect(header.style.marginLeft, "left margin stays").toBe("4px");
    });

    it("a commit still loading and a commit with no entry show a dash, no bar, and the default title", async () => {
        for (const commitChecks of [
            new Map<string, "loading">([[HASH, "loading"]]),
            new Map<string, "loading">(),
        ]) {
            document.body.replaceChildren();
            const container = await renderList({ showCiColumn: true, commitChecks });

            const cell = ciCell(container)!;
            expect(cell, "the cell renders").not.toBeNull();
            expect(cell.textContent, "a dash in place of the count").toBe("—");
            expect(
                cell.querySelector('[data-testid^="commit-ci-bar-"]'),
                "no bar segments",
            ).toBeNull();
            expect(cell.title, "title falls back to the checks heading").toBe("Commit Checks");
            expect(cell.getAttribute("aria-label"), "aria-label names the control").toBe(
                "CI checks: Commit Checks",
            );
        }
    });

    // Ten checks, written out so each segment width and the count are literal. Today's rule, which
    // PLAN.md section 12 does not state and the owner has not ruled on: every item counts in the
    // denominator, and skipped, cancelled and neutral checks belong to no segment.
    it("counts timed-out and action-required checks as failed and leaves skipped, cancelled and neutral in the total only", async () => {
        const item = (state: CommitChecksSnapshot["items"][number]["state"], name: string) => ({
            name,
            description: state,
            state,
            source: "check-run" as const,
        });
        const container = await renderList({
            showCiColumn: true,
            checks: {
                hash: HASH,
                state: "failure",
                summary: "mixed outcomes",
                items: [
                    item("success", "a"),
                    item("success", "b"),
                    item("timed_out", "c"),
                    item("action_required", "d"),
                    item("cancelled", "e"),
                    item("cancelled", "f"),
                    item("skipped", "g"),
                    item("skipped", "h"),
                    item("neutral", "i"),
                    item("neutral", "j"),
                ],
            },
        });

        const cell = ciCell(container)!;
        expect(cell.textContent, "passed over all ten items").toBe("2/10");
        const segment = (state: string): string | undefined =>
            cell.querySelector<HTMLElement>(`[data-testid="commit-ci-bar-${state}"]`)?.style.width;
        expect(segment("success"), "two of ten passed").toBe("20%");
        expect(segment("failure"), "timed_out and action_required both count as failed").toBe(
            "20%",
        );
        expect(segment("pending"), "no pending segment without pending checks").toBeUndefined();
    });

    it("a commit without checks shows a dash in place of the count", async () => {
        const container = await renderList({
            showCiColumn: true,
            checks: { hash: HASH, state: "none", summary: "No checks", items: [] },
        });

        expect(ciCell(container)!.textContent).toBe("—");
        expect(ciCell(container)!.querySelector('[data-testid^="commit-ci-bar-"]')).toBeNull();
    });

    it("segment colours: passed and failed checks are painted differently", async () => {
        const container = await renderList({ showCiColumn: true });

        const paint = (state: string): string | undefined =>
            ciCell(container)!.querySelector<HTMLElement>(`[data-testid="commit-ci-bar-${state}"]`)
                ?.style.background;
        expect(paint("success"), "success contract colour").toBe(
            "var(--vscode-charts-green, #62c370)",
        );
        expect(paint("failure"), "failure contract colour").toBe(
            "var(--vscode-errorForeground, #f14c4c)",
        );
        expect(paint("pending"), "pending contract colour").toBe(
            "var(--vscode-charts-yellow, #e5c07b)",
        );
    });

    it("without a checks requester the column flag does nothing", async () => {
        const without = await renderList({ showCiColumn: true, omitChecksRequester: true });

        expect(ciCell(without), "no CI cell without a requester").toBeNull();
        expect(
            without.querySelector('[data-testid="commit-ci-header"]'),
            "no CI header without a requester",
        ).toBeNull();
        const headers = headerTexts(without);

        document.body.replaceChildren();
        const flagAbsent = await renderList({ omitChecksRequester: true });
        expect(headers, "the same header as with the flag absent").toEqual(headerTexts(flagAbsent));
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

    it("one mounted list follows a wide, narrow, wide resize without a remount", async () => {
        // The shared setup's ResizeObserver never fires; capture the list's own callback to drive it.
        const original = globalThis.ResizeObserver;
        const callbacks: ResizeObserverCallback[] = [];
        class CapturingResizeObserver {
            constructor(callback: ResizeObserverCallback) {
                callbacks.push(callback);
            }
            observe = vi.fn();
            unobserve = vi.fn();
            disconnect = vi.fn();
        }
        Object.defineProperty(globalThis, "ResizeObserver", {
            value: CapturingResizeObserver,
            configurable: true,
        });
        try {
            setViewportWidth(CI_FITS_WIDTH);
            const container = await renderList({ showCiColumn: true });
            const resizeTo = async (width: number): Promise<void> => {
                setViewportWidth(width);
                act(() => callbacks.forEach((callback) => callback([], {} as ResizeObserver)));
                await flush();
            };
            expect(callbacks.length, "the list registered its resize observer").toBeGreaterThan(0);
            expect(ciCell(container), "wide: the column shows").not.toBeNull();
            expect(headerTexts(container)).toEqual(["Commit", "CI", "Author", "Date"]);

            await resizeTo(CI_FITS_WIDTH - 1);
            expect(ciCell(container), "narrow: the same row drops its CI cell").toBeNull();
            expect(headerTexts(container)).toEqual(["Commit", "Author", "Date", ""]);
            expect(badge(container), "narrow: the old badge returns").not.toBeNull();

            await resizeTo(CI_FITS_WIDTH);
            expect(ciCell(container), "wide again: the cell comes back").not.toBeNull();
            expect(headerTexts(container)).toEqual(["Commit", "CI", "Author", "Date"]);
            expect(badge(container), "wide again: no second checks control").toBeNull();
        } finally {
            Object.defineProperty(globalThis, "ResizeObserver", {
                value: original,
                configurable: true,
            });
        }
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
            expect(
                onSelectCommit,
                "selected once, not again by the bubbled click",
            ).toHaveBeenCalledTimes(1);
            expect(opened, "the Checks tab was asked to open").toHaveBeenCalledTimes(1);
            expect(selectedTab(), "the details pane switched to Checks").toBe("Checks");
        } finally {
            window.removeEventListener(OPEN_CHECKS_TAB_EVENT, opened);
        }
    });

    it("the CI cell's click does not open the Checks tab while the switch is off", async () => {
        // window.intelligitE2E stays unset: the Checks tab switch is off.
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
            const before = selectedTab();

            act(() => ciCell(container)!.click());

            expect(opened, "no open-Checks event fires").not.toHaveBeenCalled();
            expect(selectedTab(), "the details pane stays on its tab").toBe(before);
            expect(onSelectCommit, "the click still selects the row, once").toHaveBeenCalledTimes(
                1,
            );
            expect(onSelectCommit).toHaveBeenCalledWith(HASH);
        } finally {
            window.removeEventListener(OPEN_CHECKS_TAB_EVENT, opened);
        }
    });

    it("in a host with no Checks tab the CI cell's click only selects the row", async () => {
        const onSelectCommit = vi.fn();
        const opened = vi.fn();
        window.addEventListener(OPEN_CHECKS_TAB_EVENT, opened);
        try {
            const container = await renderList({
                showCiColumn: true,
                onSelectCommit,
                omitOpenInChecks: true,
            });

            act(() => ciCell(container)!.click());

            expect(onSelectCommit, "the row is selected once").toHaveBeenCalledTimes(1);
            expect(onSelectCommit).toHaveBeenCalledWith(HASH);
            expect(opened, "no open-Checks event fires").not.toHaveBeenCalled();
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

    // The hosts omit the field when the column is off, so "off" arrives as an absent flag.
    it("an absent flag after a true flag turns the column off again", async () => {
        await mountApp();
        sendBranches({ showCiColumn: true });
        await flush();
        expect(lastProps!.showCiColumn, "the control: the true flag is on").toBe(true);
        sendBranches({});
        await flush();
        expect(lastProps!.showCiColumn).toBe(false);
    });
});
