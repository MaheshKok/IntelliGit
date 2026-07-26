import { describe, expect, it, vi } from "vitest";
import { logShelfOperation, logShelfWarning } from "../../../src/services/shelfObservability";

describe("shelf observability", () => {
    it("logs a one-line safe operation summary without patch bytes", () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        logShelfOperation(
            { operation: "unshelve", repositoryRoot: "/repo" },
            {
                status: "partial",
                shelfId: "shelf-1",
                newGeneration: 2,
                entries: [
                    { kind: "applied", changeId: "one" },
                    {
                        kind: "structuralPending",
                        changeId: "two",
                        reason: "choice",
                        path: "a.txt",
                        pathFingerprint: "fingerprint",
                    },
                ],
            },
        );
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining(
                "operation=unshelve repository=/repo status=partial shelfId=shelf-1 generation=2 entries=applied:1,structuralPending:1 structuralPending=a.txt",
            ),
        );
        expect(warning.mock.calls.flat().join(" ")).not.toContain("Buffer");
        warning.mockRestore();
    });

    it("falls back to a sanitized warning when VS Code is unavailable", () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        logShelfWarning("resume", new Error("bad\nmessage"));
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("[Shelf] resume: bad message"),
        );
        warning.mockRestore();
    });
});
