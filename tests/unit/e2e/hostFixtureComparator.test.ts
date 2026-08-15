import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
    compareHostFixtures,
    formatHostFixtureDifferences,
    HOST_FIXTURE_FIELD_INVENTORY,
} from "../../e2e/hostFixtures/hostFixtureComparator";
import { hostFixtureFilePath } from "../../e2e/hostFixtures/hostFixtureFile";
import type { HostFixture } from "../../e2e/hostFixtures/types";

/** Builds a complete hand-written fixture so comparator tests never depend on filesystem state. */
function createFixture(): HostFixture {
    return {
        provenance: {
            captureSchemaVersion: 2,
            vscodeVersion: "1.132.0",
            vscodeCommit: "pinned-commit",
            platform: "linux-x64",
            themeId: "dark-modern",
            themeName: "Dark Modern",
            requestedTheme: "Dark Modern",
            themeKind: "vscode-dark",
        },
        documentElement: {
            classList: ["vscode-dark"],
            dataset: { vscodeThemeId: "dark-modern" },
            styleCssText: "--vscode-editor-background: #000000;",
        },
        body: {
            classList: ["vscode-dark"],
            dataset: { vscodeThemeKind: "vscode-dark" },
        },
    };
}

const INVENTORY_SECTIONS = ["topLevel", "provenance", "documentElement", "body"] as const;
type InventorySection = (typeof INVENTORY_SECTIONS)[number];

/** The section's full declared field list -- compared plus deliberately excluded. */
function sectionInventory(section: InventorySection): readonly string[] {
    const { compared, excluded } = HOST_FIXTURE_FIELD_INVENTORY[section];
    return [...compared, ...excluded];
}

// Walking the inventory generically means indexing a typed fixture by strings the type system
// cannot narrow. The casts are confined to these two helpers so the tests themselves stay readable.
function asRecord(fixture: HostFixture): Record<string, unknown> {
    return fixture as unknown as Record<string, unknown>;
}

/** Produces a value that differs from `value` while keeping its shape. */
function mutateValue(value: unknown): unknown {
    if (typeof value === "number") return value + 1;
    if (typeof value === "string") return `${value}-mutated`;
    if (Array.isArray(value)) return [...value, "mutated"];
    return { ...(value as Record<string, string>), mutatedKey: "mutated" };
}

function withMutatedField(
    fixture: HostFixture,
    section: Exclude<InventorySection, "topLevel">,
    field: string,
): HostFixture {
    const sectionValue = asRecord(fixture)[section] as Record<string, unknown>;
    return {
        ...asRecord(fixture),
        [section]: { ...sectionValue, [field]: mutateValue(sectionValue[field]) },
    } as unknown as HostFixture;
}

