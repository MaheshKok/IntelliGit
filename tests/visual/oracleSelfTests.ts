import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { oracles, type OracleId } from "../oracles";
import type { EnvironmentVerdict } from "./playwright/visualEnvironmentGuard";
import type { VisualEnvironment } from "./oracles/visualEnvironment";

/** The visual oracle ids; e2e workspace oracles have their own real-workspace proof. */
export type VisualOracleId = Exclude<OracleId, "durableState" | "localGit" | "origin">;

export interface OracleSelfTest {
    /** What defect this oracle exists to catch, in one line. */
    readonly detects: string;
    /** Input the oracle MUST flag. Returns the oracle's own output. */
    readonly knownBad: () => readonly unknown[];
    /** Input the oracle MUST NOT flag. Returns the oracle's own output. */
    readonly knownGood: () => readonly unknown[];
}

/** Builds a compact rectangle fixture for the geometry oracle. */
function box(
    left: number,
    top: number,
    right: number,
    bottom: number,
): { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } {
    return { left, top, right, bottom };
}

/** Keeps a multi-part known-bad case red when any required sub-oracle goes blind. */
function allRequired(...outputs: readonly (readonly unknown[])[]): readonly unknown[] {
    return outputs.every((output) => output.length > 0) ? outputs.flat() : [];
}

/** Adapts an optional oracle match to the self-test finding-array contract. */
function asFinding(output: unknown): readonly unknown[] {
    return output === undefined ? [] : [output];
}

/** Allocates a disposable nested baseline path without touching a repository fixture. */
function temporaryBaselinePath(): { readonly directory: string; readonly filePath: string } {
    const directory = mkdtempSync(join(tmpdir(), "intelligit-oracle-self-test-"));
    return { directory, filePath: join(directory, "nested", "findings.json") };
}

const geometry = oracles.get("geometry");
const contrast = oracles.get("contrast");
const truncationSources = oracles.get("truncationSources");
const catalogSources = oracles.get("catalogSources");
const findingsBaseline = oracles.get("findingsBaseline");
const findingsBaselineFile = oracles.get("findingsBaselineFile");
const pinnedBaseImage = oracles.get("pinnedBaseImage");
const pixelAssertionPlan = oracles.get("pixelAssertionPlan");
const visualEnvironment = oracles.get("visualEnvironment");

const baseEnvironment: VisualEnvironment = {
    baseImage: "mcr.microsoft.com/playwright@sha256:abc123",
    browserVersion: "139.0.7258.5",
    platform: "linux-x64",
    osRelease: "6.12.0",
    fonts: ["Arial", "Noto Sans"],
};

const changedEnvironmentValues: { [Field in keyof VisualEnvironment]: VisualEnvironment[Field] } = {
    baseImage: "mcr.microsoft.com/playwright@sha256:def456",
    browserVersion: "140.0.7339.1",
    platform: "darwin-arm64",
    osRelease: "24.6.0",
    fonts: ["Changed Font", "Noto Sans"],
};

/** Produces one environment drift while leaving the committed fixture unchanged. */
function environmentWithChange(field: keyof VisualEnvironment): VisualEnvironment {
    const observed = { ...baseEnvironment } as {
        -readonly [Field in keyof VisualEnvironment]: VisualEnvironment[Field];
    };
    Object.assign(observed, { [field]: changedEnvironmentValues[field] });
    return observed;
}

const validDigest = `repo@sha256:${"a".repeat(64)}`;
const provenanceReason = "Host renderer is not the reviewed container image.";

/**
 * Every callback below resolves its production implementation from `oracles`; no oracle module
 * is called directly. For data-returning oracles, a non-empty returned finding/result is flagged;
 * for verdicts, a disallowed branch is flagged; and expected exceptions are returned as findings.
 */
