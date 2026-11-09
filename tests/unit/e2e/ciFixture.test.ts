import { afterEach, describe, expect, it, vi } from "vitest";
import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import { E2E_CI_FIXTURE_KEY, readE2eCiFixture } from "../../../src/e2e/ciFixture";
import type { GitOps } from "../../../src/git/operations";
import { CommitChecksCoordinator } from "../../../src/services/commitChecks/coordinator";
import { NO_CI_CAPABILITIES } from "../../../src/shared/ci/capabilities";
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
});