describe("compareHostFixtures", () => {
    it("returns no differences for identical fixtures", () => {
        const fixture = createFixture();

        expect(compareHostFixtures(fixture, fixture)).toEqual([]);
    });

    it.each(INVENTORY_SECTIONS)(
        "keeps the %s inventory in exact two-way sync with a committed fixture",
        (section) => {
            const repoRoot = resolve(__dirname, "../../..");
            const committedFixture = JSON.parse(
                readFileSync(hostFixtureFilePath(repoRoot, "dark-modern"), "utf8"),
            ) as HostFixture;
            const inventory = sectionInventory(section);
            const actualKeys =
                section === "topLevel"
                    ? Object.keys(committedFixture)
                    : Object.keys(asRecord(committedFixture)[section] as Record<string, unknown>);

            // Both directions: a new field on disk must fail until it is inventoried, AND an
            // inventory entry that no longer exists on disk must fail too. A subset check either
            // way lets the inventory rot in one direction while still reading as green.
            expect(new Set(actualKeys)).toEqual(new Set(inventory));
            expect(new Set(inventory)).toEqual(new Set(actualKeys));
        },
    );

    it("reports a changed class list with both values", () => {
        const committed = createFixture();
        const captured: HostFixture = {
            ...committed,
            body: { ...committed.body, classList: ["vscode-dark", "upstream-change"] },
        };

        expect(compareHostFixtures(committed, captured)).toEqual([
            {
                field: "body.classList",
                committedValue: ["vscode-dark"],
                capturedValue: ["vscode-dark", "upstream-change"],
            },
        ]);
    });

    it("reports a changed custom-property block with both values", () => {
        const committed = createFixture();
        const captured: HostFixture = {
            ...committed,
            documentElement: {
                ...committed.documentElement,
                styleCssText: "--vscode-editor-background: #ffffff;",
            },
        };

        expect(compareHostFixtures(committed, captured)).toEqual([
            {
                field: "documentElement.styleCssText",
                committedValue: "--vscode-editor-background: #000000;",
                capturedValue: "--vscode-editor-background: #ffffff;",
            },
        ]);
    });

    it("reports a changed dataset value with both values", () => {
        const committed = createFixture();
        const captured: HostFixture = {
            ...committed,
            body: {
                ...committed.body,
                dataset: { vscodeThemeKind: "vscode-light" },
            },
        };

        expect(compareHostFixtures(committed, captured)).toEqual([
            {
                field: "body.dataset",
                committedValue: { vscodeThemeKind: "vscode-dark" },
                capturedValue: { vscodeThemeKind: "vscode-light" },
            },
        ]);
    });

    it("formats every field with bounded value excerpts", () => {
        const differences = [
            {
                field: "documentElement.styleCssText",
                committedValue: "x".repeat(1_000),
                capturedValue: "y".repeat(1_000),
            },
            {
                field: "provenance.platform",
                committedValue: "linux-x64",
                capturedValue: "darwin-arm64",
            },
        ] as const;

        const formatted = formatHostFixtureDifferences(differences, 32);
        const lines = formatted.split("\n");

        expect(formatted).toContain("documentElement.styleCssText");
        expect(formatted).toContain("provenance.platform");
        expect(formatted).toContain("…");
        expect(formatted).not.toContain("x".repeat(1_000));
        expect(formatted).not.toContain("y".repeat(1_000));
        for (const line of lines) {
            const values = line.split(": committed=")[1];
            const [committedExcerpt, capturedExcerpt] = values.split(", captured=");
            expect(committedExcerpt.length).toBeLessThanOrEqual(32);
            expect(capturedExcerpt.length).toBeLessThanOrEqual(32);
        }
    });

    it("does not report version or commit changes by themselves", () => {
        const committed = createFixture();
        const captured: HostFixture = {
            ...committed,
            provenance: {
                ...committed.provenance,
                vscodeVersion: "insiders-version",
                vscodeCommit: "insiders-commit",
            },
        };

        expect(compareHostFixtures(committed, captured)).toEqual([]);
    });

    it("reports a platform change as a same-environment guard", () => {
        const committed = createFixture();
        const captured: HostFixture = {
            ...committed,
            provenance: { ...committed.provenance, platform: "darwin-arm64" },
        };

        expect(compareHostFixtures(committed, captured)).toEqual([
            {
                field: "provenance.platform",
                committedValue: "linux-x64",
                capturedValue: "darwin-arm64",
            },
        ]);
    });

    it("reports every upstream-observable identity provenance field", () => {
        const committed = createFixture();
        const captured: HostFixture = {
            ...committed,
            provenance: {
                ...committed.provenance,
                themeId: "renamed-theme-id",
                themeName: "Renamed theme",
                requestedTheme: "Renamed theme",
                themeKind: "vscode-light",
            },
        };

        expect(compareHostFixtures(committed, captured)).toEqual([
            {
                field: "provenance.themeId",
                committedValue: "dark-modern",
                capturedValue: "renamed-theme-id",
            },
            {
                field: "provenance.themeName",
                committedValue: "Dark Modern",
                capturedValue: "Renamed theme",
            },
            {
                field: "provenance.requestedTheme",
                committedValue: "Dark Modern",
                capturedValue: "Renamed theme",
            },
            {
                field: "provenance.themeKind",
                committedValue: "vscode-dark",
                capturedValue: "vscode-light",
            },
        ]);
    });

    it("returns a dedicated schema-version difference without comparing incompatible payloads", () => {
        const committed = createFixture();
        const captured: HostFixture = {
            ...committed,
            provenance: { ...committed.provenance, captureSchemaVersion: 3 },
            body: { ...committed.body, classList: ["incompatible-shape"] },
        };

        expect(compareHostFixtures(committed, captured)).toEqual([
            {
                field: "provenance.captureSchemaVersion",
                committedValue: 2,
                capturedValue: 3,
            },
        ]);
    });
});

// The inventory is only a CLAIM until something executes it. A field can sit in `compared` while
// the comparator never looks at it -- the two-way ratchet above still passes, because the inventory
// matches the fixture on disk, and the field silently stops being an early warning. Each case here
// mutates exactly one declared field and demands the verdict the inventory promises.
describe("the field inventory is executable, not decorative", () => {
    const PAYLOAD_SECTIONS = ["provenance", "documentElement", "body"] as const;

    for (const section of PAYLOAD_SECTIONS) {
        const comparedFields: readonly string[] = HOST_FIXTURE_FIELD_INVENTORY[section].compared;
        const excludedFields: readonly string[] = HOST_FIXTURE_FIELD_INVENTORY[section].excluded;

        it.each([...comparedFields])(`reports a change to ${section}.%s`, (field) => {
            const committed = createFixture();
            const captured = withMutatedField(committed, section, field);

            expect(compareHostFixtures(committed, captured).map((one) => one.field)).toContain(
                `${section}.${field}`,
            );
        });

        if (excludedFields.length > 0) {
            it.each([...excludedFields])(`ignores a change to ${section}.%s`, (field) => {
                const committed = createFixture();
                const captured = withMutatedField(committed, section, field);

                expect(compareHostFixtures(committed, captured)).toEqual([]);
            });
        }
    }
});
