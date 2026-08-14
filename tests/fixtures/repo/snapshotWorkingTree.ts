/**
 * Working-tree section (PLAN.md step 9: "tracked + untracked + ignored files, with
 * type/mode/symlink-target/digest per entry").
 *
 * This walks the real filesystem rather than asking Git to classify each file, deliberately: a
 * plain recursive walk of the checkout, excluding only `.git` itself, unconditionally contains
 * every tracked, untracked, *and* ignored file, because none of those three categories is defined
 * by anything other than "a file that exists on disk here." Cross-referencing `git status` to tag
 * each entry would add a second, weaker source of truth (one more command whose flags or output
 * format could be gotten wrong) without strengthening the oracle: the fixture is restored from a
 * contract-checked copy, so the only failure this section needs to catch is "the files on disk
 * changed," and a raw digest walk catches that unconditionally.
 */

import { inventoryDirectory } from "./fsInventory";
import type { FsEntry, Section } from "./snapshotTypes";
import { captured, notCaptured } from "./snapshotTypes";

const GIT_DIR_NAME = ".git";

/**
 * Captures the working tree, or reports `not-captured` for a bare repository, which has none.
 * `isBare` is caller-supplied (from `git rev-parse --is-bare-repository`) rather than re-derived
 * here, so every section of one repository snapshot agrees on the same bareness classification.
 */
export async function snapshotWorkingTree(
    repoRoot: string,
    isBare: boolean,
): Promise<Section<readonly FsEntry[]>> {
    if (isBare) {
        return notCaptured("repository is bare: a bare repository has no working tree to inventory");
    }
    const entries = await inventoryDirectory({
        root: repoRoot,
        exclude: (relativePath) => relativePath === GIT_DIR_NAME,
    });
    return captured(entries);
}
