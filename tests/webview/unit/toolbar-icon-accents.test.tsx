// @vitest-environment jsdom
//
// Enforces DESIGN.md's "One Hue Per Bar Rule".
//
// `toolbar-icon-button.test.tsx` owns the *assignment* — that Rollback is amber,
// that Stash is pink. This file owns the *rule* those assignments have to obey,
// which is a different thing: no two actions in one bar may wear the same hue,
// and expand/collapse are the single sanctioned exception.
//
// The checks run against rendered output rather than against the token map,
// because the defect this replaces was call-site drift: every accent was picked
// at its `<ToolbarIconButton color={...}>` with no arbiter, and three of them
// silently converged. A test that only read the map would have stayed green
// through all of it.

import React from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShelfToolbar } from "../../../src/webviews/react/commit-panel/components/ShelfToolbar";
import { StashToolbar } from "../../../src/webviews/react/commit-panel/components/StashToolbar";
import { TabBar } from "../../../src/webviews/react/commit-panel/components/TabBar";
import { Toolbar } from "../../../src/webviews/react/commit-panel/components/Toolbar";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { t } from "../../../src/webviews/react/shared/i18n";
import {
    ICON_ACCENTS,
    TOOLBAR_ACCENT_BARS,
    TOOLBAR_ICON_ACCENTS,
} from "../../../src/webviews/react/shared/tokens";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

vi.mock("@chakra-ui/react", async (importOriginal) => {
    const chakra = await importOriginal<typeof import("@chakra-ui/react")>();
    return {
        ...chakra,
        Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
    };
});

initReactDomTestEnvironment();

const ACCENT_VALUES = new Set<string>(Object.values(ICON_ACCENTS));

/**
 * Maps every accent-bearing button in a rendered bar to the hue it actually
 * paints. Controls that deliberately stay neutral — the shelf overflow menu
 * renders in `--vscode-icon-foreground` — carry no accent and drop out here,
 * which is what makes the uniqueness check meaningful rather than noisy.
 */
function renderedAccents(container: ParentNode): Map<string, string> {
    const accents = new Map<string, string>();
    for (const button of container.querySelectorAll<HTMLButtonElement>("button[aria-label]")) {
        const color = button.querySelector<SVGElement>("svg")?.style.color ?? "";
        if (ACCENT_VALUES.has(color)) accents.set(button.getAttribute("aria-label") ?? "", color);
    }
    return accents;
}

/** The labels sharing each hue that more than one button in the bar wears. */
function sharedHues(accents: Map<string, string>): string[][] {
    const byHue = new Map<string, string[]>();
    for (const [label, color] of accents) byHue.set(color, [...(byHue.get(color) ?? []), label]);
    return [...byHue.values()]
        .filter((labels) => labels.length > 1)
        .map((labels) => [...labels].sort())
        .sort();
}

function rosterAccents(bar: keyof typeof TOOLBAR_ACCENT_BARS): Set<string> {
    return new Set<string>(TOOLBAR_ACCENT_BARS[bar].map((action) => TOOLBAR_ICON_ACCENTS[action]));
}

function mountBar(node: React.ReactElement) {
    return mount(<ChakraProvider theme={theme}>{node}</ChakraProvider>);
}

const commitToolbar = () => (
    <Toolbar
        onRefresh={vi.fn()}
        groupByDir={false}
        showIgnoredFiles={false}
        onRollback={vi.fn()}
        onToggleGroupBy={vi.fn()}
        onToggleShowIgnoredFiles={vi.fn()}
        onStash={vi.fn()}
        onOpenShelfMenu={vi.fn()}
        onShowDiff={vi.fn()}
        hasFiles
        onExpandAll={vi.fn()}
        onCollapseAll={vi.fn()}
        showAbortMerge={false}
        onAbortMerge={vi.fn()}
        onContinueRebase={vi.fn()}
        onAbortRebase={vi.fn()}
    />
);

const shelfToolbar = () => (
    <ShelfToolbar
        canExpandOrCollapse
        groupByDir={false}
        showAlreadyUnshelved={false}
        isRefreshing={false}
        onRefresh={vi.fn()}
        onToggleGroupBy={vi.fn()}
        onExpandAll={vi.fn()}
        onCollapseAll={vi.fn()}
        onCleanUp={vi.fn()}
        onToggleAlreadyUnshelved={vi.fn()}
    />
);

const stashToolbar = () => (
    <StashToolbar
        selectedIndex={0}
        groupByDir={false}
        canExpandOrCollapse
        isRefreshing={false}
        onRefresh={vi.fn()}
        onShowStashDiff={vi.fn()}
        onToggleGroupBy={vi.fn()}
        onExpandAll={vi.fn()}
        onCollapseAll={vi.fn()}
    />
);

const tabBar = () => (
    <TabBar
        stashCount={0}
        onSync={vi.fn()}
        onFetch={vi.fn()}
        onPull={vi.fn()}
        onPush={vi.fn()}
        onOpenRepository={vi.fn()}
        onDock={vi.fn()}
        commitContent={null}
        stashContent={null}
    />
);

beforeEach(() => {
    installWebviewI18n();
    window.intelligitSettings = {
        hoverDelay: 300,
        tooltipsEnabled: true,
        // Hue is only load-bearing in the "color" style; "standard" flattens every
        // accent to the host icon foreground, so the rule has nothing to police there.
        iconStyle: "color",
        commitWindowPosition: "left",
    };
});

describe("toolbar icon accents", () => {
    it("gives every action in a bar its own hue, sharing only between expand and collapse", () => {
        const pair = [t("common.collapseAll"), t("common.expandAll")].sort();
        const bars = [
            { name: "tabBar", node: tabBar(), shared: [] as string[][] },
            { name: "commitToolbar", node: commitToolbar(), shared: [pair] },
            { name: "shelfToolbar", node: shelfToolbar(), shared: [pair] },
            { name: "stashToolbar", node: stashToolbar(), shared: [pair] },
        ] as const;

        for (const bar of bars) {
            const { root, container } = mountBar(bar.node);
            expect(sharedHues(renderedAccents(container)), bar.name).toEqual(bar.shared);
            unmount(root, container);
        }
    });

    it("draws every rendered accent from the bar's own roster", () => {
        // Catches the other half of call-site drift: a button that picks a hue
        // nobody recorded, or a button added to a bar whose roster was never
        // widened. Either one silently escapes the uniqueness rule otherwise.
        const bars = [
            { name: "tabBar", node: tabBar() },
            { name: "commitToolbar", node: commitToolbar() },
            { name: "shelfToolbar", node: shelfToolbar() },
            { name: "stashToolbar", node: stashToolbar() },
        ] as const;

        for (const bar of bars) {
            const { root, container } = mountBar(bar.node);
            expect(new Set(renderedAccents(container).values()), bar.name).toEqual(
                rosterAccents(bar.name),
            );
            unmount(root, container);
        }
    });

    it("keeps the roster itself collision-free", () => {
        // The rendered checks above cannot see a bar until someone renders it, so
        // the map gets the same rule applied statically.
        for (const [name, actions] of Object.entries(TOOLBAR_ACCENT_BARS)) {
            const accents = actions.map((action) => TOOLBAR_ICON_ACCENTS[action]);
            expect(new Set(accents).size, name).toBe(accents.length);
        }
    });
});
