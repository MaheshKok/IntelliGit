import { describe, expect, it } from "vitest";

import { collectCatalogStrings } from "../../../visual/oracles/catalogSources";

describe("collectCatalogStrings", () => {
    it("deduplicates and sorts scalar catalog values", () => {
        expect(
            collectCatalogStrings({ first: "bravo", second: "alpha", duplicate: "bravo" }),
        ).toEqual(["alpha", "bravo"]);
    });

    it("flattens plural catalog values into their variant strings", () => {
        expect(
            collectCatalogStrings({
                fileCount: { one: "1 file", other: "many files" },
            }),
        ).toEqual(["1 file", "many files"]);
    });

    it("excludes scalar and plural values containing interpolation tokens", () => {
        expect(
            collectCatalogStrings({
                branch: "HEAD: {name}",
                plain: "Changes",
                fileCount: { one: "{count} file", other: "Files" },
            }),
        ).toEqual(["Changes", "Files"]);
    });
});
