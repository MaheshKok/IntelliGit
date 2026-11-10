import { describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../../src/git/operations";
import type { CommitCiDetailData } from "../../../../src/types";

vi.mock("vscode", () => ({
    l10n: { t: (message: string) => message },
}));

import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import type { CommitChecksProvider } from "../../../../src/services/commitChecks/types";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";

const HASH = "abc1234";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function detail(): CommitCiDetailData {
    return {
        hash: HASH,
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: [],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
    };
}

function setup(remoteUrl: () => Promise<string> = async () => "https://github.com/o/r.git") {
    const generations = new CiGenerations();
    const trace = vi.fn();
    const getDetail = vi.fn(async () => detail());
    const provider: CommitChecksProvider = {
        id: "github",
        capabilities: NO_CI_CAPABILITIES,
        match: () => ({ host: "github.com", owner: "o", repo: "r" }),
        keyFor: () => "github:github.com:o/r",
        getChecks: vi.fn(),
        getDetail,
    };
    const gitOps = {
        getRemotes: vi.fn(async () => ["origin"]),
        getRemoteUrl: vi.fn(remoteUrl),
    } as unknown as GitOps;
    const coordinator = new CommitChecksCoordinator(gitOps, [provider], {}, { generations, trace });
    return { coordinator, generations, trace, getDetail };
}

describe("CommitChecksCoordinator.getDetail generations", () => {
    it("returns the detail while the captured context is current", async () => {
        const { coordinator, generations } = setup();
        const detailResult = await coordinator.getDetail(HASH, {}, generations.capture("/repo"));
        expect(detailResult).toMatchObject({ outcome: "failure", repoKey: "/repo" });
    });

    it("a sign-out during the detail fetch publishes nothing", async () => {
        const { coordinator, generations, trace, getDetail } = setup();
        const pending = deferred<CommitCiDetailData>();
        getDetail.mockImplementation(() => pending.promise);
        const result = coordinator.getDetail(HASH, {}, generations.capture("/repo"));
        await vi.waitFor(() => expect(getDetail).toHaveBeenCalledTimes(1));

        generations.bumpAuth();
        pending.resolve(detail());

        await expect(result).resolves.toBeUndefined();
        expect(trace).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: "detail",
                outcome: "discarded-generation",
                repoKey: "/repo",
                hash: HASH,
            }),
        );
    });

    it("a lifecycle bump while the provider resolves fetches and publishes nothing", async () => {
        const url = deferred<string>();
        const { coordinator, generations, getDetail } = setup(() => url.promise);
        const result = coordinator.getDetail(HASH, {}, generations.capture("/repo"));

        generations.bumpLifecycle();
        url.resolve("https://github.com/o/r.git");

        await expect(result).resolves.toBeUndefined();
        expect(getDetail).not.toHaveBeenCalled();
    });
});
