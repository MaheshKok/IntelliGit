/**
 * Duplicate-post detection for outgoing webview messages.
 *
 * `CommitInfoViewProvider.setCommitDetail` and its three siblings
 * (`CommitGraphViewProvider.setCommitDetail`, `CommitPanelViewProvider.setCommitDetail`,
 * `UndockedViewProvider.setCommitDetail`) post a raw commit detail immediately, then post again,
 * unconditionally, once async icon-theme decoration settles. When no icon resolver is attached, or
 * decoration otherwise changes nothing, that second post is byte-identical to the first.
 *
 * The comparison here is deliberately the fully-built OUTGOING payload, not the commit detail or
 * the decoration result alone: `IconThemeService.decorateCommitDetailWithFolderIcons` awaits
 * `initIconThemeData()` before decorating, which can populate `folderIcon` / `folderExpandedIcon` /
 * `iconFonts` for the first time between the two posts -- those fields come from
 * `IconThemeService.getThemeData()` at post time, not from the decoration result, so a guard keyed
 * on "did decoration change the detail" would silently drop that legitimately new theme data.
 */

/** Serializes an outgoing webview payload for duplicate detection. */
export function serializeWebviewPayload(payload: unknown): string {
    return JSON.stringify(payload);
}

/**
 * True when this payload is byte-identical to the last one actually posted.
 * `lastPosted === undefined` means nothing has been posted to the CURRENT
 * webview, so the payload must always be sent -- otherwise view restoration
 * renders an empty pane.
 */
export function isRedundantPost(serialized: string, lastPosted: string | undefined): boolean {
    if (lastPosted === undefined) return false;
    return serialized === lastPosted;
}
