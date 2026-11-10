import jobFixture from "./workflowJob.json";

/**
 * Generated fixture: a failed run with 2 000 jobs, built from the recorded job in
 * `workflowJob.json`. Generated rather than stored, because 2 000 recorded jobs would weigh
 * several megabytes. Both failed jobs sit past the 1 000-item page bound.
 */
const FAILED_RUN_JOB_COUNT = 2000;
const FAILED_RUN_FAILED_POSITIONS: readonly number[] = [1050, 1900];

/** The recorded job with its ids, name and conclusion replaced for one 1-based position. */
export function generatedJob(
    position: number,
    conclusion = "success",
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    const id = 1_000_000 + position;
    return {
        ...jobFixture,
        id,
        url: `https://api.github.com/repos/microsoft/vscode/actions/jobs/${id}`,
        html_url: `https://github.com/microsoft/vscode/actions/runs/${jobFixture.run_id}/job/${id}`,
        name: `job ${position}`,
        conclusion,
        check_run_url: `https://api.github.com/repos/microsoft/vscode/check-runs/${2_000_000 + position}`,
        ...overrides,
    };
}

/** The run's jobs in API order; only the jobs at the failed positions failed. */
export function failedRunJobs(): Record<string, unknown>[] {
    return Array.from({ length: FAILED_RUN_JOB_COUNT }, (_, i) =>
        generatedJob(i + 1, FAILED_RUN_FAILED_POSITIONS.includes(i + 1) ? "failure" : "success"),
    );
}
