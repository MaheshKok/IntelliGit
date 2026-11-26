// The bisect's result text is "broke at ..." or "no break point"; the flaky tag beside it carries
// the flaky count. The owner dropped the blame phrase of the old flaky line ("→ likely not yours",
// #453), and the line itself went with the result text: no catalog of the webview and no row of the
// translation review CSV may still carry it, in any language.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const CATALOGS = join(ROOT, "src/webviews/i18n");
const KEY = "commit.checks.bisect.flakyNote";

describe("the bisect's retired flaky note", () => {
    const files = readdirSync(CATALOGS).filter((name) => name.endsWith(".json"));

    it("finds the catalogs", () => {
        expect(files.length, "the catalog folder was read").toBeGreaterThan(1);
    });

    it.each(files)("%s no longer carries the key", (file) => {
        const catalog = JSON.parse(readFileSync(join(CATALOGS, file), "utf8")) as Record<
            string,
            string
        >;
        expect(catalog[KEY], `${file} has no note the view never shows`).toBeUndefined();
    });

    it("has no row in the translation review CSV", () => {
        const csv = readFileSync(
            join(ROOT, "docs/localization/localization_translation_review.csv"),
            "utf8",
        );
        expect(csv.split("\n").filter((row) => row.includes(KEY))).toEqual([]);
    });
});
