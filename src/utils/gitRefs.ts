// Git ref-name validation helpers shared by extension services and GitOps.
// Pure TypeScript implementation of the relevant git-check-ref-format rules.

// Characters forbidden anywhere in a git ref name (excluding control chars
// which are checked separately to avoid embedding literal control characters).
const GIT_REF_INVALID_CHARS = /[ ~^:?*[\]\\]/;

/**
 * Check whether a string contains ASCII control characters (0x00-0x1f, 0x7f).
 * These are invalid in git ref names.
 */
function containsControlChars(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
}

/**
 * Validate a branch name against git check-ref-format rules.
 * Pure JS implementation — does not spawn a subprocess.
 *
 * Rules: https://git-scm.com/docs/git-check-ref-format
 */
export function isValidBranchName(value: string): boolean {
    if (!value || value.length > 255) return false;
    if (value.startsWith("-") || value.startsWith(".")) return false;
    if (value.endsWith(".") || value.endsWith("/") || value.endsWith(".lock")) return false;
    if (value.includes("..") || value.includes("//")) return false;
    if (GIT_REF_INVALID_CHARS.test(value)) return false;
    if (containsControlChars(value)) return false;
    // Only the "@{" sequence is forbidden — bare "@" is a valid ref component.
    if (value.includes("@{")) return false;
    // Each component must not start with '.' or end with '.lock'.
    const segments = value.split("/");
    if (segments.some((seg) => !seg || seg.startsWith(".") || seg.endsWith(".lock"))) return false;
    return true;
}
