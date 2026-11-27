// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitChecksSnapshot } from "../../../src/types";
import { CommitChecksButton } from "../../../src/webviews/react/commit-list/CommitChecksPopover";
import { t } from "../../../src/webviews/react/shared/i18n";
import { initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

initReactDomTestEnvironment();

const snapshot: CommitChecksSnapshot = {
    hash: "abc1234",
    state: "failure",
    summary: "Some checks failed",
    items: Array.from({ length: 8 }, (_, index) => ({
        name: `Check job ${index + 1}`,
        description: `Job ${index + 1} finished`,
        state: index % 2 === 0 ? ("success" as const) : ("failure" as const),
        source: "check-run" as const,
        url: `https://example.test/job/${index + 1}`,
    })),
};

/**
 * Resolves a CSS length the panel uses (`Npx`, `Nvh`, `calc(a - b)`, `min(a, b)`) against the
 * window height. jsdom has no layout engine, so the test computes the height the browser would
 * cap the panel at. jsdom rewrites `calc(100vh - 16px)` inside `min()` to a bare
 * `-16px + 100vh`, so a bare sum is read too. Any part it cannot read makes the whole
 * expression NaN, which the caller treats as unreadable.
 */
function resolveLength(value: string, innerHeight: number): number {
    const text = value.trim();
    if (text === "") return NaN;
    const px = /^(-?\d+(?:\.\d+)?)px$/.exec(text);
    if (px) return Number(px[1]);
    const vh = /^(-?\d+(?:\.\d+)?)vh$/.exec(text);
    if (vh) return (Number(vh[1]) * innerHeight) / 100;
    const fn = /^(min|calc)\((.*)\)$/.exec(text);
    if (fn?.[1] === "min") {
        return Math.min(...splitTopLevel(fn[2], ",").map((arg) => resolveLength(arg, innerHeight)));
    }
    const sum = fn ? fn[2] : text;
    if (!/\s[+-]\s/.test(sum)) return NaN;
    const terms = sum.split(/\s+([+-])\s+/);
    let total = resolveLength(terms[0], innerHeight);
    for (let i = 1; i < terms.length; i += 2) {
        const term = resolveLength(terms[i + 1], innerHeight);
        total = terms[i] === "+" ? total + term : total - term;
    }
    return total;
}

function splitTopLevel(text: string, separator: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === "(") depth += 1;
        else if (text[i] === ")") depth -= 1;
        else if (text[i] === separator && depth === 0) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));
    return parts;
}

type Case = {
    name: string;
    innerHeight: number;
    top: number;
    bottom: number;
    /** The title row and footer need about 81 px, so a usable box is at least 90 px. */
    minBoxHeight?: number;
    maxBoxHeight?: number;
    /** The window is too short for both 8 px margins; only check the popup stays capped. */
    marginsImpossible?: boolean;
};

const cases: Case[] = [
    { name: "a top row in a short panel opens below", innerHeight: 240, top: 20, bottom: 44 },
    {
        name: "a bottom row in a mid-size panel opens above",
        innerHeight: 400,
        top: 200,
        bottom: 224,
    },
    {
        name: "a panel shorter than the popup's minimum height",
        innerHeight: 150,
        top: 20,
        bottom: 44,
    },
    {
        name: "the last visible row in a short panel opens toward the room",
        innerHeight: 150,
        top: 126,
        bottom: 150,
        minBoxHeight: 90,
    },
    {
        name: "a row partly below the window bottom stays inside the window",
        innerHeight: 129,
        top: 126,
        bottom: 150,
    },
    {
        name: "a row partly past the bottom edge opening above stays inside the window",
        innerHeight: 400,
        top: 390,
        bottom: 414,
    },
    {
        name: "a row scrolled partly off the top opening below stays inside the window",
        innerHeight: 400,
        top: -10,
        bottom: 14,
    },
    {
        name: "a tall window keeps the normal 360 px cap",
        innerHeight: 1000,
        top: 20,
        bottom: 44,
        maxBoxHeight: 360,
    },
    {
        name: "a centered popup in a mid-size window keeps the full 360 px cap",
        innerHeight: 600,
        top: 260,
        bottom: 284,
        minBoxHeight: 360,
    },
    {
        name: "a row below a tiny window still gets a capped popup",
        innerHeight: 12,
        top: 200,
        bottom: 224,
        marginsImpossible: true,
    },
];

const changedWindowProps = [
    "innerWidth",
    "innerHeight",
    "intelligitE2E",
    "intelligitI18n",
] as const;

