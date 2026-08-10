import { readFileSync } from "node:fs";

const REGENERATION_COMMAND = "./tests/e2e/docker/run.sh";
const DIGEST_REFERENCE = /^.+@sha256:[0-9a-f]{64}$/;

/** Reads the first non-comment, non-blank line containing the committed base-image pin. */
export function readPinnedBaseImage(pinPath: string): string {
    const pin = readFileSync(pinPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("#"));

    if (pin === undefined) {
        throw new Error(
            `Pinned base image pin not found in ${pinPath}; regenerate through ${REGENERATION_COMMAND}.`,
        );
    }
    return pin;
}

/** Verifies the claimed image shape, pinned identity, and Docker containment for an update. */
export function assertPinnedProvenance(
    baseImage: string | undefined,
    pinnedBaseImage: string,
    inContainer: boolean,
): void {
    if (baseImage === undefined || !DIGEST_REFERENCE.test(baseImage)) {
        throw new Error(
            `INTELLIGIT_BASE_IMAGE shape check failed; it must be a digest reference with 64 lowercase hex characters. ` +
                `Regenerate through ${REGENERATION_COMMAND}.`,
        );
    }
    if (baseImage !== pinnedBaseImage) {
        throw new Error(
            `INTELLIGIT_BASE_IMAGE identity check failed; it does not equal the pinned base image. ` +
                `Regenerate through ${REGENERATION_COMMAND}.`,
        );
    }
    if (!inContainer) {
        throw new Error(
            `/.dockerenv containment check failed; the update is not running in Docker. ` +
                `Regenerate through ${REGENERATION_COMMAND}.`,
        );
    }
}
