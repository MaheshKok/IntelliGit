import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
    compareHostFixtureStaleness,
    HOST_FIXTURE_FIELD_INVENTORY,
} from "../../e2e/hostFixtures/hostFixtureComparator";
import { hostFixtureFilePath, serializeHostFixture } from "../../e2e/hostFixtures/hostFixtureFile";
import type { HostFixture } from "../../e2e/hostFixtures/types";

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

const PAYLOAD_SECTIONS = ["provenance", "documentElement", "body"] as const;

/**
 * Every leaf field the staleness inventory claims to compare, flattened to `section`/`key` pairs.
 *
 * The ratchet above pins the inventory against the on-disk artifact, but that pairing alone leaves
 * the COMPARISON free to drift: deleting a `recordDifference` call keeps the inventory and the file
 * in perfect agreement while the named difference silently disappears. Driving a case off the
 * inventory is what turns it from a claim into something executed.
 */
const INVENTORIED_LEAF_FIELDS = PAYLOAD_SECTIONS.flatMap((section) =>
    HOST_FIXTURE_FIELD_INVENTORY[section].staleness.compared.map((key) => ({ section, key })),
);

function asRecord(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
}

/** Produces a value guaranteed to differ from `value`, whatever shape the field holds on disk. */
function divergentValue(value: unknown): unknown {
    if (typeof value === "number") return value + 1;
    if (typeof value === "string") return `${value}-diverged`;
    if (Array.isArray(value)) return [...(value as readonly string[]), "diverged"];
    return { ...asRecord(value), diverged: "diverged" };
}

function withProvenanceValue(
    fixture: HostFixture,
    field: "vscodeVersion" | "vscodeCommit",
    value: string,
): HostFixture {
    return {
        ...fixture,
        provenance: { ...fixture.provenance, [field]: value },
    };
}

function readStalenessInventory(section: InventorySection): {
    readonly actualKeys: readonly string[];
    readonly inventory: readonly string[];
} {
    const repoRoot = resolve(__dirname, "../../..");
    const committedFixture = JSON.parse(
        readFileSync(hostFixtureFilePath(repoRoot, "dark-modern"), "utf8"),
    ) as HostFixture;
    const { compared, excluded } = HOST_FIXTURE_FIELD_INVENTORY[section].staleness;
    const actualKeys =
        section === "topLevel"
            ? Object.keys(committedFixture)
            : Object.keys(asRecord(committedFixture[section]));

    return { actualKeys, inventory: [...compared, ...excluded] };
}

describe("compareHostFixtureStaleness", () => {
    it("accepts the committed dark-modern CSS content", () => {
        const repoRoot = resolve(__dirname, "../../..");
        const committedBytes = readFileSync(hostFixtureFilePath(repoRoot, "dark-modern"), "utf8");
        const committedFixture = JSON.parse(committedBytes) as HostFixture;
        // `String.prototype.replace` returns its input unchanged when the pattern does not match, so
        // the day the artifact stops carrying this token the "mutation" becomes a copy, the captured
        // fixture becomes byte-identical to the committed one, and `toEqual([])` below passes while
        // proving nothing about the 46KB CSS payload. The anchor is asserted before it is mutated.
        expect(
            /--vscode-editor-background: [^;]+/.test(committedFixture.documentElement.styleCssText),
            "the committed artifact must still carry the anchor token this proof mutates",
        ).toBe(true);
        const capturedFixture: HostFixture = {
            ...committedFixture,
            documentElement: {
                ...committedFixture.documentElement,
                // This stable token is the independent expected value for the mutation proof; the
                // surrounding 46KB CSS string still comes from the real committed artifact.
                styleCssText: committedFixture.documentElement.styleCssText.replace(
                    /--vscode-editor-background: [^;]+/,
                    "--vscode-editor-background: #1f1f1f",
                ),
            },
        };

        expect(
            compareHostFixtureStaleness(committedBytes, capturedFixture),
            "documentElement.styleCssText must match the pinned captured content",
        ).toEqual([]);
    });

    it("returns no differences for byte-identical serialized input", () => {
        const fixture = createFixture();

        expect(
            compareHostFixtureStaleness(serializeHostFixture(fixture), fixture),
            "byte-identical fixture input must be accepted",
        ).toEqual([]);
    });

    it.each(["vscodeVersion", "vscodeCommit"] as const)(
        "reports known-bad A when provenance.%s differs",
        (field) => {
            const committed = createFixture();
            const captured = withProvenanceValue(committed, field, `different-${field}`);
            const differences = compareHostFixtureStaleness(
                serializeHostFixture(committed),
                captured,
            );

            expect(
                differences.map((difference) => difference.field),
                `known-bad A must report provenance.${field}`,
            ).toContain(`provenance.${field}`);
        },
    );

    it("reports known-bad B content changes with valid provenance", () => {
        const committed = createFixture();
        const captured: HostFixture = {
            ...committed,
            documentElement: {
                ...committed.documentElement,
                styleCssText: "--vscode-editor-background: #ffffff;",
            },
            body: {
                ...committed.body,
                classList: ["vscode-dark", "upstream-change"],
            },
        };
        const differences = compareHostFixtureStaleness(serializeHostFixture(committed), captured);

        expect(
            differences.map((difference) => difference.field),
            "known-bad B must report both altered content fields",
        ).toEqual(expect.arrayContaining(["documentElement.styleCssText", "body.classList"]));
        expect(captured.provenance).toEqual(committed.provenance);
    });

    it("reports a serialization-only difference after fields compare equal", () => {
        const fixture = createFixture();
        const committedBytes = `${JSON.stringify(JSON.parse(serializeHostFixture(fixture)), null, 2)}\n`;
        const differences = compareHostFixtureStaleness(committedBytes, fixture);

        expect(
            differences.map((difference) => difference.field),
            "serialization drift must be a named difference",
        ).toEqual(["serializedBytes"]);
    });

    it.each(INVENTORIED_LEAF_FIELDS)(
        "names a difference for the inventoried field $section.$key",
        ({ section, key }) => {
            const committed = createFixture();
            const committedSection = asRecord(committed[section]);
            const captured = {
                ...committed,
                [section]: {
                    ...committedSection,
                    [key]: divergentValue(committedSection[key]),
                },
            } as HostFixture;

            expect(
                compareHostFixtureStaleness(serializeHostFixture(committed), captured).map(
                    (difference) => difference.field,
                ),
                `the inventory claims ${section}.${key} is compared, so a change to it must be named`,
            ).toContain(`${section}.${key}`);
        },
    );

    it.each(INVENTORY_SECTIONS)(
        "keeps every on-disk %s key in the staleness inventory",
        (section: InventorySection) => {
            const { actualKeys, inventory } = readStalenessInventory(section);

            expect(new Set(actualKeys), `${section} on-disk keys must all be inventoried`).toEqual(
                new Set(inventory),
            );
        },
    );

    it.each(INVENTORY_SECTIONS)(
        "keeps every staleness inventory %s key present on disk",
        (section: InventorySection) => {
            const { actualKeys, inventory } = readStalenessInventory(section);

            expect(
                new Set(inventory),
                `${section} inventory must contain only on-disk keys`,
            ).toEqual(new Set(actualKeys));
        },
    );
});
