// "Find where CI broke" host handler (PLAN.md §13): once the repository, sign-in or CI settings
// changed under a running bisect, no further request is queued or sent, not only no reply.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ l10n: { t: (message: string) => message } }));

import { setE2eControlChannelActive } from "../../../src/e2e/activationState";
import type { CiBisectSource } from "../../../src/services/commitChecks/ciBisect";
import { CiGenerations } from "../../../src/services/commitChecks/ciGenerations";
import { answerStartCiBisect } from "../../../src/views/ciBisectHandler";
import { CommitCiDetailLoops } from "../../../src/views/ciDetailHandler";

const h = (c: string): string => c.repeat(40);
const commits = ["a", "b", "c", "d", "e", "f"].map((c, index, all) => ({
    hash: h(c),
    parents: index + 1 < all.length ? [h(all[index + 1])] : [],
}));
const flush = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

afterEach(() => setE2eControlChannelActive(false));

describe("answerStartCiBisect retry", () => {
    it.each([
        [true, 2],
        [undefined, 0],
    ])("retry %s asks the source to refresh %s failed reads", async (retry, forced) => {
        setE2eControlChannelActive(true);
        const refreshed: string[] = [];
        const source: CiBisectSource = {
            capabilities: async () => undefined,
            attemptHistory: async () => [],
            getChecks: async (hash, options) => {
                if (options.force) refreshed.push(hash);
                return { hash, state: "unavailable", summary: "", items: [] };
            },
        };
        await answerStartCiBisect(
            {
                repoKey: () => "/repo",
                bisect: { source, loaded: () => commits },
            } as never,
            { requestId: 1, repoKey: "/repo", commits: commits.slice(0, 2), retry },
            () => {},
            new CommitCiDetailLoops(),
        );
        expect(refreshed).toHaveLength(forced);
    });
});

describe("answerStartCiBisect while the Checks tab switch is off", () => {
    it.each([
        ["no fields", {}],
        ["a malformed request id", { requestId: "1", repoKey: "/repo", commits: [] }],
        ["a malformed repository", { requestId: 1, repoKey: 7, commits: [] }],
        ["malformed commits", { requestId: 1, repoKey: "/repo", commits: "nope" }],
    ])("a start with %s is ignored, not rejected", async (_name, msg) => {
        setE2eControlChannelActive(false);
        await expect(
            answerStartCiBisect(
                { repoKey: () => "/repo" } as never,
                msg,
                () => {},
                new CommitCiDetailLoops(),
            ),
            "a disabled bisect must neither throw (the host would post an error) nor post",
        ).resolves.toBeUndefined();
    });

    it("still rejects a malformed start once the switch is on", async () => {
        setE2eControlChannelActive(true);
        await expect(
            answerStartCiBisect(
                { repoKey: () => "/repo" } as never,
                { requestId: "1" },
                () => {},
                new CommitCiDetailLoops(),
            ),
        ).rejects.toThrow("Invalid CI bisect request id.");
    });
});

describe("answerStartCiBisect invalidation", () => {
    /** Starts a bisect whose first four reads wait, then applies `change` and lets them finish. */
    async function invalidate(
        change: (state: { generations: CiGenerations; setRepo: (repo: string) => void }) => void,
        options: { cancel?: boolean } = {},
    ): Promise<{ reads: string[]; posts: unknown[] }> {
        let repo = "/repo";
        const generations = new CiGenerations();
        const reads: string[] = [];
        const releases: Array<() => void> = [];
        const posts: unknown[] = [];
        // The first four reads wait; a later one is recorded only if the bisect still sends it.
        const source: CiBisectSource = {
            capabilities: async () => undefined,
            attemptHistory: async () => [],
            getChecks: async (hash, fetch) => {
                if (reads.length < 4) {
                    reads.push(`${repo}:${hash}`);
                    await new Promise<void>((resolve) => releases.push(resolve));
                } else if (fetch.sendGuard()) {
                    reads.push(`${repo}:${hash}`);
                }
                return { hash, state: "success", summary: "", items: [] };
            },
        };
        const runs = new CommitCiDetailLoops();
        const running = answerStartCiBisect(
            {
                repoKey: () => repo,
                generations,
                bisect: { source, loaded: () => commits },
            } as never,
            { requestId: 1, repoKey: repo, commits },
            (message) => posts.push(message),
            runs,
        );
        await flush();
        if (options.cancel) runs.cancel(1);
        change({ generations, setRepo: (next) => (repo = next) });
        for (const release of releases.splice(0)) release();
        await running;
        return { reads, posts };
    }

    it.each(["repository", "auth", "lifecycle"])("%s change stops later requests", async (kind) => {
        setE2eControlChannelActive(true);
        const { reads } = await invalidate(({ generations, setRepo }) => {
            if (kind === "repository") setRepo("/other");
            else if (kind === "auth") generations.bumpAuth();
            else generations.bumpLifecycle();
        });
        expect(reads, "no fifth read after invalidation").toHaveLength(4);
    });

    // Owner 2026-11-24, finding 5 answer B: the view must not stay on "k / N commits" with Cancel.
    it.each(["auth", "lifecycle"])(
        "a %s change posts one final reply marked stopped and no result",
        async (kind) => {
            setE2eControlChannelActive(true);
            const { posts } = await invalidate(({ generations }) => {
                if (kind === "auth") generations.bumpAuth();
                else generations.bumpLifecycle();
            });
            expect(posts, "sign-in or CI settings changed under the bisect").toEqual([
                { type: "ciBisectProgress", requestId: 1, done: 0, total: 6, stopped: true },
            ]);
        },
    );

    it("a repository change posts nothing: the view of that repository is gone", async () => {
        setE2eControlChannelActive(true);
        const { posts } = await invalidate(({ setRepo }) => setRepo("/other"));
        expect(posts).toEqual([]);
    });

    it("a cancelled bisect is not reported as stopped", async () => {
        setE2eControlChannelActive(true);
        const { posts } = await invalidate(({ generations }) => generations.bumpAuth(), {
            cancel: true,
        });
        expect(posts, "the user's own Cancel needs no stopped reply").toEqual([]);
    });

    it("posts no stopped reply while the Checks tab switch is off", async () => {
        setE2eControlChannelActive(false);
        const { reads, posts } = await invalidate(({ generations }) => generations.bumpAuth());
        expect(reads).toEqual([]);
        expect(posts).toEqual([]);
    });
});
