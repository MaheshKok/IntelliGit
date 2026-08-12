import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createFixtureWorkspace, type FixtureWorkspace } from "./fixtures/repo/harness";
import { DIRTY_FIXTURE } from "./fixtures/repo/scenarios";
import { FIXTURE_REFS } from "./fixtures/repo/seed";
import { oracles, type OracleId } from "./oracles";
import type { EnvironmentVerdict } from "./visual/playwright/visualEnvironmentGuard";
import type { VisualEnvironment } from "./visual/oracles/visualEnvironment";

export interface OracleSelfTest {
    /** What defect this oracle exists to catch, in one line. */
    readonly detects: string;
    /** Input the oracle MUST flag. Returns the oracle's own output. */
    readonly knownBad: () => readonly unknown[] | Promise<readonly unknown[]>;
    /** Input the oracle MUST NOT flag. Returns the oracle's own output. */
    readonly knownGood: () => readonly unknown[] | Promise<readonly unknown[]>;
}

/** Builds a compact rectangle fixture for the geometry oracle. */
function box(
    left: number,
    top: number,
    right: number,
    bottom: number,
): {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
} {
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

/**
 * The globalStorage folder VS Code allocates for this extension, read from the manifest.
 *
 * `readDurableState` derives that folder from a hardcoded id, and its known-bad case passes an
 * explicit `globalStoragePath` because the shelf scenario stores elsewhere — so the default branch
 * has no other coverage, and pointing it at a directory that never existed keeps every assertion
 * green while the oracle observes nothing. The manifest is the independent authority here: deriving
 * the expectation the same way the oracle does would only mirror it.
 */
function manifestGlobalStorageFolder(): string {
    const manifest = JSON.parse(
        readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { readonly publisher: string; readonly name: string };
    return `${manifest.publisher}.${manifest.name}`.toLowerCase();
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
const durableState = oracles.get("durableState");
const localGit = oracles.get("localGit");
const origin = oracles.get("origin");

type SelfTestScenario = "clean" | "dirty" | "ahead-only" | "shelf-populated";

const selfTestWorkspacesRoot = mkdtempSync(join(tmpdir(), "intelligit-oracle-self-tests-"));
const selfTestWorkspaces = new Map<SelfTestScenario, Promise<FixtureWorkspace>>();

/** Reuses one real fixture workspace per scenario across the async oracle self-tests. */
function selfTestWorkspace(scenario: SelfTestScenario): Promise<FixtureWorkspace> {
    const cached = selfTestWorkspaces.get(scenario);
    if (cached !== undefined) return cached;

    const workspace = createFixtureWorkspace({ scenario, workspacesRoot: selfTestWorkspacesRoot });
    selfTestWorkspaces.set(scenario, workspace);
    return workspace;
}

/** Disposes every workspace allocated by the oracle self-tests and their shared root. */
export async function disposeSelfTestWorkspaces(): Promise<void> {
    await Promise.all(
        [...selfTestWorkspaces.values()].map(async (workspace) => (await workspace).dispose()),
    );
    selfTestWorkspaces.clear();
    rmSync(selfTestWorkspacesRoot, { recursive: true, force: true });
}

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
export const oracleSelfTests: Record<OracleId, OracleSelfTest> = {
    geometry: {
        detects:
            "non-truncatable horizontal and vertical clipping plus zero-area interactive targets",
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
        detects:
            "active opaque foreground/background pairs whose contrast ratio is below the floor",
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
        detects:
            "interpolated templates leaking into the vocabulary, or plural variants dropped from it",
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
            const catalog = {
                visible: "Visible",
                plural: { one: "One file", other: "Many files" },
            };
            const collected = catalogSources.collectCatalogStrings(catalog);
            const expected = ["Many files", "One file", "Visible"];
            return collected.length === expected.length &&
                expected.every((source, index) => collected[index] === source)
                ? []
                : [collected];
        },
    },
    findingsBaseline: {
        detects:
            "non-clean observed-versus-baseline finding diffs while preserving normalized key order",
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
        detects:
            "malformed baseline updates instead of silently dropping an unknown finding bucket",
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
    durableState: {
        detects:
            "durable extension state leaking into a fixture profile or file traversal going blind",
        knownBad: async () => {
            const workspace = await selfTestWorkspace("shelf-populated");
            if (workspace.shelfStorageRoot === undefined) return [];

            const nestedRoot = mkdtempSync(join(tmpdir(), "intelligit-oracle-list-files-"));
            const plantedFiles = [
                join(nestedRoot, "alpha.txt"),
                join(nestedRoot, "nested", "bravo.txt"),
                join(nestedRoot, "nested", "deeper", "charlie.txt"),
            ];
            try {
                mkdirSync(join(nestedRoot, "nested", "deeper"), { recursive: true });
                for (const filePath of plantedFiles) writeFileSync(filePath, "fixture\n");

                const snapshot = await durableState.readDurableState(workspace, {
                    globalStoragePath: workspace.shelfStorageRoot,
                });
                const listedFiles = await durableState.listFilesUnder(nestedRoot);
                const shelfFilesAreReal =
                    snapshot.shelfStoreFiles.length > 0 &&
                    snapshot.shelfStoreFiles.every((filePath) => {
                        try {
                            return statSync(filePath).isFile();
                        } catch {
                            return false;
                        }
                    });
                const listedFilesMatch =
                    listedFiles.length === plantedFiles.length &&
                    listedFiles.every(
                        (filePath, index) => filePath === [...plantedFiles].sort()[index],
                    );
                const defaulted = await durableState.readDurableState(workspace);
                const defaultPathIsProduction =
                    defaulted.globalStoragePath ===
                    join(workspace.profileDir, "User", "globalStorage", manifestGlobalStorageFolder());
                return shelfFilesAreReal && listedFilesMatch && defaultPathIsProduction
                    ? [snapshot.shelfStoreFiles, listedFiles, defaulted.globalStoragePath]
                    : [];
            } finally {
                rmSync(nestedRoot, { recursive: true, force: true });
            }
        },
        knownGood: async () => {
            const workspace = await selfTestWorkspace("clean");
            const snapshot = await durableState.readDurableState(workspace);
            const missingRoot = join(workspace.profileDir, "missing-list-files");
            const missingFiles = await durableState.listFilesUnder(missingRoot);
            const observations = [
                snapshot.shelfStoreFiles,
                snapshot.repoLockPresent,
                snapshot.takeoverPaths,
                missingFiles,
            ];
            return snapshot.shelfStoreFiles.length === 0 &&
                snapshot.repoLockPresent === false &&
                snapshot.takeoverPaths.length === 0 &&
                missingFiles.length === 0
                ? []
                : observations;
        },
    },
    localGit: {
        detects:
            "dirty-worktree status parsing, rename parsing, HEAD identity, and ancestry failures",
        knownBad: async () => {
            const workspace = await selfTestWorkspace("dirty");
            const status = await localGit.statusPorcelain(workspace);
            const observedPaths = status.flatMap(({ path, originalPath }) =>
                originalPath === undefined ? [path] : [path, originalPath],
            );
            const expectedPaths = [
                ...DIRTY_FIXTURE.visiblePaths,
                DIRTY_FIXTURE.renameFromPath,
            ].sort();
            const head = await localGit.headOid(workspace);
            const headRef = await localGit.refOid(workspace, "HEAD");
            const unrelated = await localGit.refOid(workspace, FIXTURE_REFS.conflicting);
            const renameEntries = localGit.parseStatusPorcelain(
                `R  ${DIRTY_FIXTURE.renamePath}\0${DIRTY_FIXTURE.renameFromPath}\0`,
            );
            const statusMatchesFixture =
                status.length > 0 &&
                observedPaths.length === expectedPaths.length &&
                observedPaths
                    .slice()
                    .sort()
                    .every((path, index) => path === expectedPaths[index]);
            const nestedProbeRoot = mkdtempSync(
                join(tmpdir(), "intelligit-oracle-untracked-probe-"),
            );
            const untrackedFile = join(workspace.root, DIRTY_FIXTURE.untrackedPath);
            const untrackedBackup = join(nestedProbeRoot, DIRTY_FIXTURE.untrackedPath);
            const nestedUntrackedPath = join(DIRTY_FIXTURE.untrackedPath, DIRTY_FIXTURE.crlfPath);
            let nestedStatus = localGit.parseStatusPorcelain("");
            try {
                renameSync(untrackedFile, untrackedBackup);
                mkdirSync(untrackedFile);
                writeFileSync(
                    join(untrackedFile, DIRTY_FIXTURE.crlfPath),
                    "nested untracked content\n",
                );
                nestedStatus = await localGit.statusPorcelain(workspace);
            } finally {
                rmSync(untrackedFile, { recursive: true, force: true });
                renameSync(untrackedBackup, untrackedFile);
                rmSync(nestedProbeRoot, { recursive: true, force: true });
            }
            const nestedStatusReportsFile = nestedStatus.some(
                ({ path }) => path === nestedUntrackedPath,
            );
            const renameParsed =
                renameEntries.length === 1 &&
                renameEntries[0]?.path === DIRTY_FIXTURE.renamePath &&
                renameEntries[0]?.originalPath === DIRTY_FIXTURE.renameFromPath;
            const ancestryMatches =
                (await localGit.isAncestor(workspace, head, head)) &&
                !(await localGit.isAncestor(workspace, unrelated, head));
            return statusMatchesFixture &&
                head === headRef &&
                ancestryMatches &&
                nestedStatusReportsFile &&
                renameParsed
                ? [status, nestedStatus, head, headRef, renameEntries]
                : [];
        },
        knownGood: async () => {
            const workspace = await selfTestWorkspace("clean");
            const status = await localGit.statusPorcelain(workspace);
            const emptyParse = localGit.parseStatusPorcelain("");
            return status.length === 0 && emptyParse.length === 0 ? [] : [status, emptyParse];
        },
    },
    origin: {
        detects: "origin ref movement and ahead-only divergence being read from the bare origin",
        knownBad: async () => {
            const workspace = await selfTestWorkspace("ahead-only");
            const mainRef = `refs/heads/${FIXTURE_REFS.main}`;
            const originOid = await origin.refOid(workspace, mainRef);
            const localOid = await localGit.headOid(workspace);
            const counts = await localGit.aheadBehindCounts(workspace);
            // "Differs from local HEAD" is satisfied by ANY unrelated repository, so an oracle that
            // dropped `-C originRoot` and read the ambient working directory would still pass.
            // In `ahead-only` the origin tip is exactly `ahead` commits behind HEAD, so pin it there.
            const expectedOriginOid = await localGit.refOid(workspace, `HEAD~${counts.ahead}`);
            return originOid !== localOid &&
                originOid === expectedOriginOid &&
                origin.didRefMove(originOid, localOid) &&
                counts.behind === 0 &&
                counts.ahead > 0
                ? [originOid, localOid, counts]
                : [];
        },
        knownGood: async () => {
            const workspace = await selfTestWorkspace("clean");
            const oid = await origin.refOid(workspace, `refs/heads/${FIXTURE_REFS.main}`);
            return origin.didRefMove(oid, oid) ? [oid] : [];
        },
    },
};
