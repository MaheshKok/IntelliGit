import { describe, expect, it } from "vitest";
import { containsConflictMarkers } from "../../src/utils/jetbrainsMergeTool";

describe("containsConflictMarkers", () => {
    it("detects a complete conflict marker block", () => {
        expect(
            containsConflictMarkers([
                "before",
                "<<<<<<< HEAD",
                "ours",
                "=======",
                "theirs",
                ">>>>>>> feature",
                "after",
            ].join("\n")),
        ).toBe(true);
    });

    it("detects CRLF conflict marker blocks", () => {
        expect(
            containsConflictMarkers(
                ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feature"].join("\r\n"),
            ),
        ).toBe(true);
    });

    it("rejects incomplete or out-of-order conflict markers", () => {
        expect(containsConflictMarkers("<<<<<<< HEAD\nours\n=======\nstill missing end\n")).toBe(
            false,
        );
        expect(containsConflictMarkers(">>>>>>> feature\n=======\n<<<<<<< HEAD\n")).toBe(false);
    });

    it("handles large non-conflicted content without reporting a conflict", () => {
        const largeContent = Array.from({ length: 20_000 }, (_, index) => {
            if (index === 100) return "<<<<<<< not a complete conflict";
            if (index === 10_000) return "regular content separator ======= inline";
            return `line ${index}`;
        }).join("\n");

        expect(containsConflictMarkers(largeContent)).toBe(false);
    });
});
