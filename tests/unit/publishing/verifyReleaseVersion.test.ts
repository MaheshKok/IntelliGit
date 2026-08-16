import { describe, expect, it } from "vitest";

import {
    assertForwardStableRelease,
    assertSameStableRelease,
    compareStableVersions,
} from "../../../scripts/verifyReleaseVersion.js";

describe("verifyReleaseVersion", () => {
    it.each([
        ["0.25.3", "0.25.4"],
        ["0.25.9", "0.26.0"],
        ["0.99.9", "1.0.0"],
    ])("accepts the forward release transition %s -> %s", (previous, current) => {
        expect(compareStableVersions(previous, current)).toBeLessThan(0);
        expect(() => assertForwardStableRelease(previous, current)).not.toThrow();
    });

    it.each([
        ["0.25.3", "0.25.3"],
        ["0.25.3", "0.25.2"],
        ["1.0.0", "0.99.9"],
    ])("rejects the non-forward release transition %s -> %s", (previous, current) => {
        expect(() => assertForwardStableRelease(previous, current)).toThrow(
            /must be greater than previous version/,
        );
    });

    it.each(["1", "1.2", "v1.2.3", "1.2.3-beta.1", "1.2.3.4", "01.2.3"])(
        "fails closed for unsupported version %s",
        (version) => {
            expect(() => compareStableVersions(version, "2.0.0")).toThrow(
                /stable SemVer/,
            );
        },
    );

    it("allows force-publish recovery only for the same canonical version", () => {
        expect(() => assertSameStableRelease("0.25.3", "0.25.3")).not.toThrow();
        expect(() => assertSameStableRelease("0.25.3", "0.25.4")).toThrow(/must equal/);
        expect(() => assertSameStableRelease("0.25.3", "0.25.2")).toThrow(/must equal/);
        expect(() => assertSameStableRelease("0.25.3", "0.25.3-beta.1")).toThrow(
            /stable SemVer/,
        );
        expect(() =>
            assertSameStableRelease("9007199254740992.0.0", "9007199254740993.0.0"),
        ).toThrow(/must equal/);
    });
});
