import { describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../../src/git/operations";
import type { CommitChecksSnapshot, CommitCiDetailData } from "../../../../src/types";

vi.mock("vscode", () => ({
    l10n: { t: (message: string) => `[l10n] ${message}` },
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

/** Entry keys of a stored cache payload. */
function entryKeys(value: unknown): string[] {
    const entries = (value as { entries?: { key: string }[] } | undefined)?.entries ?? [];
    return entries.map((entry) => entry.key);
}

/**
 * globalState double shared across "restarts"; `failing` makes every write reject, a set
 * `hold` keeps every write waiting until it settles, and `afterWrite` runs once a write landed.
 */
function memento() {
    const values = new Map<string, unknown>();
    const store = {
        failing: false,
        failedWrites: 0,
        hold: undefined as Promise<void> | undefined,
        afterWrite: undefined as ((value: unknown) => void) | undefined,
        get: <T>(key: string) => values.get(key) as T | undefined,
        update: vi.fn(async (key: string, value: unknown) => {
            await store.hold;
            if (store.failing) {
                store.failedWrites += 1;
                throw new Error("storage unavailable");
            }
            if (value === undefined) values.delete(key);
            else values.set(key, value);
            store.afterWrite?.(value);
        }),
        /** Every entry key saved in any cache payload. */
        savedKeys: () => [...values.values()].flatMap(entryKeys),
    };
    return store;
}

/** The signed-in account; a set `hold` keeps every provider fetch running until it settles. */
interface Account {
    current: string;
    hold?: Promise<void>;
}

/** One extension session: fresh services, caches and coordinator over the shared store. */
function startSession(store: ReturnType<typeof memento>, account: Account) {
    // The provider answers for whichever account is signed in when its request completes.
    const outcome = (): Outcome => (account.current === "old" ? "failure" : "success");
    const getChecks = vi.fn(async () => {
        await account.hold;
        return snapshot(outcome());
    });
    const getDetail = vi.fn(async () => {
        await account.hold;
        return detail(outcome());
    });
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
    return { coordinator, provider, getChecks, getDetail, getRemotes: gitOps.getRemotes };
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

    it("a fetch the account switched under is never saved under the old account", async () => {
        const store = memento();
        let release!: () => void;
        const account: Account = {
            current: "old",
            hold: new Promise<void>((resolve) => (release = resolve)),
        };
        const first = startSession(store, account);
        const checks = first.coordinator.getChecks(HASH);
        const ciDetail = first.coordinator.getDetail(HASH, {}, ctx);
        await vi.waitFor(() => {
            expect(first.getChecks).toHaveBeenCalled();
            expect(first.getDetail).toHaveBeenCalled();
        });

        // The account switches while both requests run; no clear() follows.
        account.current = "new";
        account.hold = undefined;
        release();
        await expect(checks).resolves.toMatchObject({ state: "success" });
        await expect(ciDetail).resolves.toMatchObject({ outcome: "success" });
        // The answer that finished under the switch is asked again under the new account.
        expect(first.getChecks).toHaveBeenCalledTimes(2);
        expect(first.getDetail).toHaveBeenCalledTimes(2);

        // A restart under the old account must fetch, never read the new account's answer.
        account.current = "old";
        const restarted = startSession(store, account);
        await expect(restarted.coordinator.getChecks(HASH)).resolves.toMatchObject({
            state: "failure",
        });
        expect(restarted.getChecks).toHaveBeenCalledTimes(1);
        await expect(restarted.coordinator.getDetail(HASH, {}, ctx)).resolves.toMatchObject({
            outcome: "failure",
        });
        expect(restarted.getDetail).toHaveBeenCalledTimes(1);
    });

    it("a forced fetch after a token change with no clear() is never saved under the old account", async () => {
        const store = memento();
        const account: Account = { current: "old" };
        const first = startSession(store, account);
        await first.coordinator.getChecks(HASH);
        await first.coordinator.getDetail(HASH, {}, ctx);

        // The token changes in another window: this window gets no clear().
        account.current = "new";
        await expect(first.coordinator.getChecks(HASH, { force: true })).resolves.toMatchObject({
            state: "success",
        });
        await expect(
            first.coordinator.getDetail(HASH, { force: true }, ctx),
        ).resolves.toMatchObject({ outcome: "success" });

        // The old account's saved answer is still its own.
        account.current = "old";
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

    it("clear() after an account switch resolves again and saves the next answer under the new account", async () => {
        const store = memento();
        const account: Account = { current: "old" };
        const first = startSession(store, account);
        await first.coordinator.getChecks(HASH);
        await first.coordinator.getDetail(HASH, {}, ctx);
        expect(first.getRemotes).toHaveBeenCalledTimes(1);

        account.current = "new";
        first.coordinator.clear();
        await expect(first.coordinator.getChecks(HASH)).resolves.toMatchObject({
            state: "success",
        });
        await expect(first.coordinator.getDetail(HASH, {}, ctx)).resolves.toMatchObject({
            outcome: "success",
        });
        expect(first.getRemotes).toHaveBeenCalledTimes(2);

        // A restart under the new account reads those answers without a fetch.
        const restarted = startSession(store, account);
        await expect(restarted.coordinator.getChecks(HASH)).resolves.toMatchObject({
            state: "success",
        });
        await expect(restarted.coordinator.getDetail(HASH, {}, ctx)).resolves.toMatchObject({
            outcome: "success",
        });
        expect(restarted.getChecks).not.toHaveBeenCalled();
        expect(restarted.getDetail).not.toHaveBeenCalled();
    });

    it("an account that changes on every try gets an unavailable answer, and nothing is saved under any account", async () => {
        const store = memento();
        const account: Account = { current: "new" };
        const session = startSession(store, account);
        let reads = 0;
        // A failed lookup yields a fresh `unresolved-` id on every read.
        session.provider.accountKey = async () => `unresolved-${(reads += 1)}`;

        const message = "[l10n] The signed-in account changed during the request.";
        await expect(session.coordinator.getChecks(HASH)).resolves.toMatchObject({
            state: "unavailable",
            error: message,
        });
        await expect(session.coordinator.getDetail(HASH, {}, ctx)).resolves.toMatchObject({
            outcome: "unavailable",
            error: message,
            repoKey: "/repo",
            capabilities: NO_CI_CAPABILITIES,
        });
        expect(store.update).not.toHaveBeenCalled();

        // The account settles on the first id read: nothing was kept in memory under it.
        session.provider.accountKey = async () => "unresolved-1";
        await session.coordinator.getChecks(HASH);
        await session.coordinator.getDetail(HASH, {}, ctx);
        expect(session.getChecks).toHaveBeenCalledTimes(3);
        expect(session.getDetail).toHaveBeenCalledTimes(3);
    });

    it("an account that changes during each save gets an unavailable answer, and neither save is kept", async () => {
        const store = memento();
        const account: Account = { current: "a" };
        const session = startSession(store, account);
        // Every save that lands an entry is followed by an account switch.
        store.afterWrite = (value) => {
            if (entryKeys(value).length > 0) account.current += "'";
        };

        await expect(session.coordinator.getChecks(HASH)).resolves.toMatchObject({
            state: "unavailable",
        });
        await expect(session.coordinator.getDetail(HASH, {}, ctx)).resolves.toMatchObject({
            outcome: "unavailable",
        });
        expect(session.getChecks).toHaveBeenCalledTimes(2);
        expect(session.getDetail).toHaveBeenCalledTimes(2);
        expect(store.savedKeys()).toEqual([]);

        // Back on the first account, nothing was kept in memory either.
        store.afterWrite = undefined;
        account.current = "a";
        await session.coordinator.getChecks(HASH);
        await session.coordinator.getDetail(HASH, {}, ctx);
        expect(session.getChecks).toHaveBeenCalledTimes(3);
        expect(session.getDetail).toHaveBeenCalledTimes(3);
    });

    it("an answer whose save finishes after an account switch is asked again under the new account", async () => {
        const store = memento();
        const account: Account = { current: "old" };
        const session = startSession(store, account);
        let release!: () => void;
        store.hold = new Promise<void>((resolve) => (release = resolve));
        const checks = session.coordinator.getChecks(HASH);
        const ciDetail = session.coordinator.getDetail(HASH, {}, ctx);
        // Both answers were fetched under the old account and are being saved.
        await vi.waitFor(() => expect(store.update).toHaveBeenCalledTimes(2));

        account.current = "new";
        store.hold = undefined;
        release();
        await expect(checks).resolves.toMatchObject({ state: "success" });
        await expect(ciDetail).resolves.toMatchObject({ outcome: "success" });
        expect(session.getChecks).toHaveBeenCalledTimes(2);
        expect(session.getDetail).toHaveBeenCalledTimes(2);
    });

    it("invalidate() drops the signed-in account's saved answers", async () => {
        const store = memento();
        const account: Account = { current: "old" };
        const session = startSession(store, account);
        await session.coordinator.getChecks(HASH);
        await session.coordinator.getDetail(HASH, {}, ctx);

        await session.coordinator.invalidate(HASH);
        await session.coordinator.getChecks(HASH);
        await session.coordinator.getDetail(HASH, {}, ctx);

        expect(session.getChecks).toHaveBeenCalledTimes(2);
        expect(session.getDetail).toHaveBeenCalledTimes(2);
    });
});
