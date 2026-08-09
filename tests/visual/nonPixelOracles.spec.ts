import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { findAccessibleNameViolations } from "./oracles/accessibleName";
import { findContrastViolations } from "./oracles/contrast";
import {
    contrastKey,
    describeDiff,
    diffFindings,
    isClean,
    normalizeFindingKeys,
} from "./oracles/findingsBaseline";
import { findClippingLosses, findZeroSizeTargets } from "./oracles/geometry";
import { WEBVIEW_HOST_CONTEXTS } from "./harness/hostContexts";
import { collectOracleInputs } from "./playwright/collectOracleInputs";
import { expect, test } from "./playwright/harnessPage";

const HOST_CONTEXT_IDS = WEBVIEW_HOST_CONTEXTS.map((context) => context.contextId);
const HOST_CONTEXT_FIXTURES = {
    "commit-graph-card": "clean.json",
    "commit-graph-compact": "clean.json",
    "commit-panel": "dirty.json",
    "commit-info": "clean.json",
    undocked: "mid-rebase.json",
    "merge-editor": "conflicted.json",
    "shelf-conflict-editor": "shelf-conflicted.json",
    "merge-conflict-session": "conflicted.json",
} as const;

const BASELINE_PATH = resolve(__dirname, "fixtures/knownFindings.json");
const UPDATE_ENV_VAR = "UPDATE_VISUAL_BASELINE";

/**
 * The only platform allowed to rewrite the baseline.
 *
 * Not a preference. Regenerating this file on darwin-arm64 and on linux-x64 produces
 * byte-identical output for every finding but one: an `undocked` span inside a label at
 * the 320px viewport clips on darwin and fits on linux, in all four themes. A baseline
 * written on a developer machine is therefore red in CI, and it fails naming an element
 * rather than the platform. CI's platform is the one that gates releases, so CI's wins.
 */
const BASELINE_PLATFORM = "linux-x64";

type Bucket = "clipping" | "contrast" | "accessibleNames" | "zeroSize";
type ContextBaseline = Partial<Record<Bucket, readonly string[]>>;
type Baseline = Record<string, Record<string, ContextBaseline>>;

const BUCKETS: readonly Bucket[] = ["clipping", "contrast", "accessibleNames", "zeroSize"];

function readBaseline(): Baseline {
    try {
        return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    } catch {
        return {};
    }
}

/**
 * Read-modify-write against one shared file. Safe only because update mode refuses to run
 * with more than one worker (see the guard in the test body) -- with parallel workers the
 * last writer would silently drop every other project's slice, producing a baseline that
 * looks complete and quietly accepts real regressions.
 */
function writeBaselineSlice(project: string, contextId: string, slice: ContextBaseline): void {
    const baseline = readBaseline();
    baseline[project] = { ...(baseline[project] ?? {}), [contextId]: slice };
    const ordered: Baseline = {};
    for (const projectName of Object.keys(baseline).sort()) {
        const contexts = baseline[projectName];
        ordered[projectName] = {};
        for (const key of Object.keys(contexts).sort()) {
            ordered[projectName][key] = contexts[key];
        }
    }
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify(ordered, null, 4)}\n`, "utf8");
}

test.describe("live-page non-pixel oracles", () => {
    for (const contextId of HOST_CONTEXT_IDS) {
        test(`${contextId} matches the known-findings baseline`, async ({
            mountHarness,
            page,
        }, testInfo) => {
            await mountHarness(contextId, {
                webviewFixture: HOST_CONTEXT_FIXTURES[contextId],
            });
            const inputs = await collectOracleInputs(page);

            const observed: Record<Bucket, readonly string[]> = {
                clipping: normalizeFindingKeys(
                    inputs.clipping
                        .filter(({ input }) => findClippingLosses(input).length > 0)
                        .map(({ id }) => id),
                ),
                contrast: normalizeFindingKeys(
                    findContrastViolations(inputs.contrast, 4.5).map((finding) =>
                        contrastKey(finding.id, finding.ratio),
                    ),
                ),
                accessibleNames: normalizeFindingKeys(
                    findAccessibleNameViolations(inputs.accessibleNames).map(
                        (finding) => `${finding.id} [${finding.kind}]`,
                    ),
                ),
                zeroSize: normalizeFindingKeys(findZeroSizeTargets(inputs.interactiveTargets)),
            };

            const project = testInfo.project.name;

            if (process.env[UPDATE_ENV_VAR] === "1") {
                // Checked before the worker count because it is the mistake that costs the
                // most: a full regeneration completes, looks clean, and only turns red in CI.
                expect(
                    `${process.platform}-${process.arch}`,
                    `${UPDATE_ENV_VAR}=1 may only write the baseline on ${BASELINE_PLATFORM}. ` +
                        `Regenerate through the pinned container instead:\n` +
                        `  ./tests/e2e/docker/run.sh 'bun install --frozen-lockfile && ` +
                        `bun run build && ${UPDATE_ENV_VAR}=1 npx playwright test ` +
                        `--config playwright.visual.config.ts --workers=1'`,
                ).toBe(BASELINE_PLATFORM);

                // A parallel regeneration silently loses slices; fail loudly instead.
                expect(
                    testInfo.config.workers,
                    `${UPDATE_ENV_VAR}=1 rewrites one shared file and must run single-threaded. ` +
                        `Re-run with: ${UPDATE_ENV_VAR}=1 npx playwright test ` +
                        `--config playwright.visual.config.ts --workers=1`,
                ).toBe(1);
                writeBaselineSlice(project, contextId, observed);
                return;
            }

            const baseline = readBaseline()[project]?.[contextId] ?? {};
            for (const bucket of BUCKETS) {
                const diff = diffFindings(observed[bucket], baseline[bucket] ?? []);
                expect
                    .soft(isClean(diff), describeDiff(`[${project}] ${contextId} ${bucket}`, diff))
                    .toBe(true);
            }
        });
    }
});
