// Logical check identity across commits. Execution ids (job ids, check-run ids) name
// one execution and never match across commits; this id names "the same check" in a
// parent, a default-branch tip or a later commit.

/** Input for a logical check id: a job inside a workflow/pipeline, or a flat check. */
export type CiLogicalCheckSource =
    | {
          readonly kind: "job";
          /** Workflow (GitHub) or pipeline (GitLab, Bitbucket Cloud) name; absent = "". */
          readonly scope?: string | null;
          /** Job or step name. */
          readonly name: string;
      }
    | {
          readonly kind: "status";
          /** Provider check name or status context. */
          readonly name: string;
      };

/**
 * Builds the cross-commit identity of a check.
 *
 * @param source - The job with its workflow or pipeline name, or a flat status check.
 * @returns `scope + "\0" + name` for jobs, `"status\0" + name` for flat checks.
 */
export function logicalCheckId(source: CiLogicalCheckSource): string {
    if (source.kind === "status") return `status\0${source.name}`;
    return `${source.scope ?? ""}\0${source.name}`;
}
