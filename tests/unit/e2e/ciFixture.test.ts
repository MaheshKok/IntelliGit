import { afterEach, describe, expect, it, vi } from "vitest";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import {
    E2E_CI_FIXTURE_KEY,
    readE2eCiFixture,
    readE2eCiFixtureLog,
} from "../../../src/e2e/ciFixture";
import type { GitOps } from "../../../src/git/operations";
import { ciLogKey } from "../../../src/services/commitChecks/ciLogMemoryStore";
import { CommitChecksCoordinator } from "../../../src/services/commitChecks/coordinator";
import type {
    CommitChecksProvider,
    ProviderRepoRef,
} from "../../../src/services/commitChecks/types";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
import { isCommitChecksSnapshot } from "../../../src/shared/ci/persistedShape";
import type { CommitCiDetailData } from "../../../src/types";

vi.mock("vscode", () => ({ l10n: { t: (message: string) => message } }));

const HASH = "a".repeat(40);

function seededDetail(): Omit<CommitCiDetailData, "hash"> {
    return {
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: [],
        runsCoverage: "full",
        otherChecks: [{ name: "lint", description: "", state: "failure", source: "status" }],
        otherChecksCoverage: "full",
    };
}

function memento(value: unknown) {
    return { get: vi.fn((key: string) => (key === E2E_CI_FIXTURE_KEY ? value : undefined)) };
}

afterEach(() => setE2eControlChannelActive(false));

describe("readE2eCiFixture", () => {
    it("serves nothing while the E2E control channel is off, even when seeded", () => {
        const store = memento({ detail: seededDetail() });
        expect(readE2eCiFixture(store, HASH)).toBeUndefined();
        expect(store.get).not.toHaveBeenCalled();
    });

    it("stamps the asked commit on the seeded detail and serves the seeded capabilities", () => {
        setE2eControlChannelActive(true);
        const capabilities = { ...NO_CI_CAPABILITIES, rerunFailed: true };
        const fixture = readE2eCiFixture(memento({ detail: seededDetail(), capabilities }), HASH);
        expect(fixture?.detail.hash).toBe(HASH);
        expect(fixture?.detail.outcome).toBe("failure");
        expect(fixture?.capabilities).toEqual(capabilities);
    });

    it("fails loudly when a capability flag is missing, instead of guessing it off", () => {
        setE2eControlChannelActive(true);
        const { steps: _steps, ...withoutSteps } = NO_CI_CAPABILITIES;
        expect(() =>
            readE2eCiFixture(memento({ detail: seededDetail(), capabilities: withoutSteps }), HASH),
        ).toThrow(/steps/);
        expect(() => readE2eCiFixture(memento({ detail: seededDetail() }), HASH)).toThrow(
            E2E_CI_FIXTURE_KEY,
        );
        expect(() =>
            readE2eCiFixture(
                memento({
                    detail: seededDetail(),
                    capabilities: { ...NO_CI_CAPABILITIES, logs: 1 },
                }),
                HASH,
            ),
        ).toThrow(/logs/);
    });

    it("fails loudly when the seeded value is not a CI detail", () => {
        setE2eControlChannelActive(true);
        expect(() => readE2eCiFixture(memento({ detail: { outcome: 3 } }), HASH)).toThrow(
            E2E_CI_FIXTURE_KEY,
        );
    });
});

describe("readE2eCiFixtureLog", () => {
    it("serves nothing while the E2E control channel is off, even when seeded", () => {
        const store = memento({ detail: seededDetail(), logs: { "7": "log" } });
        expect(readE2eCiFixtureLog(store, "7")).toBeUndefined();
        expect(store.get).not.toHaveBeenCalled();
    });

    it("serves the seeded text of the asked job only", () => {
        setE2eControlChannelActive(true);
        const store = memento({ detail: seededDetail(), logs: { "7": "line 1\nERROR" } });
        expect(readE2eCiFixtureLog(store, "7")).toBe("line 1\nERROR");
        expect(readE2eCiFixtureLog(store, "8")).toBeUndefined();
        expect(readE2eCiFixtureLog(memento({ detail: seededDetail() }), "7")).toBeUndefined();
        expect(readE2eCiFixtureLog(memento(undefined), "7")).toBeUndefined();
    });

    it("fails loudly when a seeded log is not text", () => {
        setE2eControlChannelActive(true);
        expect(() =>
            readE2eCiFixtureLog(memento({ detail: seededDetail(), logs: { "7": 3 } }), "7"),
        ).toThrow(E2E_CI_FIXTURE_KEY);
        expect(() =>
            readE2eCiFixtureLog(memento({ detail: seededDetail(), logs: "text" }), "7"),
        ).toThrow(E2E_CI_FIXTURE_KEY);
    });
});

