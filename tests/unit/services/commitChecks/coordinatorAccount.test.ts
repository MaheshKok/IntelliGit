import { describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../../src/git/operations";
import type { CommitChecksSnapshot, CommitCiDetailData } from "../../../../src/types";

vi.mock("vscode", () => ({
    l10n: { t: (message: string) => message },
}));

import { CiGenerations } from "../../../../src/services/commitChecks/ciGenerations";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import { CiDetailPersistentCache } from "../../../../src/services/commitChecks/detailPersistentCache";
import { CommitCiDetailService } from "../../../../src/services/commitChecks/detailService";
import { CommitChecksPersistentCache } from "../../../../src/services/commitChecks/persistentCache";
import { CommitChecksService } from "../../../../src/services/commitChecks/service";
import type { CommitChecksProvider } from "../../../../src/services/commitChecks/types";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";

const HASH = "abc1234";

type Outcome = "failure" | "success";

function snapshot(state: Outcome): CommitChecksSnapshot {
    return {
        hash: HASH,
        state,
        summary: state,
        items: [{ name: "build", description: "", state, source: "check-run" }],
    };
}

function detail(outcome: Outcome): CommitCiDetailData {
    return {
        hash: HASH,
        provider: "github",
        complete: true,
        outcome,
        runs: [],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
    };
}

/** globalState double shared across "restarts"; `failing` makes every write reject. */
function memento() {
    const values = new Map<string, unknown>();
    const store = {
        failing: false,
        failedWrites: 0,
        get: <T>(key: string) => values.get(key) as T | undefined,
        update: vi.fn(async (key: string, value: unknown) => {
            if (store.failing) {
                store.failedWrites += 1;
                throw new Error("storage unavailable");
            }
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        }),
    };
    return store;
}

/** One extension session: fresh services, caches and coordinator over the shared store. */
function startSession(store: ReturnType<typeof memento>, account: { current: string }) {
    const outcome = (): Outcome => (account.current === "old" ? "failure" : "success");
    const getChecks = vi.fn(async () => snapshot(outcome()));
    const getDetail = vi.fn(async () => detail(outcome()));
    const provider: CommitChecksProvider = {
        id: "github",
        capabilities: NO_CI_CAPABILITIES,
        match: () => ({ host: "github.com" }),
        keyFor: () => "github:github.com:o/r",
        accountKey: async () => account.current,
        getChecks,
        getDetail,
    };
    const gitOps = {
        getRemotes: vi.fn(async () => ["origin"]),
        getRemoteUrl: vi.fn(async () => "https://github.com/o/r.git"),
    } as unknown as GitOps;
    const coordinator = new CommitChecksCoordinator(
        gitOps,
        [provider],
        {},
        {
            service: new CommitChecksService({
                persistentCache: new CommitChecksPersistentCache(store),
            }),
            detailService: new CommitCiDetailService({
                persistentCache: new CiDetailPersistentCache(store),
            }),
        },
    );
    return { coordinator, getChecks, getDetail };
}

const ctx = new CiGenerations().capture("/repo");

describe("CommitChecksCoordinator saved results are tied to the signed-in account", () => {
    it("a failed clear on an account switch never serves the old account's results after a restart", async () => {
        const store = memento();
        const account = { current: "old" };
        const first = startSession(store, account);
        await first.coordinator.getChecks(HASH);
        await first.coordinator.getDetail(HASH, {}, ctx);

        // Account switch: the key removal and the empty overwrite both fail in both stores.
        account.current = "new";
        store.failing = true;
        first.coordinator.clear();
        await vi.waitFor(() => expect(store.failedWrites).toBe(4));
        // Storage recovers, then the extension restarts under the new account.
        store.failing = false;
        const restarted = startSession(store, account);

        await expect(restarted.coordinator.getChecks(HASH)).resolves.toMatchObject({
            state: "success",
        });
        expect(restarted.getChecks).toHaveBeenCalledTimes(1);
        await expect(restarted.coordinator.getDetail(HASH, {}, ctx)).resolves.toMatchObject({
            outcome: "success",
        });
        expect(restarted.getDetail).toHaveBeenCalledTimes(1);
    });

    it("a restart under the same account still serves saved results without a fetch", async () => {
        const store = memento();
        const account = { current: "old" };
        const first = startSession(store, account);
        await first.coordinator.getChecks(HASH);
        await first.coordinator.getDetail(HASH, {}, ctx);

        const restarted = startSession(store, account);

        await expect(restarted.coordinator.getChecks(HASH)).resolves.toMatchObject({
            state: "failure",
        });
        await expect(restarted.coordinator.getDetail(HASH, {}, ctx)).resolves.toMatchObject({
            outcome: "failure",
        });
        expect(restarted.getChecks).not.toHaveBeenCalled();
        expect(restarted.getDetail).not.toHaveBeenCalled();
    });
});
