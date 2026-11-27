// A snapshot read in part must never certify a comparison (PLAN.md §9, K35, Phase 11): every
// provider marks an unread remainder `partial`, the floor detail keeps it, and neither cache
// keeps a partial (or pre-flag) snapshot as if it were whole.

import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ l10n: { t: (message: string) => message } }));

import { BitbucketCloudProvider } from "../../../../src/services/commitChecks/bitbucketCloudProvider";
import { BitbucketServerProvider } from "../../../../src/services/commitChecks/bitbucketServerProvider";
import { readCiHistory } from "../../../../src/services/commitChecks/ciHistory";
import { CommitChecksCoordinator } from "../../../../src/services/commitChecks/coordinator";
import { CredentialStore } from "../../../../src/services/commitChecks/credentialStore";
import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";
import { HttpError } from "../../../../src/services/commitChecks/http";
import { CommitChecksPersistentCache } from "../../../../src/services/commitChecks/persistentCache";
import { CommitChecksService } from "../../../../src/services/commitChecks/service";
import type { CommitChecksSnapshot } from "../../../../src/types";

const HASH = "a".repeat(40);
const PARENT = "b".repeat(40);
const item = {
    name: "unit",
    description: "",
    state: "success" as const,
    source: "status" as const,
};

function store(): CredentialStore {
    return new CredentialStore({
        get: vi.fn(async () => "token"),
        store: vi.fn(),
        delete: vi.fn(),
        onDidChange: vi.fn(() => ({ dispose() {} })),
    } as never);
}

function snap(partial: boolean): CommitChecksSnapshot {
    return {
        hash: PARENT,
        state: "success",
        summary: "",
        items: [item],
        ...(partial && { partial: true }),
    };
}

function memento(initial: Record<string, unknown> = {}) {
    const values = new Map<string, unknown>(Object.entries(initial));
    return {
        get: (key: string) => values.get(key),
        update: async (key: string, value: unknown) => {
            values.set(key, structuredClone(value));
        },
    };
}

describe("partial coverage reaches every cache and detail", () => {
    it("a full GitLab status page marks the parent partial", async () => {
        const rows = Array.from({ length: 100 }, (_, id) => ({
            id,
            name: `ci-${id}`,
            status: "success",
        }));
        const provider = new GitLabProvider(async () => rows, store(), /./);
        const history = await readCiHistory(
            {
                getChecks: (hash) =>
                    provider.getChecks(
                        { host: "gitlab.com", owner: "o", repo: "r" } as never,
                        hash,
                    ),
                readDefaultBranch: async () => null,
            },
            [PARENT],
        );
        expect(history.parent?.partial, "a full GitLab page may hide a next page").toBe(true);
    });

    it("a GitLab status page short of the page size stays whole", async () => {
        const rows = [{ id: 1, name: "ci-1", status: "success" }];
        const provider = new GitLabProvider(async () => rows, store(), /./);
        const snapshot = await provider.getChecks(
            { host: "gitlab.com", owner: "o", repo: "r" } as never,
            PARENT,
        );
        expect(snapshot.partial).toBeUndefined();
    });

    it("a refused Bitbucket Cloud next link leaves the snapshot partial", async () => {
        const provider = new BitbucketCloudProvider(
            async () => ({
                values: [{ key: "unit", name: "unit", state: "SUCCESSFUL" }],
                next: "https://evil.example/2.0/more",
            }),
            store(),
        );
        const snapshot = await provider.getChecks(
            { host: "bitbucket.org", workspace: "o", repo: "r" } as never,
            PARENT,
        );
        expect(snapshot.partial, "the refused page was never read").toBe(true);
    });

    it("a Bitbucket Server page that is not the last but has no cursor leaves the snapshot partial", async () => {
        const provider = new BitbucketServerProvider(
            async () => ({
                values: [{ key: "unit", name: "unit", state: "SUCCESSFUL" }],
                isLastPage: false,
            }),
            store(),
        );
        const snapshot = await provider.getChecks(
            { host: "bb.example", project: "P", repo: "r" } as never,
            PARENT,
        );
        expect(snapshot.partial, "isLastPage false without a cursor is not a whole list").toBe(
            true,
        );
    });

    it("the floor detail of a partial snapshot does not claim full flat coverage", async () => {
        // An endless chain of allowed pages: the page bound leaves the rest unread. Pipelines
        // refused with 403 send Bitbucket Cloud's detail down to the floor of its status list.
        const provider = new BitbucketCloudProvider(
            async (url: string) => {
                const page = Number(new URL(url).searchParams.get("page") ?? "1");
                return {
                    values: [{ key: `k${page}`, name: `ci-${page}`, state: "FAILED" }],
                    next: `https://api.bitbucket.org/2.0/repositories/o/r/commit/${HASH}/statuses?page=${page + 1}`,
                };
            },
            store(),
            async () => {
                throw new HttpError(403, "HTTP 403: Forbidden", {});
            },
        );
        const coordinator = new CommitChecksCoordinator(
            {
                getRemotes: async () => ["origin"],
                getRemoteUrl: async () => "https://bitbucket.org/o/r",
                readDefaultBranch: async () => null,
            } as never,
            [provider],
            {},
        );
        const detail = await coordinator.getDetail(
            HASH,
            {},
            { repoKey: "/repo", authGeneration: 0, lifecycleGeneration: 0 },
        );
        expect(detail?.scopeHelp?.key, "the floor detail was built").toBe(
            "commit.checks.tab.pipelineScopeHint",
        );
        expect(detail?.otherChecksCoverage, "the current population is unproven").not.toBe("full");
    });

    it("a partial snapshot is not persisted across a restart", async () => {
        const state = memento();
        await new CommitChecksPersistentCache(state as never).set("key", snap(true));
        expect(
            await new CommitChecksPersistentCache(state as never).get("key"),
            "a partial snapshot must miss after a restart",
        ).toBeUndefined();
    });

    it("a partial L1 snapshot is read again after the pending TTL", async () => {
        let now = 0;
        const fetch = vi.fn(async () => snap(fetch.mock.calls.length === 1));
        const service = new CommitChecksService({ now: () => now });
        expect((await service.getOrFetch("key", fetch)).partial).toBe(true);
        now = 30_001;
        expect(
            (await service.getOrFetch("key", fetch)).partial,
            "a partial read must refresh",
        ).toBeUndefined();
    });

    it("a snapshot saved before the partial flag existed is not trusted after an upgrade", async () => {
        // Written by a version whose snapshots had no `partial` flag: a cut list looked whole.
        const state = memento({
            "intelligit.commitChecks.cache.v1": {
                schemaVersion: 1,
                entries: [
                    {
                        key: "key",
                        snapshot: snap(false),
                        fetchedAt: 0,
                        lastAccessedAt: 0,
                        schemaVersion: 1,
                    },
                ],
                unconfirmed: {},
            },
        });
        const service = new CommitChecksService({
            now: () => 0,
            persistentCache: new CommitChecksPersistentCache(state as never, { now: () => 0 }),
        });
        const history = await readCiHistory(
            {
                getChecks: () => service.getOrFetch("key", async () => snap(true)),
                readDefaultBranch: async () => null,
            },
            [PARENT],
        );
        expect(history.parent?.partial, "a pre-flag entry must be read again").toBe(true);
    });
});
