// Runtime shape checks for persisted CI values. A value read back from storage is only a
// claim about its type: an older or foreign writer may have left any JSON there, and the
// completion rules read state fields negatively, so an unknown value would pass as settled.
// Each field map is typed against its interface and each allowed set against its union, so
// a type change these checks do not follow fails the typecheck.

import type {
    CiAttempt,
    CiAttemptHistory,
    CiCoverage,
    CiFlatCheck,
    CiJob,
    CiRun,
    CiState,
    CiStep,
    CommitCheckItem,
    CommitCheckState,
    CommitChecksSnapshot,
    CommitCiDetailData,
    ProviderId,
} from "../../types";

type Check = (value: unknown) => boolean;

const isString: Check = (value) => typeof value === "string";
const isNumber: Check = (value) => typeof value === "number";
const isBoolean: Check = (value) => typeof value === "boolean";

function oneOf<T extends string>(allowed: Record<T, true>): Check {
    return (value) => typeof value === "string" && Object.hasOwn(allowed, value);
}

function optional(check: Check): Check {
    return (value) => value === undefined || check(value);
}

function nullable(check: Check): Check {
    return (value) => value === null || check(value);
}

function listOf(check: Check): Check {
    return (value) => Array.isArray(value) && value.every(check);
}

/** Every field of `T`, optional ones included, must be named; extra stored keys are ignored. */
function shape<T>(fields: { [K in keyof T]-?: Check }): Check {
    return (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const record = value as Record<string, unknown>;
        return Object.entries<Check>(fields).every(([field, check]) => check(record[field]));
    };
}

const commitCheckState = oneOf<CommitCheckState>({
    success: true,
    failure: true,
    pending: true,
    skipped: true,
    neutral: true,
    cancelled: true,
    timed_out: true,
    action_required: true,
    unknown: true,
    none: true,
    unavailable: true,
});

const ciState = oneOf<CiState>({
    queued: true,
    running: true,
    success: true,
    failure: true,
    cancelled: true,
    skipped: true,
    neutral: true,
    unknown: true,
});

const partialCoverage = shape<Exclude<CiCoverage, "full">>({
    reason: oneOf<Exclude<CiCoverage, "full">["reason"]>({ pageBound: true, rejectedNext: true }),
    shown: isNumber,
});
const coverage: Check = (value) => value === "full" || partialCoverage(value);

const requiredFlag = optional(
    oneOf<NonNullable<CiJob["required"]>>({ yes: true, no: true, unknown: true }),
);
const duration = optional(nullable(isNumber));
const optionalString = optional(isString);
const optionalNumber = optional(isNumber);

const checkItem = shape<CommitCheckItem>({
    name: isString,
    description: isString,
    state: commitCheckState,
    source: oneOf<CommitCheckItem["source"]>({ "check-run": true, status: true }),
    url: optionalString,
    id: optionalString,
    logicalId: optionalString,
});

/** True when `value` is a whole {@link CommitChecksSnapshot} with only allowed state values. */
export const isCommitChecksSnapshot = shape<CommitChecksSnapshot>({
    hash: isString,
    state: commitCheckState,
    summary: isString,
    items: listOf(checkItem),
    error: optionalString,
    signInHost: optionalString,
});

const step = shape<CiStep>({
    number: isNumber,
    name: isString,
    state: ciState,
    startedAt: optionalString,
    completedAt: optionalString,
});

const job = shape<CiJob>({
    id: isString,
    logicalId: isString,
    checkRunId: optionalString,
    name: isString,
    checkName: isString,
    state: ciState,
    url: optionalString,
    startedAt: optionalString,
    completedAt: optionalString,
    attempt: optionalNumber,
    steps: listOf(step),
    annotationCount: optionalNumber,
    optional: optional(isBoolean),
    required: requiredFlag,
    failureSummary: optionalString,
    usualDurationMs: duration,
});

const run = shape<CiRun>({
    id: isString,
    name: isString,
    url: optionalString,
    state: ciState,
    workflowId: optionalString,
    event: optionalString,
    actor: optionalString,
    ref: optionalString,
    runNumber: optionalNumber,
    attempt: optionalNumber,
    createdAt: optionalString,
    startedAt: optionalString,
    completedAt: optionalString,
    usualDurationMs: duration,
    jobs: listOf(job),
    jobsCoverage: coverage,
    // Scan progress lives in memory only, so a stored one was not written by this store.
    failedScan: (value) => value === undefined,
});

const flatCheck = shape<CiFlatCheck>({
    id: optionalString,
    logicalId: optionalString,
    name: isString,
    description: isString,
    state: commitCheckState,
    source: oneOf<CiFlatCheck["source"]>({ "check-run": true, status: true, build: true }),
    url: optionalString,
    durationMs: duration,
    required: requiredFlag,
    usualDurationMs: duration,
});

const attempt = shape<CiAttempt>({
    attempt: isNumber,
    executionId: isString,
    state: ciState,
    startedAt: optionalString,
    completedAt: optionalString,
});

const attemptHistory = shape<CiAttemptHistory>({
    runId: isString,
    logicalId: isString,
    attempts: listOf(attempt),
    coverage,
});

/** True when `value` is a whole {@link CommitCiDetailData} with only allowed state values. */
export const isCommitCiDetailData = shape<CommitCiDetailData>({
    hash: isString,
    provider: oneOf<ProviderId>({
        github: true,
        gitlab: true,
        "bitbucket-cloud": true,
        "bitbucket-server": true,
    }),
    complete: isBoolean,
    outcome: commitCheckState,
    runs: listOf(run),
    runsCoverage: coverage,
    otherChecks: listOf(flatCheck),
    otherChecksCoverage: coverage,
    requiredStatus: optional(
        oneOf<NonNullable<CommitCiDetailData["requiredStatus"]>>({
            known: true,
            partial: true,
            unknown: true,
        }),
    ),
    attemptHistory: optional(listOf(attemptHistory)),
    error: optionalString,
    signInHost: optionalString,
});
