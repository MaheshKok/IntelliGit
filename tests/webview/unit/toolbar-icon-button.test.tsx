// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolbarIconButton } from "../../../src/webviews/react/shared/components/ToolbarIconButton";
import { ShelfToolbar } from "../../../src/webviews/react/commit-panel/components/ShelfToolbar";
import { StashToolbar } from "../../../src/webviews/react/commit-panel/components/StashToolbar";
import { Toolbar } from "../../../src/webviews/react/commit-panel/components/Toolbar";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

vi.mock("@chakra-ui/react", async (importOriginal) => {
    const chakra = await importOriginal<typeof import("@chakra-ui/react")>();
    return {
        ...chakra,
        Tooltip: ({
            children,
            isDisabled,
            label,
        }: React.PropsWithChildren<{ isDisabled?: boolean; label: string }>) =>
            isDisabled ? (
                <>{children}</>
            ) : (
                <span role="tooltip">
                    {label}
                    {children}
                </span>
            ),
    };
});

initReactDomTestEnvironment();

function renderButton(overrides: Partial<React.ComponentProps<typeof ToolbarIconButton>> = {}) {
    const onClick = vi.fn();
    const mounted = mount(
        <ChakraProvider theme={theme}>
            <ToolbarIconButton
                label="Refresh"
                icon={<svg width="16" height="16" viewBox="0 0 16 16" />}
                onClick={onClick}
                {...overrides}
            />
        </ChakraProvider>,
    );
    return { ...mounted, onClick };
}

function toolbarGlyph(container: ParentNode, label: string): SVGElement {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    const glyph = button?.querySelector<SVGElement>("svg");
    if (!glyph) throw new Error(`Missing ${label} toolbar glyph`);
    return glyph;
}

function expectDirectCodicon(container: ParentNode, label: string): SVGElement {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    const icons = button?.querySelectorAll<SVGElement>("svg");
    expect(icons).toHaveLength(1);
    const glyph = icons?.[0] ?? toolbarGlyph(container, label);
    expect(glyph.getAttribute("width")).toBe("16");
    expect(glyph.getAttribute("height")).toBe("16");
    expect(glyph.getAttribute("fill")).toBe("currentColor");
    return glyph;
}

