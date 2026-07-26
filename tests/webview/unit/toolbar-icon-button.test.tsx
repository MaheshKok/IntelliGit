// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolbarIconButton } from "../../../src/webviews/react/shared/components/ToolbarIconButton";
import { ShelfToolbar } from "../../../src/webviews/react/commit-panel/components/ShelfToolbar";
import { StashToolbar } from "../../../src/webviews/react/commit-panel/components/StashToolbar";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";

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

beforeEach(() => {
    window.intelligitSettings = {
        hoverDelay: 300,
        tooltipsEnabled: true,
        iconStyle: "standard",
        commitWindowPosition: "left",
    };
});

describe("ToolbarIconButton", () => {
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
        const stashIcons = stash.container.querySelectorAll("svg");
        expect(stashIcons[1]?.style.color).toBe("rgb(143, 213, 255)");
        expect(stashIcons[2]?.style.color).toBe("rgb(143, 213, 255)");
        expect(stashIcons[3]?.style.color).toBe("rgb(243, 177, 207)");
        expect(stashIcons[4]?.style.color).toBe("rgb(243, 177, 207)");
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
        const shelfIcons = shelf.container.querySelectorAll("svg");
        expect(shelfIcons[1]?.style.color).toBe("rgb(143, 213, 255)");
        expect(shelfIcons[2]?.style.color).toBe("rgb(243, 177, 207)");
        expect(shelfIcons[3]?.style.color).toBe("rgb(243, 177, 207)");
        expect(shelfIcons[4]?.style.color).toBe("rgb(243, 177, 207)");
        unmount(shelf.root, shelf.container);
    });
});
