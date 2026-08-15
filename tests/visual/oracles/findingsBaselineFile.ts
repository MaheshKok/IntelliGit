import { dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * The only platform allowed to rewrite a baseline.
 *
 * Regenerating this file on darwin-arm64 and linux-x64 produces byte-identical output for every
 * finding but one: an `undocked` span inside a label at the 320px viewport clips on darwin and fits
 * on linux, across all four themes. A baseline written on a developer machine is therefore red in
 * CI and fails naming an element rather than the platform. CI's platform is the one that gates
 * releases, so CI's wins.
 */
export const BASELINE_PLATFORM = "linux-x64";
export const UPDATE_ENV_VAR = "UPDATE_VISUAL_BASELINE";

type BaselineSlice<TBucket extends string> = Partial<Record<TBucket, readonly string[]>>;
type BaselineData<TBucket extends string> = Record<string, Record<string, BaselineSlice<TBucket>>>;

export interface BaselineFile<TBucket extends string> {
    readonly read: () => BaselineData<TBucket>;
    readonly writeSlice: (
        project: string,
        contextId: string,
        slice: BaselineSlice<TBucket>,
    ) => void;
    readonly assertUpdatePlatform: () => void;
    readonly assertSingleWorker: (workerCount: number) => void;
    readonly isUpdateRequested: () => boolean;
}

/** Returns the stored findings, treating an absent or unparseable file as an empty baseline. */
function readBaseline<TBucket extends string>(absolutePath: string): BaselineData<TBucket> {
    try {
        return JSON.parse(readFileSync(absolutePath, "utf8")) as BaselineData<TBucket>;
    } catch {
        return {};
    }
}

function orderedSlice<TBucket extends string>(
    slice: BaselineSlice<TBucket>,
    buckets: readonly TBucket[],
): BaselineSlice<TBucket> {
    // `writeSlice` receives a variable rather than an object literal, so TypeScript's excess-property
    // check never fires here. A bucket added to the observed findings but not to the bucket list
    // would then be dropped from every write -- silently un-baselined, and therefore never able to
    // fail. Losing findings must be loud.
    const unknown = Object.keys(slice).filter((key) => !buckets.includes(key as TBucket));
    if (unknown.length > 0) {
        throw new Error(
            `findings baseline received unknown bucket(s): ${unknown.sort().join(", ")}. ` +
                `Known buckets: ${[...buckets].join(", ")}.`,
        );
    }

    const ordered: BaselineSlice<TBucket> = {};
    for (const bucket of buckets) {
        const findings = slice[bucket];
        if (findings !== undefined) ordered[bucket] = findings;
    }
    return ordered;
}

function writeBaselineSlice<TBucket extends string>(
    absolutePath: string,
    buckets: readonly TBucket[],
    project: string,
    contextId: string,
    slice: BaselineSlice<TBucket>,
): void {
    const baseline = readBaseline<TBucket>(absolutePath);
    baseline[project] = {
        ...(baseline[project] ?? {}),
        [contextId]: orderedSlice(slice, buckets),
    };
    const ordered: BaselineData<TBucket> = {};
    for (const projectName of Object.keys(baseline).sort()) {
        ordered[projectName] = {};
        for (const key of Object.keys(baseline[projectName]).sort()) {
            ordered[projectName][key] = baseline[projectName][key];
        }
    }
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, `${JSON.stringify(ordered, null, 4)}\n`, "utf8");
}

function isUpdateRequested(): boolean {
    return process.env[UPDATE_ENV_VAR] === "1";
}

function assertUpdatePlatform(): void {
    if (!isUpdateRequested()) return;
    const platform = `${process.platform}-${process.arch}`;
    if (platform === BASELINE_PLATFORM) return;
    throw new Error(
        `${UPDATE_ENV_VAR}=1 may only write the baseline on ${BASELINE_PLATFORM}. ` +
            "Regenerate through the pinned container instead:\n" +
            "  ./tests/e2e/docker/run.sh 'bun install --frozen-lockfile && " +
            `bun run build && ${UPDATE_ENV_VAR}=1 npx playwright test ` +
            "--config playwright.visual.config.ts --workers=1'",
    );
}

function assertSingleWorker(workerCount: number): void {
    if (!isUpdateRequested() || workerCount === 1) return;
    throw new Error(
        `${UPDATE_ENV_VAR}=1 rewrites one shared file and must run single-threaded. ` +
            `Re-run with: ${UPDATE_ENV_VAR}=1 npx playwright test ` +
            "--config playwright.visual.config.ts --workers=1",
    );
}

/**
 * Creates deterministic read-modify-write access to one visual findings baseline.
 *
 * Baseline updates are deliberately platform- and worker-bound: browser text metrics can differ
 * between host platforms, and concurrent writers can overwrite each other's slices. Keeping these
 * rules with file access prevents each visual spec from inventing a subtly different guard.
 */
export function baselineFile<TBucket extends string>(
    absolutePath: string,
    buckets: readonly TBucket[],
): BaselineFile<TBucket> {
    return {
        read: () => readBaseline<TBucket>(absolutePath),
        writeSlice: (project, contextId, slice) =>
            writeBaselineSlice(absolutePath, buckets, project, contextId, slice),
        assertUpdatePlatform,
        assertSingleWorker,
        isUpdateRequested,
    };
}