describe("CommitChecksCoordinator.ciLogTarget", () => {
    const JOB = { runId: "5", jobId: "7", attempt: 2 };
    const CTX = { repoKey: "/repo", authGeneration: 0, lifecycleGeneration: 0 };
    const REMOTE = "git@github.com:owner/repo.git";

    function providerCoordinator(provider: Partial<CommitChecksProvider>, enabled = true) {
        const full: CommitChecksProvider = {
            id: "github",
            match: (url) => (url === REMOTE ? { host: "github.com" } : null),
            keyFor: (ref) => `github:${ref.host}`,
            getChecks: vi.fn(),
            ...provider,
        };
        const gitOps = {
            getRemotes: vi.fn(async () => ["origin"]),
            getRemoteUrl: vi.fn(async () => REMOTE),
        } as unknown as GitOps;
        return new CommitChecksCoordinator(gitOps, [full], {}, { enabled });
    }

    it("keys a seeded log by the repository and records no provider repository", async () => {
        setE2eControlChannelActive(true);
        const store = memento({
            detail: seededDetail(),
            capabilities: { ...NO_CI_CAPABILITIES, logs: true },
        });
        const coordinator = new CommitChecksCoordinator(
            {} as GitOps,
            [],
            {},
            { fixture: (hash) => readE2eCiFixture(store, hash) },
        );
        expect(await coordinator.ciLogTarget(HASH, JOB, CTX)).toEqual({
            key: ciLogKey("e2e:/repo", "5", "7", 2),
            source: { repoKey: "/repo", provider: "github", runId: "5", jobId: "7", attempt: 2 },
        });
    });

    it("a seeded detail without the logs capability has no log", async () => {
        setE2eControlChannelActive(true);
        const store = memento({ detail: seededDetail(), capabilities: NO_CI_CAPABILITIES });
        const coordinator = new CommitChecksCoordinator(
            {} as GitOps,
            [],
            {},
            { fixture: (hash) => readE2eCiFixture(store, hash) },
        );
        expect(await coordinator.ciLogTarget(HASH, JOB, CTX)).toBeUndefined();
    });

    it("keys a provider's log by its repository key and records its repository", async () => {
        const coordinator = providerCoordinator({
            capabilities: { ...NO_CI_CAPABILITIES, logs: true },
            getJobLog: vi.fn(),
        });
        expect(await coordinator.ciLogTarget(HASH, JOB, CTX)).toEqual({
            key: ciLogKey("github:github.com", "5", "7", 2),
            source: {
                repoKey: "/repo",
                provider: "github",
                ref: { host: "github.com" },
                runId: "5",
                jobId: "7",
                attempt: 2,
            },
        });
    });

    it("a provider without logs, or turned-off checks, has no log", async () => {
        const getJobLog = vi.fn();
        expect(
            await providerCoordinator({ capabilities: NO_CI_CAPABILITIES, getJobLog }).ciLogTarget(
                HASH,
                JOB,
                CTX,
            ),
            "the logs capability is off",
        ).toBeUndefined();
        expect(
            await providerCoordinator({
                capabilities: { ...NO_CI_CAPABILITIES, logs: true },
            }).ciLogTarget(HASH, JOB, CTX),
            "the provider cannot download a log",
        ).toBeUndefined();
        expect(
            await providerCoordinator(
                { capabilities: { ...NO_CI_CAPABILITIES, logs: true }, getJobLog },
                false,
            ).ciLogTarget(HASH, JOB, CTX),
            "commit checks are turned off",
        ).toBeUndefined();
    });
});

