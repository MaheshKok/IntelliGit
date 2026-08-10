import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Browser } from "@playwright/test";

import {
    BASELINE_ENVIRONMENT_FILE,
    VISUAL_ENVIRONMENT_SCALAR_FIELDS,
    describeEnvironmentDrift,
    diffEnvironment,
    normalizeEnvironment,
    type VisualEnvironment,
} from "../oracles/visualEnvironment";
import { BASELINE_PLATFORM, UPDATE_ENV_VAR, baselineFile } from "../oracles/findingsBaselineFile";
import { assertPinnedProvenance, readPinnedBaseImage } from "../oracles/pinnedBaseImage";
import { captureVisualEnvironment } from "./captureVisualEnvironment";

const ENVIRONMENT_PATH = resolve(__dirname, "../../..", BASELINE_ENVIRONMENT_FILE);
const PIN_PATH = resolve(__dirname, "../../..", "tests/e2e/docker/base-image.txt");
const CURRENT_PLATFORM = `${process.platform}-${process.arch}`;
const EMPTY_BUCKETS = [] as const;

/** The worker-captured environment state exposed to the later pixel-assertion package. */
export type EnvironmentVerdict =
    | { readonly kind: "match" }
    | { readonly kind: "no-baseline" }
    | { readonly kind: "unreadable"; readonly message: string }
    | { readonly kind: "drift"; readonly message: string };

type CommittedEnvironment =
    | { readonly kind: "absent" }
    | { readonly kind: "unreadable"; readonly reason: string }
    | { readonly kind: "environment"; readonly value: VisualEnvironment };

type EnvironmentRunInputs = {
    readonly updateRequested: boolean;
    readonly platform: string;
    readonly workerCount: number;
    readonly baseImage: string | undefined;
    readonly pinnedBaseImage: string;
    readonly inContainer: boolean;
};

type EnvironmentRunMode = "update" | "compare";
type ContainmentProbe = () => boolean;
type EnvironmentCapture = (browser: Browser) => Promise<VisualEnvironment>;

let cachedVerdict: EnvironmentVerdict | undefined;
let preparation: Promise<void> | undefined;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/**
 * Narrows a parsed JSON object to `VisualEnvironment` by checking every field the canonical table
 * declares. Written as an assertion signature rather than an `as` cast on the return value: the
 * cast form claimed the type without being tied to these checks, so it stayed "valid" no matter
 * what the checks did or did not cover.
 */
function assertVisualEnvironmentShape(
    candidate: Record<string, unknown>,
): asserts candidate is Record<string, unknown> & VisualEnvironment {
    for (const field of VISUAL_ENVIRONMENT_SCALAR_FIELDS) {
        if (typeof candidate[field] !== "string") {
            throw new Error(`visual environment artifact field \"${field}\" must be a string.`);
        }
    }
    if (!Array.isArray(candidate.fonts)) {
        throw new Error('visual environment artifact field "fonts" must be an array.');
    }
    const invalidFontIndex = candidate.fonts.findIndex((font) => typeof font !== "string");
    if (invalidFontIndex !== -1) {
        throw new Error(
            `visual environment artifact field "fonts" contains a non-string value at index ${invalidFontIndex}.`,
        );
    }

}

function parseVisualEnvironment(value: unknown): VisualEnvironment {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("visual environment artifact must be an object.");
    }

    const candidate = value as Record<string, unknown>;
    assertVisualEnvironmentShape(candidate);
    return normalizeEnvironment(candidate);
}

/** Reads a committed environment while distinguishing absence from corruption. */
export function readCommittedEnvironment(environmentPath: string): CommittedEnvironment {
    let serialized: string;
    try {
        serialized = readFileSync(environmentPath, "utf8");
    } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return { kind: "absent" };
        return { kind: "unreadable", reason: `could not read file: ${errorMessage(error)}` };
    }

    let value: unknown;
    try {
        value = JSON.parse(serialized) as unknown;
    } catch (error) {
        return { kind: "unreadable", reason: `malformed JSON: ${errorMessage(error)}` };
    }

    try {
        return { kind: "environment", value: parseVisualEnvironment(value) };
    } catch (error) {
        return { kind: "unreadable", reason: `invalid visual environment: ${errorMessage(error)}` };
    }
}

function writeEnvironment(
    environmentPath: string,
    environment: VisualEnvironment,
    pinnedBaseImage: string,
): void {
    if (environment.fonts.length === 0) {
        throw new Error(
            "Visual environment write rejected: empty font manifest. Regenerate through ./tests/e2e/docker/run.sh.",
        );
    }
    if (environment.platform !== BASELINE_PLATFORM) {
        throw new Error(
            `Visual environment write rejected: platform ${environment.platform} is not ${BASELINE_PLATFORM}. ` +
                "Regenerate through ./tests/e2e/docker/run.sh.",
        );
    }
    if (environment.baseImage !== pinnedBaseImage) {
        throw new Error(
            "Visual environment write rejected: base image does not equal the pinned digest. " +
                "Regenerate through ./tests/e2e/docker/run.sh.",
        );
    }

    mkdirSync(dirname(environmentPath), { recursive: true });
    writeFileSync(environmentPath, `${JSON.stringify(environment, null, 4)}\n`, "utf8");
}

