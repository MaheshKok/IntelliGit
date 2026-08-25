import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BASELINE_PLATFORM } from "../../../visual/oracles/findingsBaselineFile";
import {
    assertPinnedProvenance,
    checkPinnedProvenance,
    readPinnedBaseImage,
} from "../../../visual/oracles/pinnedBaseImage";
import { removeScratchDirectoriesSync } from "../../../helpers/scratchDirectories";

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
            removeScratchDirectoriesSync(directory);
        }
    });

    it("throws a named error when the pin has no digest line", () => {
        const directory = mkdtempSync(join(tmpdir(), "intelligit-pinned-image-"));
        const pinPath = join(directory, "base-image.txt");
        try {
            writeFileSync(pinPath, "# comment\n\n", "utf8");

            expect(() => readPinnedBaseImage(pinPath)).toThrow("Pinned base image pin not found");
        } finally {
            removeScratchDirectoriesSync(directory);
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

    it("reports provenance failures without throwing for compare callers", () => {
        expect(checkPinnedProvenance(undefined, validDigest, true)).toEqual({
            kind: "unpinned",
            reason:
                "INTELLIGIT_BASE_IMAGE shape check failed; it must be a digest reference with 64 lowercase hex characters. " +
                "Regenerate through ./tests/e2e/docker/run.sh.",
        });
        expect(checkPinnedProvenance(`repo@sha256:${"b".repeat(64)}`, validDigest, true)).toEqual({
            kind: "unpinned",
            reason:
                "INTELLIGIT_BASE_IMAGE identity check failed; it does not equal the pinned base image. " +
                "Regenerate through ./tests/e2e/docker/run.sh.",
        });
        expect(checkPinnedProvenance(validDigest, validDigest, false)).toEqual({
            kind: "unpinned",
            reason:
                "/.dockerenv containment check failed; the update is not running in Docker. " +
                "Regenerate through ./tests/e2e/docker/run.sh.",
        });
    });

    it("reports pinned provenance when every fact is satisfied", () => {
        expect(checkPinnedProvenance(validDigest, validDigest, true)).toEqual({ kind: "pinned" });
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