describe("CommitChecksCoordinator fixture", () => {
    it("serves the seeded detail and snapshot without resolving a provider", async () => {
        setE2eControlChannelActive(true);
        const store = memento({ detail: seededDetail(), capabilities: NO_CI_CAPABILITIES });
        const coordinator = new CommitChecksCoordinator(
            {} as GitOps,
            [],
            {},
            {
                fixture: (hash) => readE2eCiFixture(store, hash),
            },
        );
        const detail = await coordinator.getDetail(HASH, {}, { repoKey: "/repo" } as never);
        expect(detail).toMatchObject({ hash: HASH, outcome: "failure", repoKey: "/repo" });
        const snapshot = await coordinator.getChecks(HASH);
        expect(snapshot).toMatchObject({ hash: HASH, state: "failure" });
        expect(snapshot.items.map((item) => item.name)).toEqual(["lint"]);
    });

    it("the seeded snapshot keeps each check's identity and source, mapping only a build to a status", async () => {
        setE2eControlChannelActive(true);
        const detail = {
            ...seededDetail(),
            otherChecks: [
                {
                    id: "11",
                    logicalId: "github:check:build",
                    name: "build",
                    description: "",
                    state: "success" as const,
                    source: "check-run" as const,
                },
                {
                    id: "ci/lint",
                    name: "lint",
                    description: "",
                    state: "failure" as const,
                    source: "status" as const,
                },
                {
                    id: "jenkins-1",
                    name: "jenkins",
                    description: "",
                    state: "success" as const,
                    source: "build" as const,
                },
            ],
        };
        const store = memento({ detail, capabilities: NO_CI_CAPABILITIES });
        const coordinator = new CommitChecksCoordinator(
            {} as GitOps,
            [],
            {},
            { fixture: (hash) => readE2eCiFixture(store, hash) },
        );
        const snapshot = await coordinator.getChecks(HASH);
        expect(
            snapshot.items.map(({ id, logicalId, source }) => ({ id, logicalId, source })),
            "each seeded check keeps its id, logical id and source",
        ).toEqual([
            { id: "11", logicalId: "github:check:build", source: "check-run" },
            { id: "ci/lint", logicalId: undefined, source: "status" },
            { id: "jenkins-1", logicalId: undefined, source: "status" },
        ]);
        expect(isCommitChecksSnapshot(snapshot), "the snapshot meets the snapshot contract").toBe(
            true,
        );
    });

    it("a seeded unavailable detail keeps its error and sign-in host on the badge", async () => {
        setE2eControlChannelActive(true);
        const detail = {
            ...seededDetail(),
            outcome: "unavailable" as const,
            error: "Sign in to gitlab.example.com",
            signInHost: "gitlab.example.com",
        };
        const store = memento({ detail, capabilities: NO_CI_CAPABILITIES });
        const coordinator = new CommitChecksCoordinator(
            {} as GitOps,
            [],
            {},
            { fixture: (hash) => readE2eCiFixture(store, hash) },
        );
        const snapshot = await coordinator.getChecks(HASH);
        expect(snapshot).toMatchObject({
            state: "unavailable",
            error: "Sign in to gitlab.example.com",
            signInHost: "gitlab.example.com",
        });
    });

    it("while the channel is off, a seeded fixture leaves badge requests exactly as without the seam", async () => {
        const store = memento({ detail: seededDetail(), capabilities: NO_CI_CAPABILITIES });
        const badgeRequests = async (
            fixture?: (hash: string) => ReturnType<typeof readE2eCiFixture>,
        ) => {
            const getChecks = vi.fn(async (_ref: ProviderRepoRef, hash: string) => ({
                hash,
                state: "success" as const,
                summary: "success",
                items: [],
            }));
            const provider: CommitChecksProvider = {
                id: "github",
                match: (url) =>
                    url === "git@github.com:owner/repo.git" ? { host: "github.com" } : null,
                keyFor: (ref) => `github:${ref.host}`,
                getChecks,
            };
            const gitOps = {
                getRemotes: vi.fn(async () => ["origin"]),
                getRemoteUrl: vi.fn(async () => "git@github.com:owner/repo.git"),
            } as unknown as GitOps;
            const coordinator = new CommitChecksCoordinator(gitOps, [provider], {}, { fixture });
            const snapshot = await coordinator.getChecks(HASH);
            return { calls: getChecks.mock.calls, snapshot };
        };

        const withoutSeam = await badgeRequests();
        const withSeededFixture = await badgeRequests((hash) => readE2eCiFixture(store, hash));

        expect(
            withSeededFixture.calls,
            "the provider is asked for the same commit, the same number of times",
        ).toEqual(withoutSeam.calls);
        expect(withoutSeam.calls, "the comparison saw a real provider request").toHaveLength(1);
        expect(withSeededFixture.snapshot, "the seeded failure never reaches a badge").toEqual(
            withoutSeam.snapshot,
        );
        expect(store.get, "the seeded fixture is never read").not.toHaveBeenCalled();
    });
});
