import type { GitExecutor } from "../executor";
import type { InteractiveRebaseGuardRejectionReason, InteractiveRebaseGuardResult } from "./types";

const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Dependencies required to evaluate the pure host-side interactive-rebase action guards. */
export interface InteractiveRebaseGuardOptions {
    /** Executor rooted at the repository whose selected commit is being evaluated. */
    executor: GitExecutor;
    /** Full object ID for the selected commit. */
    selectedHash: string;
    /**
     * Repository-level detector for the states in which Git requires a whole-index commit.
     *
     * This deliberately answers a narrower question than this guard needs: it covers merge,
     * sequencer, and rebase state but not bisect, because its other callers use it to decide
     * whether a path-filtered commit is possible, and Git does permit partial commits while
     * bisecting. Bisect is probed separately below.
     */
    hasWholeIndexOperationInProgress: () => Promise<boolean>;
}

/**
 * Evaluates every action guard required before an interactive-rebase range can be shown.
 *
 * The pending-operation check runs first so an in-progress rebase reports that fact rather than
 * the detached HEAD it happens to produce, which would send the user to the wrong remedy. The
 * selected hash is validated before it reaches Git, because a value beginning with `-` would be
 * parsed as an option rather than a revision. All failed probes are rejected.
 */
export async function evaluateInteractiveRebaseGuards(
    options: InteractiveRebaseGuardOptions,
): Promise<InteractiveRebaseGuardResult> {
    const { executor, selectedHash, hasWholeIndexOperationInProgress } = options;
    if (!FULL_OBJECT_ID.test(selectedHash)) return rejected("invalid-selected-hash");

    try {
        if ((await hasWholeIndexOperationInProgress()) || (await isBisecting(executor))) {
            return rejected("operation-in-progress");
        }

        try {
            await executor.run(["symbolic-ref", "--quiet", "HEAD"]);
        } catch {
            return rejected("detached-head");
        }

        const selectedParents = parentsFrom(
            await executor.run([
                "rev-list",
                "--parents",
                "-n",
                "1",
                "--end-of-options",
                selectedHash,
            ]),
        );
        if (selectedParents.length > 1) return rejected("selected-merge-commit");
        if (selectedParents.length === 0) return rejected("initial-commit");

        try {
            await executor.run([
                "merge-base",
                "--is-ancestor",
                "--end-of-options",
                selectedHash,
                "HEAD",
            ]);
        } catch {
            return rejected("commit-not-ancestor");
        }

        if ((await executor.run(["status", "--porcelain=v1", "-z", "-uall"])).length > 0) {
            return rejected("working-tree-dirty");
        }

        const rangeParents = await executor.run([
            "rev-list",
            "--parents",
            "--end-of-options",
            `${selectedHash}^..HEAD`,
        ]);
        if (rangeParents.split("\n").some((line) => parentsFrom(line).length > 1)) {
            return rejected("range-contains-merge-commit");
        }

        return { status: "ok" };
    } catch {
        return rejected("git-error");
    }
}

/**
 * Reports whether a bisect session is active, which starting a rebase must not interrupt.
 *
 * `git bisect log` exits zero only while bisecting, so its exit status is the probe rather than a
 * second filesystem-marker interpretation of repository state.
 */
async function isBisecting(executor: GitExecutor): Promise<boolean> {
    try {
        await executor.run(["bisect", "log"]);
        return true;
    } catch {
        return false;
    }
}

function parentsFrom(line: string): string[] {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    return parts.slice(1);
}

function rejected(reason: InteractiveRebaseGuardRejectionReason): InteractiveRebaseGuardResult {
    return { status: "rejected", reason };
}
