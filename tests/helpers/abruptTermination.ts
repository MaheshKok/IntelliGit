/**
 * Decides whether a spawned process died abruptly, on a platform that may have no POSIX signals.
 *
 * **The defect this closes.** `tests/integration/shelf/shelfCrashWorker.ts` simulates a crashed
 * IntelliGit by calling `process.kill(process.pid, "SIGKILL")` on itself, and the recovery tests
 * asserted the parent observed `signal === "SIGKILL"`. Windows has no signals: Node implements that
 * call as `TerminateProcess`, so the parent sees `code: 1, signal: null` and the assertion read
 * `expected null to be 'SIGKILL'`. Nothing was wrong with the crash, the recovery, or the code under
 * test -- the assertion was describing the POSIX delivery mechanism rather than the property the
 * test needs, which is "this process died without running its cleanup".
 *
 * **What is lost, and what covers it.** On Windows an abrupt kill is indistinguishable from an
 * uncaught exception: both surface as a non-zero code with no signal. That discrimination is not
 * lost overall, because every caller follows this check with `expireCrashLocks`, which reads the
 * lock files the worker must have been holding and throws `Crash worker likely exited before
 * holding expected lock` when they are absent. Reaching the checkpoint is proven there; dying
 * abruptly is proven here. On POSIX the exact-signal check is kept, so no platform loses a check it
 * previously had.
 *
 * `platform` is a parameter, and this returns a verdict instead of asserting, so both branches are
 * reachable from a POSIX test run -- see `tests/unit/helpers/abruptTermination.test.ts`. A branch
 * that only ever executes on CI is a branch whose first execution is a 35-minute round trip.
 */
export interface TerminationOutcome {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
}

export interface TerminationVerdict {
    readonly abrupt: boolean;
    /** Human-readable account of what was observed and what was required, for the failure message. */
    readonly reason: string;
}

export function describeAbruptTermination(
    outcome: TerminationOutcome,
    platform: NodeJS.Platform = process.platform,
): TerminationVerdict {
    const observed = `code=${String(outcome.code)} signal=${String(outcome.signal)}`;
    if (platform === "win32") {
        if (outcome.signal !== null) {
            return { abrupt: false, reason: `${observed}; Windows should report no signal` };
        }
        if (outcome.code === 0) {
            return { abrupt: false, reason: `${observed}; worker exited cleanly instead of dying` };
        }
        return { abrupt: true, reason: observed };
    }
    if (outcome.signal !== "SIGKILL") {
        return { abrupt: false, reason: `${observed}; expected delivery of SIGKILL` };
    }
    return { abrupt: true, reason: observed };
}
