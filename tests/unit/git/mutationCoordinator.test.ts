import { describe, expect, it } from "vitest";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";

describe("RepositoryMutationCoordinator", () => {
    it("serializes mutations for one repository", async () => {
        const coordinator = new RepositoryMutationCoordinator();
        const order: string[] = [];
        let releaseFirst: (() => void) | undefined;
        const first = coordinator.run("/repo", async () => {
            order.push("first-start");
            await new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
            order.push("first-end");
        });
        const second = coordinator.run("/repo", async () => {
            order.push("second");
        });

        await Promise.resolve();
        expect(order).toEqual(["first-start"]);
        releaseFirst?.();
        await Promise.all([first, second]);
        expect(order).toEqual(["first-start", "first-end", "second"]);
    });

    it("allows different repositories to run concurrently", async () => {
        const coordinator = new RepositoryMutationCoordinator();
        let release: (() => void) | undefined;
        const first = coordinator.run(
            "/one",
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const second = coordinator.run("/two", async () => "parallel");

        await expect(second).resolves.toBe("parallel");
        release?.();
        await first;
    });

    it("keeps caller-provided literal keys separate and removes completed tails", async () => {
        const coordinator = new RepositoryMutationCoordinator();
        const tails = (coordinator as unknown as { tails: Map<string, Promise<void>> }).tails;
        let releaseFirst: (() => void) | undefined;
        const first = coordinator.run(
            "/repo",
            () =>
                new Promise<void>((resolve) => {
                    releaseFirst = resolve;
                }),
        );
        const literalKey = coordinator.run("/repo/.", async () => "completed");

        await expect(literalKey).resolves.toBe("completed");
        expect(tails.has("/repo/.")).toBe(false);
        releaseFirst?.();
        await first;
        expect(tails.size).toBe(0);
    });
});