describe("commit checks popover stays inside the window", () => {
    let savedDescriptors: Map<string, PropertyDescriptor | undefined>;

    beforeEach(() => {
        savedDescriptors = new Map(
            changedWindowProps.map((prop) => [prop, Object.getOwnPropertyDescriptor(window, prop)]),
        );
        installWebviewI18n();
    });

    afterEach(() => {
        for (const [prop, descriptor] of savedDescriptors) {
            if (descriptor) Object.defineProperty(window, prop, descriptor);
            else delete (window as unknown as Record<string, unknown>)[prop];
        }
        vi.restoreAllMocks();
    });

    /** Opens the popover from a row at `top`..`bottom` in a window `innerHeight` tall. */
    function openPanel(innerHeight: number, top: number, bottom: number) {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
        Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
        Object.defineProperty(window, "intelligitE2E", {
            configurable: true,
            writable: true,
            value: true,
        });

        const mounted = mount(
            <CommitChecksButton
                hash="abc1234"
                checks={snapshot}
                onRequestChecks={vi.fn()}
                onOpenCheckUrl={vi.fn()}
                onOpenInChecks={vi.fn()}
            />,
        );
        const trigger = mounted.container.querySelector("button") as HTMLButtonElement;
        vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
            bottom,
            height: bottom - top,
            left: 430,
            right: 454,
            top,
            width: 24,
            x: 430,
            y: top,
            toJSON: () => ({}),
        } as DOMRect);
        act(() => {
            trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        const popover = document.body.querySelector(
            '[data-testid="commit-checks-popover"]',
        ) as HTMLElement;
        expect(popover).not.toBeNull();
        const panel = Array.from(popover.children).find(
            (child): child is HTMLDivElement =>
                child instanceof HTMLDivElement &&
                (child.textContent ?? "").includes(t("commit.checks.title")),
        );
        expect(panel).toBeDefined();
        const footerButton = Array.from(panel!.querySelectorAll("button")).find(
            (button) => button.textContent === t("commit.checks.openInChecks"),
        );
        expect(footerButton).toBeDefined();
        return { popover, panel: panel!, footerButton: footerButton! };
    }

    it.each(cases)(
        "$name",
        ({ innerHeight, top, bottom, minBoxHeight, maxBoxHeight, marginsImpossible }) => {
            const { popover, panel } = openPanel(innerHeight, top, bottom);

            // Browsers discard a negative max-height and clamp a negative min-height to 0; an
            // unreadable value is unbounded (max) or 0 (min).
            const resolvedMin = resolveLength(panel.style.minHeight, innerHeight);
            const resolvedMax = resolveLength(panel.style.maxHeight, innerHeight);
            const minHeight = Number.isNaN(resolvedMin) || resolvedMin < 0 ? 0 : resolvedMin;
            const maxHeight = Number.isNaN(resolvedMax) || resolvedMax < 0 ? Infinity : resolvedMax;
            const height = Math.max(minHeight, maxHeight);
            const anchor = resolveLength(popover.style.top, innerHeight);
            const transform = popover.style.transform;
            // Only transforms this oracle can place: none, or translateX(-100%) then a vertical shift.
            expect(transform).toMatch(
                /^(?:translateX\(-100%\) ?)?(?:translateY\(-100%\)|translateY\(-50%\))?$/,
            );
            const boxTop = transform.includes("translateY(-100%)")
                ? anchor - height
                : transform.includes("translateY(-50%)")
                  ? anchor - height / 2
                  : anchor;
            const boxBottom = boxTop + height;

            expect(Number.isFinite(height)).toBe(true);
            if (!marginsImpossible) {
                expect(boxTop).toBeGreaterThanOrEqual(8);
                expect(boxBottom).toBeLessThanOrEqual(innerHeight - 8);
            }
            if (minBoxHeight !== undefined) expect(height).toBeGreaterThanOrEqual(minBoxHeight);
            if (maxBoxHeight !== undefined) expect(height).toBeLessThanOrEqual(maxBoxHeight);
        },
    );

    // A flex item never shrinks below its own vertical padding, so in an 85 px window (a 69 px
    // panel) padded title and list rows would push the footer out of the panel.
    it.each([false, true])(
        "only the footer keeps a height floor, so a cramped panel still shows it (refreshing: %s)",
        (refreshing) => {
            const { panel, footerButton } = openPanel(85, 54, 78);
            if (refreshing) {
                const refresh = panel.querySelector(
                    `button[aria-label="${t("common.refresh")}"]`,
                ) as HTMLButtonElement;
                act(() => {
                    refresh.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                });
                expect(panel.querySelector("output")).not.toBeNull();
            }
            const shrinkable = Array.from(panel.children).filter(
                (child): child is HTMLElement =>
                    child instanceof HTMLElement && !child.contains(footerButton),
            );
            expect(shrinkable.length).toBeGreaterThan(0);
            for (const child of shrinkable) {
                const floor = {
                    paddingTop: Number.parseFloat(child.style.paddingTop || "0"),
                    paddingBottom: Number.parseFloat(child.style.paddingBottom || "0"),
                    minHeight: Number.parseFloat(child.style.minHeight || "NaN"),
                    flexShrink: Number(child.style.flexShrink || "1") > 0,
                };
                expect(floor, child.textContent ?? "").toEqual({
                    paddingTop: 0,
                    paddingBottom: 0,
                    minHeight: 0,
                    flexShrink: true,
                });
            }
        },
    );

    // Flex shrinks items in proportion to weight x base size, and the list's base is up to
    // 250 px against the title's 41 px: a weight 100 times larger keeps the title (and its
    // Refresh button) whole until the list has almost no height left.
    it("the list gives way before the title, so Refresh stays in view", () => {
        const { panel } = openPanel(150, 126, 150);
        const children = Array.from(panel.children) as HTMLElement[];
        const title = children.find((child) =>
            child.querySelector(`button[aria-label="${t("common.refresh")}"]`),
        );
        const list = children.find((child) => child.hasAttribute("aria-busy"));
        const weight = (element: HTMLElement | undefined): number =>
            Number(element?.style.flexShrink || "1");
        expect(weight(list) / weight(title)).toBeGreaterThanOrEqual(100);
    });
});
