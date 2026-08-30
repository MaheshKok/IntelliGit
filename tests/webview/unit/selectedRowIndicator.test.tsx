// @vitest-environment jsdom

/**
 * Row selection is painted by `JETBRAINS_UI.color.selected`, which resolves to
 * `--vscode-list-activeSelectionBackground` -- a colour the HOST owns, not this
 * product. VS Code's own list widget pairs that fill with a focus outline drawn on
 * top, so its stock themes are free to pick a fill with almost no contrast, and
 * they do. Our rows reproduced the fill without the outline, so on those themes a
 * selected row had no visible boundary at all.
 *
 * Measured against `color.panel` across `tests/visual/fixtures/host`: Light Modern
 * `#e8e8e8` on `#f8f8f8` is 1.17:1, HC Light's 10%-alpha blue flattens to 1.18:1,
 * Dark Modern is 1.48:1. WCAG 1.4.11 asks 3:1 of a non-text state indicator, so
 * three of the four captured themes could not carry the state -- and HC Light, the
 * theme that exists FOR contrast, was the worst of them.
 *
 * Two halves, and both are load-bearing. The first measures the invariant against
 * every captured theme rather than against a hardcoded colour, so it keeps holding
 * for themes nobody has captured yet. The second checks the ring actually reaches
 * a row: a token that clears 3:1 and is painted by nothing is a token, not a fix.
 * A version that only satisfied the first half would be exactly the defect it
 * claims to fix.
 */

import React from "react";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import type { Commit, StashEntry } from "../../../src/types";
import type { ShelfEntry } from "../../../src/webviews/protocol/commitPanelMessages";
import {
    compositeOver,
    contrastRatio,
    readFixtureVariables,
    resolveColor,
    resolveRgba,
} from "../../helpers/cssColor";
import { BRANCH_ROW_CLASS_CSS } from "../../../src/webviews/react/branch-column/styles";
import { CommitRow } from "../../../src/webviews/react/commit-list/CommitRow";
import { ShelfRow } from "../../../src/webviews/react/commit-panel/components/ShelfRow";
import { StashList } from "../../../src/webviews/react/commit-panel/components/StashList";
import { TreeFileRow } from "../../../src/webviews/react/shared/components/FileTreeRows";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { JETBRAINS_UI } from "../../../src/webviews/react/shared/tokens";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";

initReactDomTestEnvironment();

const HOST_FIXTURE_DIR = join(process.cwd(), "tests/visual/fixtures/host");

/** WCAG 1.4.11: a non-text state indicator needs 3:1 against the adjacent colour. */
const INDICATOR_FLOOR = 3;

/**
 * The ring's geometry, kept separate from its colour so the two can fail apart.
 * A border or a thicker ring would change a row's box and shift its content --
 * `size.rowHeight` is 24 and `size.treeRowHeight` 22, both fixed -- and this
 * prefix is the only assertion that would notice.
 */
const RING_GEOMETRY = "inset 0 0 0 1px ";

const hostFixtures = readdirSync(HOST_FIXTURE_DIR).filter((name) => name.endsWith(".json"));

/** The declaration block of one rule in a plain CSS string. */
function ruleBody(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    if (!match) throw new Error(`no \`${selector}\` rule in the stylesheet`);
    return match[1];
}

/** One declaration's value, with `!important` and whitespace stripped. */
function declaration(body: string, property: string): string | null {
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`).exec(body);
    return match ? match[1].replace(/!important/, "").trim() : null;
}

/**
 * Every colour a selected branch row offers as its boundary against the panel.
 *
 * Read off the stylesheet the product actually injects rather than off the tokens,
 * so a ring that exists in `SHADOW` but was never wired into the rule measures as
 * absent -- which is the whole failure mode the second half of this file guards.
 */
function selectionSignals(): string[] {
    const body = ruleBody(BRANCH_ROW_CLASS_CSS, ".branch-row.selected");
    const fill = declaration(body, "background");
    const ring = declaration(body, "box-shadow");
    return [
        ...(fill ? [fill] : []),
        // The colour is whatever follows the geometry; a ring spelled any other way
        // is not the ring this file pinned above and should not be measured as one.
        ...(ring?.startsWith(RING_GEOMETRY) ? [ring.slice(RING_GEOMETRY.length)] : []),
    ];
}

describe("a selected row is distinguishable from an unselected one", () => {
    it("has host fixtures to measure against", () => {
        // Without this the per-theme loop below could iterate nothing and the whole
        // contrast half would pass by measuring no themes at all.
        expect(hostFixtures.length, `no *.json in ${HOST_FIXTURE_DIR}`).toBeGreaterThanOrEqual(4);
    });

    for (const fixtureName of hostFixtures) {
        const themeName = fixtureName.replace(/\.json$/, "");

        it(`${themeName}: the selection indicator clears ${INDICATOR_FLOOR}:1 against the panel`, () => {
            const variables = readFixtureVariables(join(HOST_FIXTURE_DIR, fixtureName));
            const panel = resolveColor(JETBRAINS_UI.color.panel, variables);

            const measured = selectionSignals().map((signal) => ({
                signal,
                // A theme may declare the fill translucent -- HC Light ships a
                // 10%-alpha blue -- so flatten it the way the browser paints it.
                // Measuring the raw value would report a ratio no user ever sees.
                ratio: contrastRatio(compositeOver(resolveRgba(signal, variables), panel), panel),
            }));
            const best = measured.reduce((a, b) => (a.ratio >= b.ratio ? a : b));

            expect(
                best.ratio,
                `the strongest selection signal a branch row paints measures ` +
                    `${best.ratio.toFixed(2)}:1 against the panel in ${themeName}, under the ` +
                    `${INDICATOR_FLOOR}:1 WCAG 1.4.11 asks of a non-text state indicator.\n` +
                    `Signals measured: ${measured
                        .map((m) => `${m.signal} -> ${m.ratio.toFixed(2)}:1`)
                        .join(", ")}\n` +
                    `The fill is --vscode-list-activeSelectionBackground, a colour the host ` +
                    `owns and can set arbitrarily low, so the boundary has to come from a ` +
                    `ring the product paints itself.`,
            ).toBeGreaterThanOrEqual(INDICATOR_FLOOR);
        });
    }

    it("draws the indicator as a 1px inner ring, so no row reflows", () => {
        const ring = declaration(
            ruleBody(BRANCH_ROW_CLASS_CSS, ".branch-row.selected"),
            "box-shadow",
        );
        expect(
            ring,
            "a selected branch row declares no box-shadow, so it has no boundary of its own",
        ).not.toBeNull();
        expect(
            ring?.startsWith(RING_GEOMETRY),
            `the selection ring must be \`${RING_GEOMETRY}<colour>\`; a border or a wider ` +
                `ring changes a fixed-height row's box and shifts its content`,
        ).toBe(true);
    });
});

