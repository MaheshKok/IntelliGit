import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BASELINE_PLATFORM } from "../../../visual/oracles/findingsBaselineFile";
import {
    assertPinnedProvenance,
    readPinnedBaseImage,
} from "../../../visual/oracles/pinnedBaseImage";

const PIN_PATH = resolve(__dirname, "../../../e2e/docker/base-image.txt");
const ENVIRONMENT_PATH = resolve(__dirname, "../../../visual/fixtures/baselineEnvironment.json");
const validDigest = `repo@sha256:${"a".repeat(64)}`;

describe("pinned base image oracle", () => {
    it("reads the first non-comment, non-blank pin line", () => {
        const directory = mkdtempSync(join(tmpdir(), "intelligit-pinned-image-"));
        const pinPath = join(directory, "base-image.txt");
        try {
            writeFileSync(pinPath, `${validDigest}\n# ignored\n  decoy  \n`, "utf8");

            expect(readPinnedBaseImage(pinPath)).toBe(validDigest);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("throws a named error when the pin has no digest line", () => {
        const directory = mkdtempSync(join(tmpdir(), "intelligit-pinned-image-"));
        const pinPath = join(directory, "base-image.txt");
        try {
            writeFileSync(pinPath, "# comment\n\n", "utf8");

            expect(() => readPinnedBaseImage(pinPath)).toThrow("Pinned base image pin not found");
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("rejects an unshaped base-image claim", () => {
        expect(() => assertPinnedProvenance("whatever", validDigest, true)).toThrow(
            "shape check failed",
        );
    });

    it("rejects a digest that is not the committed pin", () => {
        expect(() =>
            assertPinnedProvenance(`repo@sha256:${"b".repeat(64)}`, validDigest, true),
        ).toThrow("identity check failed");
    });

    it("rejects a valid claim outside the pinned container", () => {
        expect(() => assertPinnedProvenance(validDigest, validDigest, false)).toThrow(
            "containment check failed",
        );
    });

    it("cross-checks the committed artifact against the real pin", () => {
        const pinnedBaseImage = readPinnedBaseImage(PIN_PATH);
        const artifact: {
            readonly baseImage: string;
            readonly platform: string;
            readonly fonts: readonly string[];
        } = JSON.parse(readFileSync(ENVIRONMENT_PATH, "utf8")) as {
            readonly baseImage: string;
            readonly platform: string;
            readonly fonts: readonly string[];
        };

        expect(artifact.baseImage).toBe(pinnedBaseImage);
        expect(artifact.platform).toBe(BASELINE_PLATFORM);
        expect(artifact.fonts.length).toBeGreaterThan(0);
    });
});
