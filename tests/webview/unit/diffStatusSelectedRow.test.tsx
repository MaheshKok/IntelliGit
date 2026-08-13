// @vitest-environment jsdom

/**
 * The diff-status colours are chosen to sit on the panel background. On a SELECTED
 * row they were still being forced on top of `list.activeSelectionBackground`,
 * where they measured as low as 1.04:1 in HC Light.
 *
 * The fix is that a row painting its own foreground wins: the `+N`/`-N` counts and
 * the status badge stop declaring a colour and inherit it, exactly as the file name
 * beside them already did. These tests pin BOTH halves -- that the colour is
 * dropped when the row overrides, and that it is still there when the row does not
 * -- because a version that simply never coloured anything would satisfy the first
 * half alone and silently delete the feature.
 */

import React from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { TreeFileRow } from "../../../src/webviews/react/shared/components/FileTreeRows";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";

initReactDomTestEnvironment();

const INDENT_METRICS = {
    indentStep: 18,
    indentBase: 20,
    guideBase: 28,
    sectionGuideLeft: 17,
};

function renderRow(isSelected: boolean) {
    return mount(
        <ChakraProvider theme={theme}>
            <TreeFileRow
                file={{ path: "src/compat.ts", status: "D", additions: 2, deletions: 1 }}
                depth={1}
                rowVariant="commit-panel"
                indentMetrics={INDENT_METRICS}
                wiring={{ isSelected, onSelect: vi.fn(), isChecked: true, onToggleCheck: vi.fn() }}
            />
        </ChakraProvider>,
    );
}

/** Finds the element whose own text is exactly `text` (not an ancestor's). */
function spanWithText(container: HTMLElement, text: string): HTMLElement {
    const match = Array.from(container.querySelectorAll("span")).find(
        (element) => element.textContent === text && element.children.length === 0,
    );
    if (!match) {
        throw new Error(`no leaf <span> with text ${JSON.stringify(text)} in the rendered row`);
    }
    return match as HTMLElement;
}

/** Chakra emits emotion classes, so the declared colour is on the computed style. */
function colorOf(element: HTMLElement): string {
    return getComputedStyle(element).color;
}

describe("diff-status colours on a selected row", () => {
    it("colours the +N/-N counts distinctly on an unselected row", () => {
        const mounted = renderRow(false);
        try {
            const row = mounted.container.querySelector('[title="src/compat.ts"]') as HTMLElement;
            const added = colorOf(spanWithText(mounted.container, "+2"));
            const deleted = colorOf(spanWithText(mounted.container, "-1"));

            expect(added).toBe("var(--intelligit-pycharm-added)");
            expect(deleted).toBe("var(--intelligit-pycharm-deleted)");
            // The whole point is that they differ from the row's ordinary text colour;
            // a build that dropped the colours everywhere would still satisfy the
            // equalities above if the row happened to use those same tokens.
            expect(added, "the +N count must not just be the row's text colour").not.toBe(
                colorOf(row),
            );
            expect(deleted, "the -N count must not just be the row's text colour").not.toBe(
                colorOf(row),
            );
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });

    it("drops those colours on a selected row so they inherit the row's foreground", () => {
        const mounted = renderRow(true);
        try {
            const row = mounted.container.querySelector('[title="src/compat.ts"]') as HTMLElement;

            // Inheritance only means anything if the row is actually painting a
            // selection background -- that surface is the entire reason the diff
            // colours are wrong here. Without this the assertions below would also
            // pass on a row that had no selection styling at all.
            expect(
                getComputedStyle(row).background,
                "the selected row must paint a selection background",
            ).toContain("--vscode-list-activeSelectionBackground");

            const rowColor = colorOf(row);
            expect(rowColor, "the row must paint a foreground for its children to inherit").not.toBe(
                "",
            );
            for (const text of ["+2", "-1", "D"]) {
                expect(
                    colorOf(spanWithText(mounted.container, text)),
                    `\`${text}\` must inherit the selected row's foreground, not force its own`,
                ).toBe(rowColor);
            }
        } finally {
            unmount(mounted.root, mounted.container);
        }
    });
});
