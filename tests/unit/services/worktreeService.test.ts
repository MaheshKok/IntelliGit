import { describe, expect, it, vi } from "vitest";
import type { GitExecutor } from "../../../src/git/executor";
import { WorktreeService } from "../../../src/services/worktreeService";

vi.mock("vscode", () => {
    class EventEmitter<T> {
        private listeners: Array<(event: T) => void> = [];
        readonly event = (listener: (event: T) => void) => {
            this.listeners.push(listener);
            return { dispose: vi.fn() };
        };
        fire(event: T): void {
            for (const listener of this.listeners) listener(event);
        }
        dispose(): void {
            this.listeners = [];
        }
    }
    return { EventEmitter };
});

function porcelain(branch: string): string {
    return [
        "worktree /repo",
        "HEAD 1111111111111111111111111111111111111111",
        `branch refs/heads/${branch}`,
        "",
    ].join("\0");
}

function createExecutor(outputs: string[]): GitExecutor {
    return {
        run: vi.fn(async () => outputs.shift() ?? porcelain("fallback")),
    } as unknown as GitExecutor;
}

describe("WorktreeService", () => {
    it("caches worktree lists until refresh repulls and emits", async () => {
        const executor = createExecutor([porcelain("main"), porcelain("feature/x")]);
        const service = new WorktreeService(executor, () => "/repo");
        const listener = vi.fn();
        service.onDidChangeWorktrees(listener);

        await expect(service.listWorktrees()).resolves.toMatchObject([{ branch: "main" }]);
        await expect(service.listWorktrees()).resolves.toMatchObject([{ branch: "main" }]);
        expect(executor.run).toHaveBeenCalledTimes(1);

        await expect(service.refresh()).resolves.toMatchObject([{ branch: "feature/x" }]);
        expect(executor.run).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenCalledWith([expect.objectContaining({ branch: "feature/x" })]);
    });
});
