import * as path from "path";

/**
 * Detects Windows drive-letter and UNC roots without treating a POSIX root as Windows syntax.
 *
 * This deliberately excludes root-relative Windows paths because repository roots are absolute.
 */
function isWindowsRepositoryRoot(root: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(root) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(root);
}

/**
 * Compares absolute repository roots using the filesystem spelling rules implied by each path.
 *
 * Windows drive and UNC roots are normalized case-insensitively even when tests run on another
 * platform. POSIX roots retain case-sensitive native resolution so distinct repositories are not
 * collapsed merely because their letter case differs.
 */
export function areSameRepositoryRoot(left: string, right: string): boolean {
    const leftIsWindows = isWindowsRepositoryRoot(left);
    const rightIsWindows = isWindowsRepositoryRoot(right);
    if (leftIsWindows || rightIsWindows) {
        return (
            leftIsWindows &&
            rightIsWindows &&
            path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase()
        );
    }
    return path.resolve(left) === path.resolve(right);
}
