import { describe, expect, it, vi } from "vitest";
import { PartialChanges } from "../../../src/git/partialChanges";
import type { GitExecutor } from "../../../src/git/executor";
import type { PartialFileSnapshot } from "../../../src/git/partialSnapshot";

describe("snapshot-bound amend message", () => {
    it.each([false, true])(
        "bounds its immutable commit read and ignores truncated text (truncated=%s)",
        async (truncated) => {
            const runBinary = vi.fn(async () => ({
                stdout: Buffer.from(" Original message\n"),
                truncated,
            }));
            const partial = new PartialChanges({ runBinary } as unknown as GitExecutor, "/repo");
            const sha = "a".repeat(40);
            vi.spyOn(partial, "snapshot").mockReturnValue({ head: sha } as PartialFileSnapshot);
            expect(await partial.readCommitMessage("owned")).toBe(
                truncated ? "" : "Original message",
            );
            expect(runBinary).toHaveBeenCalledWith(
                ["-c", "i18n.logOutputEncoding=UTF-8", "show", "-s", "--format=%B", sha],
                expect.objectContaining({ maxOutputBytes: 256 * 1024 }),
            );
        },
    );

    it("does not read an arbitrary commit supplied as a snapshot identifier", async () => {
        const runBinary = vi.fn();
        const partial = new PartialChanges({ runBinary } as unknown as GitExecutor, "/repo");
        await expect(partial.readCommitMessage("b".repeat(40))).rejects.toThrow("expired");
        expect(runBinary).not.toHaveBeenCalled();
    });
});