export const oracleSelfTests: Record<VisualOracleId, OracleSelfTest> = {
    geometry: {
        detects: "non-truncatable horizontal and vertical clipping plus zero-area interactive targets",
        knownBad: () => {
            const horizontal = geometry.findClippingLosses({
                textRects: [box(0, 0, 100, 20)],
                clipBoxes: [box(0, 0, 99.4, 20)],
                viewport: box(0, 0, 120, 120),
            });
            const vertical = geometry.findClippingLosses({
                textRects: [box(0, 0, 20, 100)],
                clipBoxes: [box(0, 0, 20, 99.4)],
                viewport: box(0, 0, 120, 120),
            });
            const zeroSize = geometry.findZeroSizeTargets([
                { id: "zero-area-button", box: box(10, 10, 10, 10) },
            ]);
            return allRequired(horizontal, vertical, zeroSize);
        },
        knownGood: () => {
            const horizontal = geometry.findClippingLosses({
                textRects: [box(0, 0, 100, 20)],
                clipBoxes: [box(0, 0, 99.6, 20)],
                viewport: box(0, 0, 120, 120),
            });
            const vertical = geometry.findClippingLosses({
                textRects: [box(0, 0, 20, 100)],
                clipBoxes: [box(0, 0, 20, 99.6)],
                viewport: box(0, 0, 120, 120),
            });
            const zeroSize = geometry.findZeroSizeTargets([
                { id: "healthy-button", box: box(10, 10, 10.6, 10.6) },
            ]);
            return [...horizontal, ...vertical, ...zeroSize];
        },
    },
    contrast: {
        detects: "active opaque foreground/background pairs whose contrast ratio is below the floor",
        knownBad: () =>
            contrast.findContrastViolations(
                [
                    {
                        id: "opaque-muted-label",
                        inactive: false,
                        foreground: { r: 120, g: 120, b: 120, a: 1 },
                        backgroundLayers: [{ r: 120, g: 120, b: 120, a: 1 }],
                    },
                ],
                4.5,
            ),
        knownGood: () =>
            contrast.findContrastViolations(
                [
                    {
                        id: "opaque-readable-label",
                        inactive: false,
                        foreground: { r: 0, g: 0, b: 0, a: 1 },
                        backgroundLayers: [{ r: 255, g: 255, b: 255, a: 1 }],
                    },
                ],
                4.5,
            ),
    },
    truncationSources: {
        detects: "rendered text abbreviated with an ellipsis when it diverges from a source string",
        knownBad: () =>
            asFinding(
                truncationSources.matchTruncatedRendering("Fix parser…", ["Fix parser regression"]),
            ),
        knownGood: () =>
            asFinding(
                truncationSources.matchTruncatedRendering("Merge...", [
                    "Merge…",
                    "Merge...",
                    "Resolve conflict",
                ]),
            ),
    },
    catalogSources: {
        detects: "interpolated templates leaking into the vocabulary, or plural variants dropped from it",
        knownBad: () => {
            // `collectCatalogStrings` is a source collector, so its finding IS its vocabulary. The
            // catalog below straddles both contract clauses at once: the two `{placeholder}` values
            // must be dropped and the one concrete plural variant must survive flattening. Every way
            // the oracle can break -- exclusion removed, plurals no longer flattened, or the
            // collector going blind entirely -- produces something other than this exact vocabulary,
            // which empties the case and turns it red.
            const catalog = {
                head: "HEAD: {name}",
                staged: { one: "1 file staged", other: "{count} files staged" },
            };
            const collected = catalogSources.collectCatalogStrings(catalog);
            return collected.length === 1 && collected[0] === "1 file staged" ? collected : [];
        },
        knownGood: () => {
            const catalog = { visible: "Visible", plural: { one: "One file", other: "Many files" } };
            const collected = catalogSources.collectCatalogStrings(catalog);
            const expected = ["Many files", "One file", "Visible"];
            return collected.length === expected.length && expected.every((source, index) => collected[index] === source)
                ? []
                : [collected];
        },
    },
    findingsBaseline: {
        detects: "non-clean observed-versus-baseline finding diffs while preserving normalized key order",
        knownBad: () => {
            const observed = findingsBaseline.normalizeFindingKeys(["b", "a"]);
            const baseline = findingsBaseline.normalizeFindingKeys(["a"]);
            const diff = findingsBaseline.diffFindings(observed, baseline);
            return findingsBaseline.isClean(diff) ? [] : [diff];
        },
        knownGood: () => {
            const observed = findingsBaseline.normalizeFindingKeys(["b", "a", "b"]);
            const baseline = findingsBaseline.normalizeFindingKeys(["a", "b"]);
            const diff = findingsBaseline.diffFindings(observed, baseline);
            return findingsBaseline.isClean(diff) && observed.join("\u0000") === "a\u0000b"
                ? []
                : [diff, observed];
        },
    },
    findingsBaselineFile: {
        detects: "malformed baseline updates instead of silently dropping an unknown finding bucket",
        knownBad: () => {
            const { directory, filePath } = temporaryBaselinePath();
            try {
                const file = findingsBaselineFile.baselineFile(filePath, ["clipping"] as const);
                try {
                    file.writeSlice("project", "context", {
                        clipping: ["known"],
                        zeroSize: ["unexpected"],
                    } as Parameters<typeof file.writeSlice>[2]);
                    return [];
                } catch (error) {
                    return [error];
                }
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        },
        knownGood: () => {
            const { directory, filePath } = temporaryBaselinePath();
            try {
                const file = findingsBaselineFile.baselineFile(filePath, ["clipping"] as const);
                file.writeSlice("project", "context", { clipping: ["known"] });
                return JSON.stringify(file.read()) ===
                    JSON.stringify({ project: { context: { clipping: ["known"] } } })
                    ? []
                    : [file.read()];
            } catch (error) {
                return [error];
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        },
    },
    pinnedBaseImage: {
        detects: "base-image provenance whose digest identity does not match the committed pin",
        knownBad: () => {
            const result = pinnedBaseImage.checkPinnedProvenance(
                `repo@sha256:${"b".repeat(64)}`,
                validDigest,
                true,
            );
            return result.kind === "unpinned" ? [result] : [];
        },
        knownGood: () => {
            const result = pinnedBaseImage.checkPinnedProvenance(validDigest, validDigest, true);
            return result.kind === "pinned" ? [] : [result];
        },
    },
    pixelAssertionPlan: {
        detects: "unpinned renderer verdicts that must suppress pixel assertions",
        knownBad: () => {
            const plan = pixelAssertionPlan.planPixelAssertions({
                agreement: { kind: "match" },
                provenance: { kind: "unpinned", reason: provenanceReason },
            } satisfies EnvironmentVerdict);
            // For this oracle, "flagged" is the deliberate skip verdict: the bad input is an
            // untrusted renderer, so allowing pixels would be the defect.
            return plan.kind === "skip" ? [plan] : [];
        },
        knownGood: () => {
            const plan = pixelAssertionPlan.planPixelAssertions({
                agreement: { kind: "match" },
                provenance: { kind: "pinned" },
            } satisfies EnvironmentVerdict);
            return plan.kind === "run" ? [] : [plan];
        },
    },
    visualEnvironment: {
        detects: "drift in every inventoried renderer field that the table marks for comparison",
        knownBad: () => {
            const comparedFields = visualEnvironment.VISUAL_ENVIRONMENT_FIELDS.filter(
                ({ compared }) => compared,
            ).map(({ field }) => field);
            const differences = comparedFields.flatMap((field) =>
                visualEnvironment.diffEnvironment(baseEnvironment, environmentWithChange(field)),
            );
            const detectedFields = new Set(differences.map(({ field }) => field));
            return detectedFields.size === comparedFields.length &&
                comparedFields.every((field) => detectedFields.has(field))
                ? differences
                : [];
        },
        knownGood: () => visualEnvironment.diffEnvironment(baseEnvironment, baseEnvironment),
    },
};
