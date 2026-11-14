// Phase 9 review round 1: the required-rules read follows the signed-in account (K21).

import { describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import type {
    CommitChecksProvider,
    ProviderRepoRef,
} from "../../../../src/services/commitChecks/types";
import type { CommitCiDetail, CommitCiDetailData } from "../../../../src/types";
import type { GitOps } from "../../../../src/git/operations";

vi.mock("vscode", () => ({
    authentication: { getSession: vi.fn() },
    l10n: { t: interpolateL10n },
}));

import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import type { RequiredChecks } from "../../../../src/services/commitChecks/requiredChecks";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";

const ghRef = { host: "github.com", owner: "octo", repo: "app" } as ProviderRepoRef;

const DETAIL: CommitCiDetailData = {
    hash: "abc",
    provider: "github",
    complete: true,
    outcome: "failure",
    runs: [],
    runsCoverage: "full",
    otherChecks: [],
    otherChecksCoverage: "full",
};

/** A detail whose only run stopped at the job page bound, so a failed-job scan continues it. */
const OVERFLOW_DETAIL: CommitCiDetailData = {
    ...DETAIL,
    runs: [
        {
            id: "1",
            name: "CI",
            attempt: 1,
            state: "failure",
            jobs: [],
            jobsCoverage: { reason: "pageBound", shown: 1000 },
        },
    ],
    scanCursors: [{ runId: "1", runAttempt: 1, runName: "CI", url: "page-11" }],
} as CommitCiDetailData;

/** One provider whose merge rule depends on who is signed in, and a switch for who that is. */
function setup(startAs = "admin", overflow = false) {
    let account = startAs;
    let holdAdmin: Promise<void> | undefined;
    let holdGit: Promise<void> | undefined;
    let holdDetail: Promise<void> | undefined;
    let releaseScan = () => {};
    const scanHeld = new Promise<void>((resolve) => {
        releaseScan = resolve;
    });
    const continueFailedScan = vi.fn(async () => {
        await scanHeld;
        return {
            failed: [
                {
                    id: "late",
                    logicalId: "job\0CI\0build",
                    name: "build",
                    checkName: "build",
                    state: "failure" as const,
                    steps: [],
                },
            ],
        };
    });
    const getRequiredChecks = vi.fn(async (): Promise<RequiredChecks> => {
        const asker = account;
        if (asker === "admin" && holdAdmin) await holdAdmin;
        return asker === "admin" ? { status: "known", names: ["build"] } : { status: "unknown" };
    });
    const provider: CommitChecksProvider = {
        id: "github",
        capabilities: { ...NO_CI_CAPABILITIES, requiredChecks: true },
        match: () => ghRef,
        keyFor: () => "github:github.com:octo/app",
        accountKey: async () => `account-${account}`,
        getChecks: vi.fn(),
        getDetail: vi.fn(async () => {
            const wait = holdDetail;
            holdDetail = undefined;
            await wait;
            return overflow ? OVERFLOW_DETAIL : DETAIL;
        }),
        getRequiredChecks,
        ...(overflow ? { continueFailedScan } : {}),
    };
    const gitOps = {
        getRemotes: vi.fn(async () => ["origin"]),
        getRemoteUrl: vi.fn(async () => "https://github.com/octo/app.git"),
        readDefaultBranch: vi.fn(async () => {
            await holdGit;
            return { name: "trunk", tipHash: "t1" };
        }),
    } as unknown as GitOps;
    const generations = new CiGenerations();
    const coordinator = new CommitChecksCoordinator(gitOps, [provider], {}, { generations });
    return {
        getRequiredChecks,
        readDefaultBranch: gitOps.readDefaultBranch as ReturnType<typeof vi.fn>,
        getDetailCalls: () => (provider.getDetail as ReturnType<typeof vi.fn>).mock.calls.length,
        signInAs: (next: string) => {
            account = next;
        },
        holdGitRead: () => {
            let release = () => {};
            holdGit = new Promise<void>((resolve) => {
                release = resolve;
            });
            return release;
        },
        /** Holds the next detail read only; a retry is not held. */
        holdDetailRead: () => {
            let release = () => {};
            holdDetail = new Promise<void>((resolve) => {
                release = resolve;
            });
            return release;
        },
        holdAdminRead: () => {
            let release = () => {};
            holdAdmin = new Promise<void>((resolve) => {
                release = resolve;
            });
            return release;
        },
        continueFailedScan,
        releaseScan,
        detail: (onScanUpdate?: (detail: CommitCiDetail) => void) =>
            coordinator.getDetail("abc", {}, generations.capture("/repo"), onScanUpdate),
    };
}

describe("rules are isolated when", () => {
    it("rules are isolated when the current token account changes before the auth event", async () => {
        const c = setup();
        expect((await c.detail())?.requiredStatus).toBe("known");

        c.signInAs("reader");
        const asReader = await c.detail();

        expect(asReader?.requiredStatus, "reader must not inherit admin's known rule").toBe(
            "unknown",
        );
    });

    it("an account change while only the rules read is pending cannot publish the old account", async () => {
        const c = setup();
        const release = c.holdAdminRead();
        const pending = c.detail();
        await vi.waitFor(() => expect(c.getRequiredChecks).toHaveBeenCalledTimes(1));

        c.signInAs("reader");
        release();
        const published = await pending;

        expect(published?.requiredStatus, "old admin result must be discarded or reread").not.toBe(
            "known",
        );
    });

    it("a switch during the Git read, then back, cannot reuse another account's known rule", async () => {
        const c = setup("reader");
        const release = c.holdGitRead();
        const pending = c.detail();
        await vi.waitFor(() => expect(c.readDefaultBranch).toHaveBeenCalledTimes(1));

        c.signInAs("admin");
        release();
        await pending;
        c.signInAs("reader");
        const backAsReader = await c.detail();

        expect(
            backAsReader?.requiredStatus,
            "reader must not reuse admin rule cached during git await",
        ).toBe("unknown");
    });

    it("a switch after the rules settle, while the detail is pending, cannot publish the old account's rule", async () => {
        const c = setup();
        const release = c.holdDetailRead();
        const pending = c.detail();
        await vi.waitFor(() => expect(c.getRequiredChecks).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(c.getDetailCalls()).toBe(1));
        // Let the admin rules settle before the switch.
        await new Promise((resolve) => setTimeout(resolve, 0));

        c.signInAs("reader");
        release();
        const published = await pending;

        expect(
            published?.requiredStatus,
            "new account detail must not be decorated with old account rules",
        ).toBe("unknown");
    });

    it("the served detail names the default branch whose rules were applied", async () => {
        const c = setup();

        expect((await c.detail())?.defaultBranch).toBe("trunk");
    });

    it("an overflow update with no account switch carries the account's rule", async () => {
        const c = setup("admin", true);
        const updates: CommitCiDetail[] = [];
        expect((await c.detail((d) => updates.push(d)))?.requiredStatus).toBe("known");
        await vi.waitFor(() => expect(c.continueFailedScan).toHaveBeenCalledTimes(1));

        c.releaseScan();

        await vi.waitFor(() => expect(updates.map((d) => d.requiredStatus)).toEqual(["known"]));
    });

    it("an overflow update after an account switch cannot publish the old account's rule", async () => {
        const c = setup("admin", true);
        const updates: CommitCiDetail[] = [];
        expect((await c.detail((d) => updates.push(d)))?.requiredStatus).toBe("known");
        await vi.waitFor(() => expect(c.continueFailedScan).toHaveBeenCalledTimes(1));

        c.signInAs("reader");
        c.releaseScan();
        // The control test above shows an unswitched update lands well inside this window.
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(
            updates.some((d) => d.requiredStatus === "known"),
            "reader must not receive the admin rules on an overflow update",
        ).toBe(false);
    });
});
