/**
 * Classifies why a computed accessible name fails to match its intended source text.
 *
 * The oracle normalizes both strings before reporting an empty name, a strict-prefix
 * or ellipsis truncation, or a non-truncation mismatch.
 */
export type AccessibleNameFailureKind = "empty-name" | "truncated-name" | "name-mismatch";

/**
 * Pairs an observed accessibility-tree name with the full text it should convey.
 *
 * The oracle copies `id` to any resulting violation and normalizes both name values
 * before comparing them.
 */
export interface AccessibleNameSample {
    readonly id: string;
    /** The accessibility-tree computed name, whatever its source. */
    readonly computedName: string;
    /** The untruncated string the UI intended to convey. */
    readonly sourceText: string;
}

/**
 * Identifies one sample whose computed accessible name does not satisfy the oracle.
 *
 * `kind` preserves the classification produced after normalization, while `id`
 * identifies the input sample that needs investigation.
 */
export interface AccessibleNameViolation {
    readonly id: string;
    readonly kind: AccessibleNameFailureKind;
}

function normalizeName(value: string): string {
    return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function isStrictPrefix(prefix: string, value: string): boolean {
    return prefix.length < value.length && value.startsWith(prefix);
}

function isEllipsisTruncation(computedName: string, sourceText: string): boolean {
    if (computedName.endsWith("…")) {
        return isStrictPrefix(computedName.slice(0, -1).trimEnd(), sourceText);
    }
    if (computedName.endsWith("...")) {
        return isStrictPrefix(computedName.slice(0, -3).trimEnd(), sourceText);
    }
    return false;
}

/** Compares normalized accessibility names with the full text the UI intended to convey. */
export function findAccessibleNameViolations(
    samples: readonly AccessibleNameSample[],
): readonly AccessibleNameViolation[] {
    const violations: AccessibleNameViolation[] = [];

    samples.forEach((sample) => {
        const computedName = normalizeName(sample.computedName);
        const sourceText = normalizeName(sample.sourceText);

        if (computedName.length === 0 && sourceText.length > 0) {
            violations.push({ id: sample.id, kind: "empty-name" });
            return;
        }
        if (computedName === sourceText) {
            return;
        }
        if (
            isStrictPrefix(computedName, sourceText) ||
            isEllipsisTruncation(computedName, sourceText)
        ) {
            violations.push({ id: sample.id, kind: "truncated-name" });
            return;
        }
        violations.push({ id: sample.id, kind: "name-mismatch" });
    });

    return violations;
}
