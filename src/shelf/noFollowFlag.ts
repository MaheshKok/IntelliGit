import { constants } from "node:fs";

/**
 * Resolves the `O_NOFOLLOW` bit to pass to `open`, or zero where the platform cannot honour it.
 *
 * **The defect this closes.** Three call sites independently wrote
 * `typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0`, which asks whether Node
 * *defines* the constant -- not whether the platform *honours* it. On Windows those are different
 * questions, and `open` rejected the resulting flag word outright:
 *
 * ```text
 * EINVAL: invalid argument, open 'C:\...\intelligit-shelf-integration-qeSZuw\tracked.txt'
 *     at replaceRegularWorktreeFile (src/shelf/safeWorktreeWrite.ts:16)
 *     at ShelfService.applyRawEntry (src/services/shelfService.ts:687)
 * ```
 *
 * That is a user-facing bug, not a test artifact: applying a raw shelf entry failed on Windows for
 * every user. It accounted for the largest single cluster of failures in issue #223, and the target
 * in that trace is an ordinary `tracked.txt` whose regular-file status `assertRegularTarget` had
 * just confirmed -- so the flag word was the only remaining variable in the call.
 *
 * **Why returning zero is safe.** `O_NOFOLLOW` is an atomicity optimisation here, not the only
 * guard. Each caller already brackets its `open` with the fail-closed check that
 * `src/shelf/recovery.ts` documents as the fallback "when O_NOFOLLOW is unavailable":
 * `replaceRegularWorktreeFile` lstats the target for regular-file status before AND after writing,
 * and the two recovery writers pass `O_CREAT | O_EXCL`, which already refuses to follow a symlink
 * at the path it creates. Dropping the bit widens a documented race; it does not remove a check.
 *
 * `platform` is a parameter so the Windows branch is reachable from a POSIX test run. The bug is
 * invisible on the host that runs the suite -- on macOS and Linux this function is unchanged
 * behaviour -- so the platform has to be supplied rather than inherited for any test to see it.
 */
export function resolveNoFollowFlag(platform: NodeJS.Platform = process.platform): number {
    if (platform === "win32") return 0;
    return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}
