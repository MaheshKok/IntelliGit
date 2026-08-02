/**
 * Matches a Git remote name safe to place as a standalone `git push` argv element.
 *
 * Rejects a leading `-` (which Git would otherwise parse as an option) and any whitespace or
 * control character. Shared by push.ts, which captures a fresh remote name at submission time,
 * and storage.ts, which validates one read back from disk.
 */
export const SAFE_REMOTE_NAME = /^(?!-)[^\s\x00-\x1f]+$/;

/**
 * Matches a fully qualified local branch ref accepted as a force-push destination.
 *
 * Shared by push.ts and storage.ts's manifest schema check.
 */
export const REMOTE_HEAD_REF = /^refs\/heads\/[^^~:\\?*\[\s]+$/;