function expectLegacyTreeControlGlyph(
    container: ParentNode,
    label: string,
    pathData: string,
): SVGElement {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    const icons = button?.querySelectorAll<SVGElement>("svg");
    expect(icons).toHaveLength(1);
    const glyph = icons?.[0] ?? toolbarGlyph(container, label);
    expect(glyph.getAttribute("width")).toBe("16");
    expect(glyph.getAttribute("height")).toBe("16");
    expect(glyph.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(glyph.getAttribute("fill")).toBeNull();
    const path = glyph.querySelector("path");
    expect(path?.getAttribute("fill")).toBe("currentColor");
    expect(path?.getAttribute("fill-rule")).toBe("evenodd");
    expect(path?.getAttribute("d")).toBe(pathData);
    return glyph;
}

const EXPAND_ALL_PATH =
    "M5.828 10.172a.5.5 0 0 0-.707 0l-4.096 4.096V11.5a.5.5 0 0 0-1 0v3.975a.5.5 0 0 0 .5.5H4.5a.5.5 0 0 0 0-1H1.732l4.096-4.096a.5.5 0 0 0 0-.707m4.344-4.344a.5.5 0 0 0 .707 0l4.096-4.096V4.5a.5.5 0 1 0 1 0V.525a.5.5 0 0 0-.5-.5H11.5a.5.5 0 0 0 0 1h2.768l-4.096 4.096a.5.5 0 0 0 0 .707";
const COLLAPSE_ALL_PATH =
    "M.172 15.828a.5.5 0 0 0 .707 0l4.096-4.096V14.5a.5.5 0 1 0 1 0v-3.975a.5.5 0 0 0-.5-.5H1.5a.5.5 0 0 0 0 1h2.768L.172 15.121a.5.5 0 0 0 0 .707M15.828.172a.5.5 0 0 0-.707 0l-4.096 4.096V1.5a.5.5 0 1 0-1 0v3.975a.5.5 0 0 0 .5.5H14.5a.5.5 0 0 0 0-1h-2.768L15.828.879a.5.5 0 0 0 0-.707";

beforeEach(() => {
    installWebviewI18n();
    window.intelligitSettings = {
        hoverDelay: 300,
        tooltipsEnabled: true,
        iconStyle: "standard",
        commitWindowPosition: "left",
    };
});

describe("ToolbarIconButton", () => {
    it("renders the ownership-scoped rebase controls without replacing the non-rebase abort contract", () => {
        const renderToolbar = (
            activeOperation: "rebase" | "merge" | "cherry-pick" | "revert" | "none" | undefined,
            rebaseControl?: "owned" | "unowned" | "foreign",
        ) =>
            mount(
                <ChakraProvider theme={theme}>
                    <Toolbar
                        {...({
                            onRefresh: vi.fn(),
                            groupByDir: false,
                            showIgnoredFiles: false,
                            onRollback: vi.fn(),
                            onToggleGroupBy: vi.fn(),
                            onToggleShowIgnoredFiles: vi.fn(),
                            onStash: vi.fn(),
                            onShowDiff: vi.fn(),
                            onExpandAll: vi.fn(),
                            onCollapseAll: vi.fn(),
                            showAbortMerge: true,
                            onAbortMerge: vi.fn(),
                            activeOperation,
                            rebaseControl,
                            onContinueRebase: vi.fn(),
                            onAbortRebase: vi.fn(),
                        } as React.ComponentProps<typeof Toolbar> & {
                            activeOperation?: "rebase" | "merge" | "cherry-pick" | "revert" | "none";
                            rebaseControl?: "owned" | "unowned" | "foreign";
                            onContinueRebase: () => void;
                            onAbortRebase: () => void;
                        })}
                    />
                </ChakraProvider>,
            );

        for (const rebaseControl of ["owned", "unowned"] as const) {
            const mounted = renderToolbar("rebase", rebaseControl);
            expect(mounted.container.textContent).toContain("Continue Rebase");
            expect(mounted.container.textContent).toContain("Abort Rebase");
            expect(mounted.container.textContent).not.toContain("Abort Merge");
            unmount(mounted.root, mounted.container);
        }

        const foreign = renderToolbar("rebase", "foreign");
        expect(foreign.container.textContent).not.toContain("Continue Rebase");
        expect(foreign.container.textContent).not.toContain("Abort Rebase");
        expect(foreign.container.textContent).not.toContain("Abort Merge");
        unmount(foreign.root, foreign.container);

        for (const operation of ["merge", "cherry-pick", "revert", "none", undefined] as const) {
            const mounted = renderToolbar(operation);
            expect(mounted.container.textContent).not.toContain("Continue Rebase");
            expect(mounted.container.textContent).not.toContain("Abort Rebase");
            expect(mounted.container.textContent).toContain("Abort Merge");
            unmount(mounted.root, mounted.container);
        }
    });

    it("omits the tooltip when tooltips are disabled", () => {
        window.intelligitSettings = { ...window.intelligitSettings, tooltipsEnabled: false };
        const { root, container } = renderButton();

        expect(container.querySelector('[role="tooltip"]')).toBeNull();

        unmount(root, container);
    });

    it("preserves pressed, disabled, spinning, and click behavior", () => {
        const { root, container, onClick } = renderButton({ pressed: true, spin: true });
        const button = container.querySelector("button") as HTMLButtonElement;
        const icon = button.querySelector("svg") as SVGElement;

        expect(button.getAttribute("aria-pressed")).toBe("true");
        expect(button.getAttribute("data-refreshing")).toBe("true");
        expect(icon.style.animation).toContain("intelligit-spin");
        unmount(root, container);

        const clickable = renderButton();
        const clickableButton = clickable.container.querySelector("button") as HTMLButtonElement;
        expect(clickableButton.getAttribute("aria-pressed")).toBeNull();
        act(() => clickableButton.click());
        expect(clickable.onClick).toHaveBeenCalledTimes(1);
        unmount(clickable.root, clickable.container);

        const disabled = renderButton({ disabled: true });
        const disabledButton = disabled.container.querySelector("button") as HTMLButtonElement;
        expect(disabledButton.disabled).toBe(true);
        act(() => disabledButton.click());
        expect(disabled.onClick).not.toHaveBeenCalled();
        unmount(disabled.root, disabled.container);

        const disabledSpinner = renderButton({ disabled: true, spin: true, color: "#4ec7d6" });
        const disabledSpinnerButton = disabledSpinner.container.querySelector("button") as HTMLButtonElement;
        const disabledSpinnerIcon = disabledSpinnerButton.querySelector("svg") as SVGElement;
        expect(disabledSpinnerButton.disabled).toBe(true);
        expect(disabledSpinnerIcon.style.color).toBe("rgb(78, 199, 214)");
        expect(disabledSpinnerIcon.style.animation).toContain("intelligit-spin");
        act(() => disabledSpinnerButton.click());
        expect(disabledSpinner.onClick).not.toHaveBeenCalled();
        unmount(disabledSpinner.root, disabledSpinner.container);
    });

    it("renders the tooltip with the label when tooltips are enabled", () => {
        const { root, container } = renderButton();

        const tooltip = container.querySelector('[role="tooltip"]');
        expect(tooltip).not.toBeNull();
        expect(tooltip?.textContent).toContain("Refresh");

        unmount(root, container);
    });

    it("keeps Codicons for the unchanged Commit toolbar actions", () => {
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
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
                    onExpandAll={vi.fn()}
                    onCollapseAll={vi.fn()}
                    showAbortMerge={false}
                    onAbortMerge={vi.fn()}
                />
            </ChakraProvider>,
        );

        for (const label of [
            "Refresh",
            "Rollback",
            "View Options",
            "Stash Changes",
            "Shelf actions",
            "Show Diff Preview",
        ]) {
            expectDirectCodicon(container, label);
        }
        expectLegacyTreeControlGlyph(container, "Expand All", EXPAND_ALL_PATH);
        expectLegacyTreeControlGlyph(container, "Collapse All", COLLAPSE_ALL_PATH);

        unmount(root, container);
    });

    it("uses semantic accent colors for Commit toolbar actions", () => {
        window.intelligitSettings = { ...window.intelligitSettings, iconStyle: "color" };
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
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
                    onExpandAll={vi.fn()}
                    onCollapseAll={vi.fn()}
                    showAbortMerge={false}
                    onAbortMerge={vi.fn()}
                />
            </ChakraProvider>,
        );

        expect(expectDirectCodicon(container, "Rollback").style.color).toBe("rgb(242, 196, 109)");
        expect(expectDirectCodicon(container, "View Options").style.color).toBe(
            "rgb(143, 213, 255)",
        );
        expect(expectDirectCodicon(container, "Stash Changes").style.color).toBe(
            "rgb(234, 143, 179)",
        );
        expect(expectDirectCodicon(container, "Shelf actions").style.color).toBe(
            "rgb(200, 162, 255)",
        );
        expect(expectDirectCodicon(container, "Show Diff Preview").style.color).toBe(
            "rgb(184, 173, 255)",
        );
        expect(expectLegacyTreeControlGlyph(container, "Expand All", EXPAND_ALL_PATH).style.color).toBe(
            "rgb(243, 177, 207)",
        );
        expect(
            expectLegacyTreeControlGlyph(container, "Collapse All", COLLAPSE_ALL_PATH).style.color,
        ).toBe("rgb(243, 177, 207)");

        unmount(root, container);
    });

    it("resolves icon color and spin state through one contract for every toolbar", () => {
        // iconStyle "color" honors the per-icon accent; spin always advertises
        // data-refreshing, no matter which toolbar renders the button.
        window.intelligitSettings = { ...window.intelligitSettings, iconStyle: "color" };

        const spinning = renderButton({ spin: true, color: "#123456" });
        const spinningButton = spinning.container.querySelector("button") as HTMLButtonElement;
        const spinningIcon = spinningButton.querySelector("svg") as SVGElement;
        expect(spinningButton.getAttribute("data-refreshing")).toBe("true");
        expect(spinningIcon.style.color).toBe("rgb(18, 52, 86)");
        unmount(spinning.root, spinning.container);

        const accent = renderButton({ color: "#123456" });
        const accentButton = accent.container.querySelector("button") as HTMLButtonElement;
        const accentIcon = accentButton.querySelector("svg") as SVGElement;
        expect(accentButton.getAttribute("data-refreshing")).toBeNull();
        expect(accentIcon.style.color).toBe("rgb(18, 52, 86)");
        unmount(accent.root, accent.container);

        window.intelligitSettings = { ...window.intelligitSettings, iconStyle: "standard" };
        const standard = renderButton({ color: "#123456" });
        const standardIcon = standard.container.querySelector("svg") as SVGElement;
        expect(standardIcon.style.color).toBe("var(--vscode-icon-foreground)");
        unmount(standard.root, standard.container);
    });

    it("uses the shared accent palette in the Stash and Shelf toolbars", () => {
        window.intelligitSettings = { ...window.intelligitSettings, iconStyle: "color" };
        const stash = mount(
            <ChakraProvider theme={theme}>
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
            </ChakraProvider>,
        );
        expectDirectCodicon(stash.container, "Refresh");
        expect(expectDirectCodicon(stash.container, "Show Diff").style.color).toBe(
            "rgb(184, 173, 255)",
        );
        expect(expectDirectCodicon(stash.container, "Group by Directory").style.color).toBe(
            "rgb(143, 213, 255)",
        );
        expect(expectLegacyTreeControlGlyph(stash.container, "Expand All", EXPAND_ALL_PATH).style.color).toBe(
            "rgb(243, 177, 207)",
        );
        expect(
            expectLegacyTreeControlGlyph(stash.container, "Collapse All", COLLAPSE_ALL_PATH).style.color,
        ).toBe(
            "rgb(243, 177, 207)",
        );
        unmount(stash.root, stash.container);

        const shelf = mount(
            <ChakraProvider theme={theme}>
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
            </ChakraProvider>,
        );
        expectDirectCodicon(shelf.container, "Refresh");
        expect(expectDirectCodicon(shelf.container, "Group by Directory").style.color).toBe(
            "rgb(143, 213, 255)",
        );
        expect(expectLegacyTreeControlGlyph(shelf.container, "Expand All", EXPAND_ALL_PATH).style.color).toBe(
            "rgb(243, 177, 207)",
        );
        expect(
            expectLegacyTreeControlGlyph(shelf.container, "Collapse All", COLLAPSE_ALL_PATH).style.color,
        ).toBe(
            "rgb(243, 177, 207)",
        );
        expect(expectDirectCodicon(shelf.container, "More Options").style.color).toBe(
            "var(--vscode-icon-foreground)",
        );
        unmount(shelf.root, shelf.container);
    });
});
