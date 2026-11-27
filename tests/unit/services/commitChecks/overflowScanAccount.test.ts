// Reproduction: an overflow (failed-job) scan page read after an account switch must not be
// cached under the account that started the scan.

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
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";

const ghRef = { host: "github.com", owner: "octo", repo: "app" } as ProviderRepoRef;

/** A detail whose only run stopped at the job page bound, so a failed-job scan continues it. */
const OVERFLOW_DETAIL = {
    hash: "abc",
    provider: "github",
    complete: true,
    outcome: "failure",
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
    runsCoverage: "full",
    otherChecks: [],
    otherChecksCoverage: "full",
    scanCursors: [{ runId: "1", runAttempt: 1, runName: "CI", url: "page-11" }],
} as unknown as CommitCiDetailData;

function setup() {
    let account = "reader";
    const generations = new CiGenerations();
    let releaseScan = () => {};
    const scanHeld = new Promise<void>((resolve) => {
        releaseScan = resolve;
    });
    // Holds a page between being read and reaching the scan; released at once unless a test holds it.
    let landed: Promise<void> = Promise.resolve();
    let releaseLanding = () => {};
    // The page holds whatever the token signed in when it is read is allowed to see.
    const continueFailedScan = vi.fn(async () => {
        await scanHeld;
        const name = account === "admin" ? "admin-only-job" : "reader-job";
        await landed;
        return {
            failed: [
                {
                    id: name,
                    logicalId: `job\0CI\0${name}`,
                    name,
                    checkName: name,
                    state: "failure" as const,
                    steps: [],
                },
            ],
        };
    });
    const provider = {
        id: "github",
        capabilities: { ...NO_CI_CAPABILITIES },
        match: () => ghRef,
        keyFor: () => "github:github.com:octo/app",
        accountKey: async () => `account-${account}`,
        getChecks: vi.fn(),
        getDetail: vi.fn(async () => OVERFLOW_DETAIL),
        continueFailedScan,
    } as unknown as CommitChecksProvider;
    const gitOps = {
        getRemotes: vi.fn(async () => ["origin"]),
        getRemoteUrl: vi.fn(async () => "https://github.com/octo/app.git"),
        readDefaultBranch: vi.fn(async () => null),
    } as unknown as GitOps;
    const coordinator = new CommitChecksCoordinator(gitOps, [provider], {}, { generations });
    return {
        continueFailedScan,
        releaseScan,
        signInAs: (next: string) => {
            account = next;
        },
        // The app raises the auth generation on every sign-in change (refreshCommitCheckBadges).
        switchTo: (next: string) => {
            account = next;
            generations.bumpAuth();
        },
        holdLanding: () => {
            landed = new Promise<void>((resolve) => {
                releaseLanding = resolve;
            });
        },
        releaseLanding: () => releaseLanding(),
        detail: (onScanUpdate?: (detail: CommitCiDetail) => void) =>
            coordinator.getDetail("abc", {}, generations.capture("/repo"), onScanUpdate),
    };
}

describe("overflow scan pages follow the signed-in account", () => {
    it("control: a page read with no switch reaches the reader's cached detail", async () => {
        const c = setup();
        await c.detail(() => {});
        await vi.waitFor(() => expect(c.continueFailedScan).toHaveBeenCalledTimes(1));
        c.releaseScan();
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(JSON.stringify(await c.detail())).toContain("reader-job");
    });

    it("a page read as another account is not kept in the reader's cache", async () => {
        const c = setup();
        await c.detail(() => {});
        await vi.waitFor(() => expect(c.continueFailedScan).toHaveBeenCalledTimes(1));

        c.signInAs("admin");
        c.releaseScan();
        await new Promise((resolve) => setTimeout(resolve, 30));
        c.signInAs("reader");
        const back = JSON.stringify(await c.detail());

        expect(
            back.includes("admin-only-job"),
            "reader cache must not contain the page read as admin",
        ).toBe(false);
    });

    it("a page read as the admin that lands after the reader is back and asked again is not kept", async () => {
        const c = setup();
        c.holdLanding();
        await c.detail(() => {});
        await vi.waitFor(() => expect(c.continueFailedScan).toHaveBeenCalledTimes(1));

        c.switchTo("admin");
        c.releaseScan(); // the page is read as the admin
        await new Promise((resolve) => setTimeout(resolve, 10));
        c.switchTo("reader");
        await c.detail(() => {}); // the reader's new request takes the scan over
        c.releaseLanding(); // the admin's page lands now
        await new Promise((resolve) => setTimeout(resolve, 30));
        const back = JSON.stringify(await c.detail());

        expect(
            back.includes("admin-only-job"),
            "reader -> admin -> reader: the admin's page must not reach the reader's cache",
        ).toBe(false);
    });
});

/** A complete detail with one run named after the account that read it. */
function detailReadAs(account: string): CommitCiDetailData {
    return {
        hash: "abc",
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: [
            {
                id: "1",
                name: `run-read-as-${account}`,
                attempt: 1,
                state: "failure",
                jobs: [],
                jobsCoverage: "full",
            },
        ],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
    } as unknown as CommitCiDetailData;
}

describe("a lookup that sees a switch away and back is not the same sign-in (#436)", () => {
    it("a detail read while signed in as B is not kept under A after A -> B -> A", async () => {
        let account = "A";
        const generations = new CiGenerations();
        const switchTo = (next: string) => {
            account = next;
            generations.bumpAuth();
        };
        let reads = 0;
        const getDetail = vi.fn(async () => {
            reads += 1;
            if (reads > 1) return detailReadAs(account);
            // The first read is answered for B, and A is signed in again before the check.
            switchTo("B");
            const answer = detailReadAs(account);
            switchTo("A");
            return answer;
        });
        const provider = {
            id: "github",
            capabilities: { ...NO_CI_CAPABILITIES },
            match: () => ghRef,
            keyFor: () => "github:github.com:octo/app",
            accountKey: async () => `account-${account}`,
            getChecks: vi.fn(),
            getDetail,
        } as unknown as CommitChecksProvider;
        const gitOps = {
            getRemotes: vi.fn(async () => ["origin"]),
            getRemoteUrl: vi.fn(async () => "https://github.com/octo/app.git"),
            readDefaultBranch: vi.fn(async () => null),
        } as unknown as GitOps;
        const coordinator = new CommitChecksCoordinator(gitOps, [provider], {}, { generations });

        await coordinator.getDetail("abc", {}, generations.capture("/repo"));
        const later = JSON.stringify(
            await coordinator.getDetail("abc", {}, generations.capture("/repo")),
        );

        expect(later, "control: the later lookup as A got a detail").toContain("run-read-as-");
        expect(
            later.includes("run-read-as-B"),
            "A -> B -> A: the detail read as B must not be kept under A",
        ).toBe(false);
    });
});
