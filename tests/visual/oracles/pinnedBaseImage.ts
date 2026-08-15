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

/**
 * Checks the facts that tie a self-reported image claim to the reviewed Docker pin.
 *
 * What this establishes, precisely: the container DECLARES it was built from the reviewed pin. It
 * is not an attestation and cannot become one from in here. `INTELLIGIT_BASE_IMAGE` is an ordinary
 * environment variable, so `docker run -e INTELLIGIT_BASE_IMAGE=<the pin> <any image>` satisfies
 * every check below, and `/.dockerenv` proves only that something is a container. Docker exposes no
 * trustworthy image identity to the process it runs; any value re-derived inside the container is
 * forgeable by whoever controls the container.
 *
 * That limit is acceptable because of what this gate is actually for: stopping baselines from being
 * generated on the WRONG renderer by accident -- a stale image, a host-side run, a rebuild that
 * silently moved. Against accident it is exact, because the honest paths all set the variable from
 * the same build argument that feeds `FROM` (see tests/e2e/docker/Dockerfile) and a stale image
 * therefore carries a stale digest and fails the identity check.
 *
 * It is deliberately NOT hardened against a malicious operator, because that threat model does not
 * close: anyone able to forge this variable can also just commit poisoned baseline PNGs directly,
 * which is strictly easier and which no in-repo check can prevent. Real attestation would have to
 * come from a trusted boundary outside the pull request -- a protected CI workflow that resolves
 * the image identity itself -- and would still not address the commit-the-PNGs path.
 */
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
