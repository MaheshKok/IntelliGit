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
 * `-16px + 100vh`, so a bare sum is read too. Anything else is unbounded.
 */
function resolveLength(value: string, innerHeight: number): number {
    const text = value.trim();
    if (text === "") return Infinity;
    const px = /^(-?\d+(?:\.\d+)?)px$/.exec(text);
    if (px) return Number(px[1]);
    const vh = /^(-?\d+(?:\.\d+)?)vh$/.exec(text);
    if (vh) return (Number(vh[1]) * innerHeight) / 100;
    const fn = /^(min|calc)\((.*)\)$/.exec(text);
    if (fn?.[1] === "min") {
        return Math.min(...splitTopLevel(fn[2], ",").map((arg) => resolveLength(arg, innerHeight)));
    }
    const sum = fn ? fn[2] : text;
    if (!/\s[+-]\s/.test(sum)) return Infinity;
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
];

const changedWindowProps = ["innerWidth", "innerHeight", "intelligitE2E"] as const;

describe("commit checks popover stays inside the window", () => {
    let savedDescriptors: Map<string, PropertyDescriptor | undefined>;

    beforeEach(() => {
        installWebviewI18n();
        savedDescriptors = new Map(
            changedWindowProps.map((prop) => [prop, Object.getOwnPropertyDescriptor(window, prop)]),
        );
    });

    afterEach(() => {
        for (const [prop, descriptor] of savedDescriptors) {
            if (descriptor) Object.defineProperty(window, prop, descriptor);
            else delete (window as unknown as Record<string, unknown>)[prop];
        }
        vi.restoreAllMocks();
    });

    it.each(cases)("$name", ({ innerHeight, top, bottom }) => {
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

        const minHeight = resolveLength(panel!.style.minHeight, innerHeight);
        const maxHeight = resolveLength(panel!.style.maxHeight, innerHeight);
        const height = Math.max(Number.isFinite(minHeight) ? minHeight : 0, maxHeight);
        const anchor = resolveLength(popover.style.top, innerHeight);
        const transform = popover.style.transform;
        const boxTop = transform.includes("translateY(-100%)")
            ? anchor - height
            : transform.includes("translateY(-50%)")
              ? anchor - height / 2
              : anchor;
        const boxBottom = boxTop + height;

        expect(boxTop).toBeGreaterThanOrEqual(0);
        expect(boxBottom).toBeLessThanOrEqual(innerHeight);
    });
});
