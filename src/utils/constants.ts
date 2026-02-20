// Shared constants used across extension host and webview code.

/**
 * System UI font stack matching native VS Code tree views.
 * Use this for all UI text; use `var(--vscode-editor-font-family)` only for
 * code-specific displays (commit hashes, diffs, etc.).
 */
export const SYSTEM_FONT_STACK =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
