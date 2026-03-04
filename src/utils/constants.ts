// Shared constants used across extension host and webview code.

/**
 * System UI font stack matching native VS Code tree views.
 * Use this for all UI text; use `var(--vscode-editor-font-family)` only for
 * code-specific displays (commit hashes, diffs, etc.).
 */
export const SYSTEM_FONT_STACK =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * SHA1 of git's empty tree object. Used to diff initial commits (no parent)
 * against an empty baseline: `git diff <EMPTY_TREE_HASH> <commit>`.
 */
export const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
