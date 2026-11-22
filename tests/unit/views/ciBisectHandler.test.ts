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

describe("answerStartCiBisect invalidation", () => {
    it.each(["repository", "auth", "lifecycle"])(
        "%s change stops later requests as well as replies",
        async (kind) => {
            setE2eControlChannelActive(true);
            let repo = "/repo";
            const generations = new CiGenerations();
            const reads: string[] = [];
            const releases: Array<() => void> = [];
            const posts: unknown[] = [];
            // The first four reads wait; a later one is recorded only if the bisect still sends it.
            const source: CiBisectSource = {
                capabilities: async () => undefined,
                attemptHistory: async () => [],
                getChecks: async (hash, options) => {
                    if (reads.length < 4) {
                        reads.push(`${repo}:${hash}`);
                        await new Promise<void>((resolve) => releases.push(resolve));
                    } else if (options.sendGuard()) {
                        reads.push(`${repo}:${hash}`);
                    }
                    return { hash, state: "success", summary: "", items: [] };
                },
            };
            const running = answerStartCiBisect(
                {
                    repoKey: () => repo,
                    generations,
                    bisect: { source, loaded: () => commits },
                } as never,
                { requestId: 1, repoKey: repo, commits },
                (message) => posts.push(message),
                new CommitCiDetailLoops(),
            );
            await flush();
            expect(reads).toHaveLength(4);
            if (kind === "repository") repo = "/other";
            else if (kind === "auth") generations.bumpAuth();
            else generations.bumpLifecycle();
            for (const release of releases.splice(0)) release();
            await running;
            expect(reads, "no fifth read after invalidation").toHaveLength(4);
            expect(posts).toEqual([]);
        },
    );
});
