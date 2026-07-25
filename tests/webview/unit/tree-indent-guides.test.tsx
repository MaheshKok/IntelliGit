// @vitest-environment jsdom

import React from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ShelfFileEntry } from "../../../src/shelf/model";
import { ShelfFileTree } from "../../../src/webviews/react/commit-panel/components/ShelfFileTree";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

const entries = [
    { changeId: "root", worktreeBlock: { path: "CHANGELOG.md", status: "M" } },
    { changeId: "nested", worktreeBlock: { path: "src/app.ts", status: "M" } },
] as ShelfFileEntry[];

/** Counts the absolutely positioned vertical rules a row draws for tree depth. */
function guideCount(row: HTMLElement): number {
    return Array.from(row.querySelectorAll("span")).filter(
        (span) => getComputedStyle(span).position === "absolute",
    ).length;
}

function renderTree(groupByDir: boolean) {
    return mount(
        <ChakraProvider theme={theme}>
            <ShelfFileTree
                entries={entries}
                groupByDir={groupByDir}
                depth={0}
                isDirectoryCollapsed={() => false}
                onToggleDirectory={() => undefined}
                onFileActivate={() => undefined}
            />
        </ChakraProvider>,
    );
}

describe("shelf file rows draw one indent guide per real ancestor", () => {
    beforeEach(() => installWebviewI18n());

    it("draws a single guide for the owning entry row, not the deleted section header", () => {
        const { root, container } = renderTree(false);

        for (const changeId of ["root", "nested"]) {
            const row = container.querySelector(`[data-shelf-file="${changeId}"]`) as HTMLElement;
            expect(guideCount(row)).toBe(1);
        }

        unmount(root, container);
    });

    it("adds exactly one more guide for a file nested inside a grouped directory", () => {
        const { root, container } = renderTree(true);
        const topLevel = container.querySelector('[data-shelf-file="root"]') as HTMLElement;
        const inDirectory = container.querySelector('[data-shelf-file="nested"]') as HTMLElement;

        expect(guideCount(topLevel)).toBe(1);
        expect(guideCount(inDirectory)).toBe(2);

        unmount(root, container);
    });
});
