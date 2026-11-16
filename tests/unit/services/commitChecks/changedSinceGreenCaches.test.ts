// "Changed since last green" (PLAN.md §14) through the real caches: a stored copy stays usable
// while a refresh of the same commit runs, and jobs of other workflows never stop the walk.
// The three cases come from the Phase 12 round-3 review (owner answer 2026-11-16).

import { describe, expect, it, vi } from "vitest";
import { changedSinceGreen } from "../../../../src/services/commitChecks/changedSinceGreen";
import { CiDetailPersistentCache } from "../../../../src/services/commitChecks/detailPersistentCache";
import { CommitCiDetailService } from "../../../../src/services/commitChecks/detailService";
import { CommitChecksPersistentCache } from "../../../../src/services/commitChecks/persistentCache";
import { CommitChecksService } from "../../../../src/services/commitChecks/service";
import { NO_CI_CAPABILITIES } from "../../../../src/shared/ci/capabilities";
import type { CommitChecksSnapshot, CommitCiDetailData } from "../../../../src/types";

vi.mock("vscode", () => ({ l10n: { t: (text: string) => text } }));

const HASH = "a".repeat(40);
const ANCESTOR = "b".repeat(40);
const OLDER = "c".repeat(40);
const LOGICAL_ID = "job\0CI\0unit";
const SERVE = { repoKey: "/repo", capabilities: NO_CI_CAPABILITIES };

function snap(hash: string): CommitChecksSnapshot {
    return {
        hash,
        state: "success",
        summary: "",
        items: [
            {
                name: "unit",
                description: "",
                source: "check-run",
                state: "success",
                logicalId: LOGICAL_ID,
            },
        ],
    };
}

function data(): CommitCiDetailData {
    return {
        hash: HASH,
        provider: "github",
        complete: true,
        outcome: "failure",
        runs: [
            {
                id: "1",
                name: "CI",
                state: "failure",
                jobs: [
                    {
                        id: "1",
                        name: "unit",
                        checkName: "unit",
                        logicalId: LOGICAL_ID,
                        state: "failure",
                        steps: [],
                    },
                ],
                jobsCoverage: "full",
            },
        ],
        runsCoverage: "full",
        otherChecks: [],
        otherChecksCoverage: "full",
    };
}

function memory(): {
    get: (key: string) => unknown;
    update: (key: string, value: unknown) => Promise<void>;
} {
    const map = new Map<string, unknown>();
    return {
        get: (key) => map.get(key),
        update: async (key, value) => {
            map.set(key, value);
        },
    };
}

const request = (loaded: { hash: string; parents: string[] }[]) => ({
    hash: HASH,
    logicalCheckId: LOGICAL_ID,
    scopeName: "CI",
    checkName: "unit",
    loaded,
});

describe("changedSinceGreen with other workflows' jobs", () => {
    it("known identities from unrelated workflows do not block an older exact green", async () => {
        const unrelated = (scope: string) => ({
            ...snap(ANCESTOR).items[0],
            logicalId: `job\0${scope}\0unit`,
        });
        const result = await changedSinceGreen(
            {
                cachedDetail: async () => data(),
                cachedChecks: async (hash) =>
                    hash === ANCESTOR
                        ? { ...snap(hash), items: [unrelated("Deploy"), unrelated("Lint")] }
                        : snap(hash),
                diffNameStatus: async () => "",
                diffNumstat: async () => "",
            },
            request([
                { hash: HASH, parents: [ANCESTOR] },
                { hash: ANCESTOR, parents: [OLDER] },
                { hash: OLDER, parents: [] },
            ]),
        );
        expect(
            result,
            "fully identified jobs in Deploy and Lint cannot be ambiguous matches for CI/unit",
        ).toEqual({ lastGreen: OLDER, files: [] });
    });
});

describe("changedSinceGreen during a refresh after a restart", () => {
    it("stored passing ancestor remains visible during refresh after restart", async () => {
        const store = memory();
        await new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(store),
        }).getOrFetch(ANCESTOR, async () => snap(ANCESTOR));
        const restarted = new CommitChecksService({
            persistentCache: new CommitChecksPersistentCache(store),
        });
        let release!: (value: CommitChecksSnapshot) => void;
        const refresh = restarted.getOrFetch(
            ANCESTOR,
            () =>
                new Promise((done) => {
                    release = done;
                }),
            { force: true },
        );
        try {
            const answer = await changedSinceGreen(
                {
                    cachedDetail: async () => data(),
                    cachedChecks: (hash) => restarted.getCached(hash),
                    diffNameStatus: async () => "",
                    diffNumstat: async () => "",
                },
                request([
                    { hash: HASH, parents: [ANCESTOR] },
                    { hash: ANCESTOR, parents: [] },
                ]),
            );
            expect(
                answer,
                "section 14 reads L1 then L2; a pending refresh must not erase a stored passing ancestor",
            ).toEqual({ lastGreen: ANCESTOR, files: [] });
        } finally {
            release(snap(ANCESTOR));
            await refresh;
        }
    });

    it("stored selected detail remains usable during refresh after restart", async () => {
        const store = memory();
        await new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(store),
        }).getOrFetch(HASH, async () => data(), SERVE);
        const restarted = new CommitCiDetailService({
            persistentCache: new CiDetailPersistentCache(store),
        });
        let release!: (value: CommitCiDetailData) => void;
        const refresh = restarted.getOrFetch(
            HASH,
            () =>
                new Promise((done) => {
                    release = done;
                }),
            SERVE,
            { force: true },
        );
        try {
            const answer = await changedSinceGreen(
                {
                    cachedDetail: (hash) => restarted.getCached(hash, SERVE),
                    cachedChecks: async (hash) => snap(hash),
                    diffNameStatus: async () => "",
                    diffNumstat: async () => "",
                },
                request([
                    { hash: HASH, parents: [ANCESTOR] },
                    { hash: ANCESTOR, parents: [] },
                ]),
            );
            expect(
                answer,
                "cached selected detail proves the current population without waiting for the refresh",
            ).toEqual({ lastGreen: ANCESTOR, files: [] });
        } finally {
            release(data());
            await refresh;
        }
    });
});
