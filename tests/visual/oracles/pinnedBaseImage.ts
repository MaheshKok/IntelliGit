import { readFileSync } from "node:fs";

const REGENERATION_COMMAND = "./tests/e2e/docker/run.sh";
const DIGEST_REFERENCE = /^.+@sha256:[0-9a-f]{64}$/;

/** Result of checking whether the renderer can be trusted as the reviewed baseline source. */
export type ProvenanceResult =
    | { readonly kind: "pinned" }
    | { readonly kind: "unpinned"; readonly reason: string };

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

/** Checks the facts that tie a self-reported image claim to the reviewed Docker pin. */
export function checkPinnedProvenance(
    baseImage: string | undefined,
    pinnedBaseImage: string,
    inContainer: boolean,
): ProvenanceResult {
    if (baseImage === undefined || !DIGEST_REFERENCE.test(baseImage)) {
        return {
            kind: "unpinned",
            reason:
                `INTELLIGIT_BASE_IMAGE shape check failed; it must be a digest reference with 64 lowercase hex characters. ` +
                `Regenerate through ${REGENERATION_COMMAND}.`,
        };
    }
    if (baseImage !== pinnedBaseImage) {
        return {
            kind: "unpinned",
            reason:
                `INTELLIGIT_BASE_IMAGE identity check failed; it does not equal the pinned base image. ` +
                `Regenerate through ${REGENERATION_COMMAND}.`,
        };
    }
    if (!inContainer) {
        return {
            kind: "unpinned",
            reason:
                `/.dockerenv containment check failed; the update is not running in Docker. ` +
                `Regenerate through ${REGENERATION_COMMAND}.`,
        };
    }
    return { kind: "pinned" };
}

/** Preserves the strict update failure mode over the shared non-throwing provenance check. */
export function assertPinnedProvenance(
    baseImage: string | undefined,
    pinnedBaseImage: string,
    inContainer: boolean,
): void {
    const result = checkPinnedProvenance(baseImage, pinnedBaseImage, inContainer);
    if (result.kind === "unpinned") throw new Error(result.reason);
}
