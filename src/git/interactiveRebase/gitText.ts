import type { GitExecutor } from "../executor";

/** Byte ceiling for every interactive-rebase probe, so one huge conflict cannot exhaust the host. */
const MAX_PROBE_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Reads bounded UTF-8 Git output without allowing a truncated value to become actionable state.
 *
 * `ls-files -u` grows with the conflict, so every probe is bounded. A truncated probe is never
 * trimmed into a plausible-looking answer: it throws, leaving each caller's own failure path to
 * decide what an unanswerable probe means for the state it owns. The ceiling and this rule live
 * here rather than beside each caller because a fix applied to one copy is not a fix.
 */
export async function readGitText(
    executor: Pick<GitExecutor, "runBinary">,
    args: string[],
): Promise<string> {
    const result = await executor.runBinary(args, { maxOutputBytes: MAX_PROBE_OUTPUT_BYTES });
    if (result.truncated) throw new Error(`Git output exceeded ${MAX_PROBE_OUTPUT_BYTES} bytes.`);
    return result.stdout.toString("utf8").trim();
}

/** Turns an unknown thrown value into a bounded diagnostic for the host. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
