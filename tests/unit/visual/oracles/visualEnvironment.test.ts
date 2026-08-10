import { describe, expect, it } from "vitest";

import {
    BASELINE_ENVIRONMENT_FILE,
    VISUAL_ENVIRONMENT_FIELDS,
    describeEnvironmentDrift,
    diffEnvironment,
    normalizeEnvironment,
    type VisualEnvironment,
} from "../../../visual/oracles/visualEnvironment";

const baseEnvironment: VisualEnvironment = {
    baseImage: "mcr.microsoft.com/playwright@sha256:abc123",
    browserVersion: "139.0.7258.5",
    platform: "linux-x64",
    osRelease: "6.12.0",
    fonts: ["Arial", "Noto Sans"],
};

const changedValues: { [Field in keyof VisualEnvironment]: VisualEnvironment[Field] } = {
    baseImage: "mcr.microsoft.com/playwright@sha256:def456",
    browserVersion: "140.0.7339.1",
    platform: "darwin-arm64",
    osRelease: "24.6.0",
    fonts: ["Changed Font", "Noto Sans"],
};

const rawCaptureEnvironment = {
    baseImage: "",
    browserVersion: "",
    platform: "",
    osRelease: "",
    fonts: [] as readonly string[],
};

function environmentWithChange(field: keyof VisualEnvironment): VisualEnvironment {
    const observed = { ...baseEnvironment } as {
        -readonly [Field in keyof VisualEnvironment]: VisualEnvironment[Field];
    };
    Object.assign(observed, { [field]: changedValues[field] });
    return observed;
}

describe("visual environment", () => {
    it("normalizes fonts without mutating the input", () => {
        const raw: VisualEnvironment = {
            ...baseEnvironment,
            fonts: ["Noto Sans", "Arial", "Noto Sans"],
        };

        const normalized = normalizeEnvironment(raw);

        expect(normalized).toEqual({ ...raw, fonts: ["Arial", "Noto Sans"] });
        expect(normalized).not.toBe(raw);
        expect(normalized.fonts).not.toBe(raw.fonts);
        expect(raw.fonts).toEqual(["Noto Sans", "Arial", "Noto Sans"]);
    });

    it("returns no differences for identical environments", () => {
        expect(diffEnvironment(baseEnvironment, baseEnvironment)).toEqual([]);
    });

    it("keeps the table aligned with raw capture fields and comparison policy", () => {
        // Widened deliberately: this assertion compares the table against `Object.keys`, so both
        // sides must be plain strings for the set equality to run in both directions.
        const tableFields: readonly string[] = VISUAL_ENVIRONMENT_FIELDS.map(
            ({ field }) => field,
        ).sort();
        const rawFields = Object.keys(rawCaptureEnvironment).sort();
        const comparedFields = VISUAL_ENVIRONMENT_FIELDS.filter(({ compared }) => compared)
            .map(({ field }) => field)
            .sort();
        const uncomparedFields = VISUAL_ENVIRONMENT_FIELDS.filter(({ compared }) => !compared)
            .map(({ field }) => field)
            .sort();

        expect(tableFields.filter((field) => !rawFields.includes(field))).toEqual([]);
        expect(rawFields.filter((field) => !tableFields.includes(field))).toEqual([]);
        expect(comparedFields).toEqual(["baseImage", "browserVersion", "fonts", "platform"]);
        expect(uncomparedFields).toEqual(["osRelease"]);
        expect(comparedFields.filter((field) => uncomparedFields.includes(field))).toEqual([]);
        expect(uncomparedFields.filter((field) => comparedFields.includes(field))).toEqual([]);
    });

    for (const { field, compared } of VISUAL_ENVIRONMENT_FIELDS) {
        if (!compared) continue;

        it(`reports a difference for ${field} alone`, () => {
            const differences = diffEnvironment(baseEnvironment, environmentWithChange(field));

            expect(differences).toHaveLength(1);
            expect(differences[0]?.field).toBe(field);
        });
    }

    it("does not compare the host kernel release", () => {
        expect(diffEnvironment(baseEnvironment, environmentWithChange("osRelease"))).toEqual([]);
    });

    it("rejects unknown fields instead of silently dropping them", () => {
        const raw = { ...baseEnvironment, gpuVendor: "llvmpipe" };

        expect(() => normalizeEnvironment(raw)).toThrow(
            "visual environment received unknown field(s): gpuVendor. " +
                "Known fields: baseImage, browserVersion, platform, osRelease, fonts.",
        );
    });

    it("summarizes a font-set difference instead of dumping every family", () => {
        const committedFonts = Array.from({ length: 200 }, (_, index) => `Committed Font ${index}`);
        const observedFonts = [...committedFonts.slice(1), "Changed Font"];
        const differences = diffEnvironment(
            { ...baseEnvironment, fonts: committedFonts },
            { ...baseEnvironment, fonts: observedFonts },
        );

        expect(differences).toHaveLength(1);
        expect(differences[0]?.field).toBe("fonts");
        expect(differences[0]?.committed).toMatch(/200 families/);
        expect(differences[0]?.observed).toMatch(/200 families/);
        expect(`${differences[0]?.committed} ${differences[0]?.observed}`).toContain(
            "Changed Font",
        );
        expect(differences[0]?.committed).toContain("Committed Font 0");
        expect(differences[0]?.observed).toContain("Changed Font");
        expect(differences[0]?.observed).not.toContain("removed ");
        expect(
            `${differences[0]?.committed} ${differences[0]?.observed}`.match(/removed 1:/g),
        ).toHaveLength(1);
        expect(
            `${differences[0]?.committed} ${differences[0]?.observed}`.match(/added 1:/g),
        ).toHaveLength(1);
        expect(`${differences[0]?.committed} ${differences[0]?.observed}`).not.toContain(
            "Committed Font 199",
        );
    });

    it("describes drift with the pinned regeneration command", () => {
        const message = describeEnvironmentDrift([
            { field: "browserVersion", committed: "old", observed: "new" },
        ]);

        expect(message).toContain("browserVersion");
        expect(message).toContain(
            "./tests/e2e/docker/run.sh 'bun install --frozen-lockfile && bun run build && UPDATE_VISUAL_BASELINE=1 npx playwright test --config playwright.visual.config.ts --workers=1'",
        );
    });

    it("treats the outside-container sentinel as drift from a real digest", () => {
        const differences = diffEnvironment(baseEnvironment, {
            ...baseEnvironment,
            baseImage: "<not-in-container>",
        });

        expect(differences).toHaveLength(1);
        expect(describeEnvironmentDrift(differences)).toContain("<not-in-container>");
        expect(BASELINE_ENVIRONMENT_FILE).toBe("tests/visual/fixtures/baselineEnvironment.json");
    });
});
