/**
 * Returns whether the commit action can run for the current commit-panel state.
 *
 * Amend commits are allowed without staged file selection because the previous
 * commit supplies the target, while normal commits require both a file selection
 * and a non-blank commit message.
 */
export function canRunCommitAction(
    isAmend: boolean,
    checkedFileCount: number,
    commitMessage: string,
): boolean {
    return isAmend || (checkedFileCount > 0 && commitMessage.trim().length > 0);
}
