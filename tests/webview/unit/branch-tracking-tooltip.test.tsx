// @vitest-environment jsdom

/**
 * Guards the branch column's ahead/behind tooltip against being written in English
 * inside the component.
 *
 * The tooltip used to build itself from string literals with a hand-rolled `=== 1 ? "" : "s"`
 * plural and a hardcoded `" and "` joiner, so it stayed English in all 12 shipped locales
 * while every neighbouring string translated. That failure is invisible to the catalog
 * completeness gates in `tests/unit/localization/localization.test.ts`: they compare
 * `src/webviews/i18n/*.json` against `en.json` and cannot see a string that never reached a
 * catalog at all.
 *
 * The first case therefore renders against a SENTINEL catalog rather than the shipped one.
 * A component that resolves through `t()` echoes the sentinel; a component that owns its
 * own text cannot, no matter what the catalogs say. Asserting the real English wording
 * instead would pass for the hardcoded implementation, which is the bug.
 */

import React from "react";
import { readFileSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Branch } from "../../../src/types";
import { BranchColumn } from "../../../src/webviews/react/BranchColumn";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";

const mockVscodeApi = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn((): unknown => undefined),
    setState: vi.fn(),
}));

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => mockVscodeApi,
}));

initReactDomTestEnvironment();

type Catalog = Record<string, string | Record<string, string>>;

function readCatalog(locale: string): Catalog {
    return JSON.parse(
        readFileSync(path.join(process.cwd(), `src/webviews/i18n/${locale}.json`), "utf8"),
    ) as Catalog;
}

/**
 * Installs an i18n payload the way the host does.
 *
 * `tests/helpers/webviewI18nTestUtils.ts` always installs the English catalog and only varies
 * the locale tag, which cannot express either case below: a sentinel catalog, or a locale whose
 * plural categories English does not have.
 */
function installCatalog(locale: string, catalog: Catalog): void {
    const payload = {
        locale,
        fallbackLocale: "en",
        catalog,
        fallbackCatalog: readCatalog("en"),
    };
    Object.defineProperty(globalThis, "intelligitI18n", { configurable: true, value: payload });
    Object.defineProperty(window, "intelligitI18n", { configurable: true, value: payload });
}

afterEach(() => {
    Reflect.deleteProperty(globalThis, "intelligitI18n");
    Reflect.deleteProperty(window, "intelligitI18n");
});

/** Renders one non-current branch and returns the tooltip text its tracking badge carries. */
function tooltipFor(tracking: { ahead: number; behind: number }): string | null {
    const branches: Branch[] = [
        { name: "main", hash: "feed1234", isRemote: false, isCurrent: true, ahead: 0, behind: 0 },
        {
            name: "feature-demo",
            hash: "a1b2c3d4",
            isRemote: false,
            isCurrent: false,
            ...tracking,
        },
    ];
    const mounted = mount(
        <BranchColumn
            branches={branches}
            selectedBranch={null}
            onSelectBranch={vi.fn()}
            onBranchAction={vi.fn()}
        />,
    );
    const row = Array.from(mounted.container.querySelectorAll(".branch-row")).find((candidate) =>
        candidate.textContent?.includes("feature-demo"),
    );
    const text = row?.querySelector("[data-branch-tooltip]")?.getAttribute("data-branch-tooltip");
    unmount(mounted.root, mounted.container);
    return text ?? null;
}

describe("branch tracking tooltip", () => {
    it("builds every part from the catalog rather than literals in the component", () => {
        installCatalog("en", {
            ...readCatalog("en"),
            "branch.tracking.incoming": {
                one: "SENTINEL-IN-{count}",
                other: "SENTINEL-INS-{count}",
            },
            "branch.tracking.outgoing": {
                one: "SENTINEL-OUT-{count}",
                other: "SENTINEL-OUTS-{count}",
            },
            "branch.tracking.combined": "{incoming}||{outgoing}",
        });

        expect(
            tooltipFor({ behind: 3, ahead: 2 }),
            "the tooltip is assembled from string literals in BranchTreeNodeRow instead of " +
                "resolved through t(), so it stays English in all 12 shipped locales",
        ).toBe("SENTINEL-INS-3||SENTINEL-OUTS-2");
    });

    it("uses the singular catalog entry, not a suffix rule the component owns", () => {
        installCatalog("en", {
            ...readCatalog("en"),
            "branch.tracking.incoming": {
                one: "SENTINEL-IN-{count}",
                other: "SENTINEL-INS-{count}",
            },
            "branch.tracking.outgoing": {
                one: "SENTINEL-OUT-{count}",
                other: "SENTINEL-OUTS-{count}",
            },
            "branch.tracking.combined": "{incoming}||{outgoing}",
        });

        expect(tooltipFor({ behind: 1, ahead: 1 })).toBe("SENTINEL-IN-1||SENTINEL-OUT-1");
    });

    // Russian selects `many` at 5 and `few` at 2-4. English has neither category, so these
    // strings can only come from ru.json -- a component that pluralized with English rules
    // (or fell through to the English catalog) would produce the `other` form for both.
    it("selects a plural category the English catalog cannot express", () => {
        installCatalog("ru", readCatalog("ru"));

        expect(
            tooltipFor({ behind: 5, ahead: 1 }),
            "the Russian `many` form and the translated joiner must both come from ru.json",
        ).toBe("5 входящих коммитов и 1 исходящий коммит");
    });

    it("omits the combined form when only one direction has commits", () => {
        installCatalog("ru", readCatalog("ru"));

        // A joiner appended unconditionally would leave a dangling " и " here.
        expect(tooltipFor({ behind: 2, ahead: 0 })).toBe("2 входящих коммита");
        expect(tooltipFor({ behind: 0, ahead: 3 })).toBe("3 исходящих коммита");
    });

    it("renders no badge at all when the branch is level with its upstream", () => {
        installCatalog("ru", readCatalog("ru"));

        expect(tooltipFor({ behind: 0, ahead: 0 })).toBeNull();
    });
});
