// The owner dropped the blame phrase of the flaky line ("→ likely not yours", #453): no catalog
// of the webview and no row of the translation review CSV may still carry it, in any language.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const CATALOGS = join(ROOT, "src/webviews/i18n");
const KEY = "commit.checks.bisect.flakyNote";

describe("the bisect's flaky note", () => {
    const files = readdirSync(CATALOGS).filter((name) => name.endsWith(".json"));

    it("is found in every catalog", () => {
        expect(files.length, "the catalog folder was read").toBeGreaterThan(1);
    });

    it.each(files)("%s says what was seen, with no verdict on whose fault it is", (file) => {
        const catalog = JSON.parse(readFileSync(join(CATALOGS, file), "utf8")) as Record<
            string,
            string
        >;
        expect(catalog[KEY], `${file} has the key`).toBeTypeOf("string");
        // The phrase followed an arrow in every language.
        expect(catalog[KEY], `${file} keeps no "→ ..." verdict`).not.toContain("→");
    });

    it("is plain in English", () => {
        const en = JSON.parse(readFileSync(join(CATALOGS, "en.json"), "utf8")) as Record<
            string,
            string
        >;
        expect(en[KEY]).toBe("flaky: {n} red in {m}, no run of red");
    });

    // The Russian catalog said the same thing in words: "не ваша вина" (not your fault).
    it("has no translated blame verdict in Russian", () => {
        const ru = JSON.parse(readFileSync(join(CATALOGS, "ru.json"), "utf8")) as Record<
            string,
            string
        >;
        expect(ru[KEY]).toBe("нестабильный: красных {n} из {m}, нет серии красных");
    });

    it("has no translated blame verdict in the CSV's Russian column", () => {
        const csv = readFileSync(
            join(ROOT, "docs/localization/localization_translation_review.csv"),
            "utf8",
        );
        const row = csv.split("\n").find((line) => line.includes(KEY)) ?? "";
        expect(row).not.toContain("не ваша вина");
        expect(row).toContain('"нестабильный: красных {n} из {m}, нет серии красных"');
    });

    it("has no verdict in the translation review CSV", () => {
        const csv = readFileSync(
            join(ROOT, "docs/localization/localization_translation_review.csv"),
            "utf8",
        );
        const rows = csv.split("\n").filter((row) => row.includes(KEY));
        expect(rows, "the CSV has the key's row").toHaveLength(1);
        expect(rows[0], "the row keeps no arrow verdict").not.toContain("→");
    });
});
