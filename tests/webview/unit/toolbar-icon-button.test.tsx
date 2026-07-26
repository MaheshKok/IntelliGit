// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolbarIconButton } from "../../../src/webviews/react/shared/components/ToolbarIconButton";
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
    });

    it("renders the tooltip with the label when tooltips are enabled", () => {
        const { root, container } = renderButton();

        const tooltip = container.querySelector('[role="tooltip"]');
        expect(tooltip).not.toBeNull();
        expect(tooltip?.textContent).toContain("Refresh");

        unmount(root, container);
    });

    it("keeps commit-toolbar-only attributes off the stash and shelf presentations", () => {
        // Non-standard icon style so the toolbar branch honors `color`, making the
        // stash branch's forced icon-foreground a real discriminator.
        window.intelligitSettings = { ...window.intelligitSettings, iconStyle: "color" };

        const stash = renderButton({ presentation: "stash", spin: true, color: "#123456" });
        const stashButton = stash.container.querySelector("button") as HTMLButtonElement;
        const stashIcon = stashButton.querySelector("svg") as SVGElement;
        expect(stashButton.getAttribute("data-refreshing")).toBeNull();
        expect(stashIcon.style.color).toBe("var(--vscode-icon-foreground)");
        unmount(stash.root, stash.container);

        const shelf = renderButton({ presentation: "shelf", spin: true, color: "#123456" });
        const shelfButton = shelf.container.querySelector("button") as HTMLButtonElement;
        const shelfIcon = shelfButton.querySelector("svg") as SVGElement;
        expect(shelfButton.getAttribute("data-refreshing")).toBeNull();
        expect(shelfIcon.style.color).toBe("");
        unmount(shelf.root, shelf.container);

        const toolbar = renderButton({ spin: true, color: "#123456" });
        const toolbarButton = toolbar.container.querySelector("button") as HTMLButtonElement;
        const toolbarIcon = toolbarButton.querySelector("svg") as SVGElement;
        expect(toolbarButton.getAttribute("data-refreshing")).toBe("true");
        expect(toolbarIcon.style.color).not.toBe("var(--vscode-icon-foreground)");
        unmount(toolbar.root, toolbar.container);
    });
});
