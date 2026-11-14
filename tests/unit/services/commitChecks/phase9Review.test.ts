// Phase 9 review round 1: the required-rules read follows the signed-in account (K21).

import { describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import type {
    CommitChecksProvider,
    ProviderRepoRef,
} from "../../../../src/services/commitChecks/types";
import type { CommitCiDetailData } from "../../../../src/types";
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

/** One provider whose merge rule depends on who is signed in, and a switch for who that is. */
function setup() {
    let account = "admin";
    let holdAdmin: Promise<void> | undefined;
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
        getDetail: vi.fn(async () => DETAIL),
        getRequiredChecks,
    };
    const gitOps = {
        getRemotes: vi.fn(async () => ["origin"]),
        getRemoteUrl: vi.fn(async () => "https://github.com/octo/app.git"),
        readDefaultBranch: vi.fn(async () => ({ name: "trunk", tipHash: "t1" })),
    } as unknown as GitOps;
    const generations = new CiGenerations();
    const coordinator = new CommitChecksCoordinator(gitOps, [provider], {}, { generations });
    return {
        getRequiredChecks,
        signInAs: (next: string) => {
            account = next;
        },
        holdAdminRead: () => {
            let release = () => {};
            holdAdmin = new Promise<void>((resolve) => {
                release = resolve;
            });
            return release;
        },
        detail: () => coordinator.getDetail("abc", {}, generations.capture("/repo")),
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
});