function assertUpdatePlatform(updateRequested: boolean, platform: string): void {
    if (!updateRequested || platform === BASELINE_PLATFORM) return;
    throw new Error(
        `${UPDATE_ENV_VAR}=1 may only write the baseline on ${BASELINE_PLATFORM}. ` +
            "Regenerate through the pinned container instead:\n" +
            "  ./tests/e2e/docker/run.sh 'bun install --frozen-lockfile && " +
            `bun run build && ${UPDATE_ENV_VAR}=1 npx playwright test ` +
            "--config playwright.visual.config.ts --workers=1'",
    );
}

function assertSingleWorker(updateRequested: boolean, workerCount: number): void {
    if (!updateRequested || workerCount === 1) return;
    throw new Error(
        `${UPDATE_ENV_VAR}=1 rewrites one shared file and must run single-threaded. ` +
            `Re-run with: ${UPDATE_ENV_VAR}=1 npx playwright test ` +
            "--config playwright.visual.config.ts --workers=1",
    );
}

/** Couples every update guard to the mode used by visual-environment preparation. */
export function planEnvironmentRun(inputs: EnvironmentRunInputs): EnvironmentRunMode {
    if (!inputs.updateRequested) return "compare";

    assertUpdatePlatform(inputs.updateRequested, inputs.platform);
    assertSingleWorker(inputs.updateRequested, inputs.workerCount);
    assertUpdateEnvironment(
        inputs.updateRequested,
        inputs.baseImage,
        inputs.pinnedBaseImage,
        inputs.inContainer,
    );
    return "update";
}

/** Enforces the pinned-container requirement for visual baseline updates. */
export function assertUpdateEnvironment(
    updateRequested: boolean,
    baseImage: string | undefined,
    pinnedBaseImage: string,
    inContainer: boolean,
): void {
    if (!updateRequested) return;
    assertPinnedProvenance(baseImage, pinnedBaseImage, inContainer);
}

/** Converts a committed and observed environment pair into the guard verdict. */
export function decideEnvironmentVerdict(
    committed: CommittedEnvironment,
    observed: VisualEnvironment,
): EnvironmentVerdict {
    if (committed.kind === "absent") return { kind: "no-baseline" };
    if (committed.kind === "unreadable") {
        return {
            kind: "unreadable",
            message: `Committed visual environment is unreadable: ${committed.reason}`,
        };
    }

    const differences = diffEnvironment(committed.value, observed);
    return differences.length === 0
        ? { kind: "match" }
        : { kind: "drift", message: describeEnvironmentDrift(differences) };
}

/**
 * Docker creates this marker inside every container. It is the only one of the three
 * provenance checks an environment variable cannot forge, so its default must stay testable.
 */
export const CONTAINMENT_MARKER = "/.dockerenv";

/** Probes Docker containment by marker file; the path is seamed so the default is provable. */
export function probeContainment(markerPath: string = CONTAINMENT_MARKER): boolean {
    return existsSync(markerPath);
}

function prepareEnvironment(
    browser: Browser,
    workerCount: number,
    environmentPath: string,
    pinPath: string,
    containmentProbe: ContainmentProbe,
    platform: string,
    capture: EnvironmentCapture,
): Promise<void> {
    const guards = baselineFile(environmentPath, EMPTY_BUCKETS);
    const updateRequested = guards.isUpdateRequested();
    const pinnedBaseImage = readPinnedBaseImage(pinPath);
    const mode = planEnvironmentRun({
        updateRequested,
        platform,
        workerCount,
        baseImage: process.env.INTELLIGIT_BASE_IMAGE,
        pinnedBaseImage,
        inContainer: containmentProbe(),
    });

    return capture(browser).then((captured) => {
        const observed = normalizeEnvironment(captured);
        if (mode === "update") {
            writeEnvironment(environmentPath, observed, pinnedBaseImage);
            cachedVerdict = { kind: "match" };
            return;
        }

        cachedVerdict = decideEnvironmentVerdict(
            readCommittedEnvironment(environmentPath),
            observed,
        );
    });
}

/** Captures and evaluates the environment once for the current Playwright worker. */
export async function prepareVisualEnvironment(
    browser: Browser,
    workerCount: number,
    environmentPath = ENVIRONMENT_PATH,
    pinPath = PIN_PATH,
    containmentProbe: ContainmentProbe = probeContainment,
    platform = CURRENT_PLATFORM,
    capture: EnvironmentCapture = captureVisualEnvironment,
): Promise<void> {
    if (cachedVerdict !== undefined) return;
    preparation ??= prepareEnvironment(
        browser,
        workerCount,
        environmentPath,
        pinPath,
        containmentProbe,
        platform,
        capture,
    );
    try {
        await preparation;
    } catch (error) {
        preparation = undefined;
        throw error;
    }
}

/** Clears the memoized guard state so isolated tests can exercise a fresh preparation. */
export function resetVisualEnvironmentGuardForTest(): void {
    cachedVerdict = undefined;
    preparation = undefined;
}

/** Returns the memoized worker verdict for step 20-b's pixel assertions. */
export function environmentVerdict(): EnvironmentVerdict {
    if (cachedVerdict === undefined) {
        throw new Error("Visual environment verdict requested before worker capture completed.");
    }
    return cachedVerdict;
}