const INDENT_METRICS = { indentStep: 18, indentBase: 20, guideBase: 28, sectionGuideLeft: 17 };

// Typed against the real contracts rather than cast, so a shape that drifts fails
// `typecheck:tests` instead of surfacing as an opaque render crash in here.
const COMMIT: Commit = {
    hash: "0123456789abcdef0123456789abcdef01234567",
    shortHash: "0123456",
    message: "Selected row",
    author: "Fixture",
    email: "fixture@example.com",
    date: "2026-01-01T00:00:00Z",
    parentHashes: [],
    refs: [],
};

const SHELF: ShelfEntry = {
    id: "shelf-1",
    generation: 1,
    metadata: { name: "Shelf one", lifecycle: "retain" },
    files: [],
};

const STASH: StashEntry = {
    index: 0,
    hash: "abc1234",
    message: "Stash one",
    date: "2026-01-01T00:00:00Z",
};

/**
 * Each selection site, rendered both ways. `selected`/`unselected` return the
 * element that paints the selection, so the pair pins that the ring tracks the
 * state rather than being painted unconditionally -- a row that ringed everything
 * would satisfy a one-sided check while telling the user nothing.
 */
const SELECTION_SITES = [
    {
        name: "TreeFileRow",
        render: (isSelected: boolean) => (
            <TreeFileRow
                file={{ path: "src/compat.ts", status: "M", additions: 1, deletions: 1 }}
                depth={1}
                rowVariant="commit-panel"
                indentMetrics={INDENT_METRICS}
                wiring={{ isSelected, onSelect: vi.fn(), isChecked: true, onToggleCheck: vi.fn() }}
            />
        ),
        find: (container: HTMLElement) =>
            container.querySelector<HTMLElement>('[title="src/compat.ts"]'),
    },
    {
        name: "CommitRow",
        render: (isSelected: boolean) => (
            <CommitRow
                commit={COMMIT}
                graphWidth={40}
                isSelected={isSelected}
                isUnpushed={false}
                onSelect={vi.fn()}
                onContextMenu={vi.fn()}
            />
        ),
        find: (container: HTMLElement) => container.querySelector<HTMLElement>('[role="button"]'),
    },
    {
        name: "ShelfRow",
        render: (isSelected: boolean) => (
            <ShelfRow
                shelf={SHELF}
                state={{
                    selected: isSelected,
                    isFocusTarget: false,
                    isGhost: false,
                    isExpanded: false,
                    isRenaming: false,
                }}
                onSelect={vi.fn()}
                onToggleExpand={vi.fn()}
                onNavigate={vi.fn()}
                onContextMenu={vi.fn()}
                onRenameSubmit={vi.fn()}
                onRenameCancel={vi.fn()}
                onRestore={vi.fn()}
            />
        ),
        find: (container: HTMLElement) => container.firstElementChild as HTMLElement | null,
    },
    {
        name: "StashList",
        render: (isSelected: boolean) => (
            <StashList
                stashes={[STASH]}
                selectedIndex={isSelected ? 0 : null}
                hasSelectedFile={false}
                expandedHashes={new Set<string>()}
                filesByHash={{}}
                onStashClick={vi.fn()}
                onToggleExpand={vi.fn()}
                onStashContextMenu={vi.fn()}
                renderSubtree={() => null}
            />
        ),
        find: (container: HTMLElement) => container.firstElementChild as HTMLElement | null,
    },
] as const;

describe("every row that paints a selection also paints its boundary", () => {
    for (const site of SELECTION_SITES) {
        it(`${site.name}: rings a selected row and leaves an unselected one bare`, () => {
            const read = (isSelected: boolean) => {
                const mounted = mount(
                    <ChakraProvider theme={theme}>{site.render(isSelected)}</ChakraProvider>,
                );
                try {
                    const element = site.find(mounted.container);
                    if (!element) throw new Error(`${site.name} rendered no row to measure`);
                    // Chakra emits emotion classes, so the declared value is on the
                    // computed style rather than on the inline `style` attribute.
                    return getComputedStyle(element).boxShadow;
                } finally {
                    unmount(mounted.root, mounted.container);
                }
            };

            expect(
                read(true),
                `${site.name} paints a selected row with a background but no ring, so on a ` +
                    `theme whose list.activeSelectionBackground is low-contrast the row has ` +
                    `no visible boundary`,
            ).toContain("inset");
            expect(
                read(false),
                `${site.name} rings an UNSELECTED row, so the ring is decoration rather than ` +
                    `a state indicator`,
            ).not.toContain("inset");
        });
    }
});
