/**
 * Index section (PLAN.md step 9: "Index, including flags and unmerged stages -- not merely
 * `git ls-files`").
 *
 * Two commands, merged by path:
 * - `git ls-files --stage -z` is authoritative for mode, object id, and stage. An unmerged path
 *   surfaces as three entries sharing one path, at stages 1/2/3 (ours/theirs/base) -- confirmed
 *   empirically against a real conflicted merge before this was written.
 * - `git ls-files -v -z` reports one status letter per record: uppercase for a plain state,
 *   lowercase when assume-unchanged is set (`git help ls-files`); `S`/`s` additionally marks
 *   skip-worktree; `M`/`m` marks unmerged. Confirmed empirically that an unmerged path emits
 *   *three* identical `-v` records (one per stage, matching `--stage`'s three rows for that path)
 *   rather than one -- so `parseFlagRecords` below keys its map by path and lets the later,
 *   identical-valued writes for stages 2 and 3 harmlessly overwrite the first; nothing here
 *   assumes a 1:1 line-to-path relationship. This is the "flags" half of the bullet, read from
 *   git's own classification rather than re-deriving it from the index's raw internal bit layout,
 *   which is git-version implementation detail this suite has no interest in pinning.
 *
 * Runs against a bare repository too: confirmed empirically that both commands exit 0 there
 * (there may simply be no index file yet), so a bare repo's index is captured, genuinely empty --
 * never `not-captured`.
 */

import { runGitRaw, splitNulRecords } from "./gitRun";
import type { IndexEntry, Section } from "./snapshotTypes";
import { captured } from "./snapshotTypes";

/** `git ls-files --stage` reports these three stage numbers for an unmerged path. */
const VALID_STAGES: ReadonlySet<number> = new Set([0, 1, 2, 3]);

export async function snapshotIndex(
    repoRoot: string,
    env: NodeJS.ProcessEnv,
): Promise<Section<readonly IndexEntry[]>> {
    const [stageRecords, flagRecords] = await Promise.all([
        runGitRaw(repoRoot, ["ls-files", "--stage", "-z"], env),
        runGitRaw(repoRoot, ["ls-files", "-v", "-z"], env),
    ]);
    const flagByPath = parseFlagRecords(flagRecords);
    const entries = splitNulRecords(stageRecords).map((record) => parseStageRecord(record, flagByPath));
    return captured(entries.sort((a, b) => compareCodepoints(a.path, b.path) || a.stage - b.stage));
}

/** Plain UTF-16-code-unit ordering, not `localeCompare` -- see `fsInventory.ts`'s `compareCodepoints`
 * for why: this repo's default locale demonstrably reorders real fixture names relative to
 * codepoint order, which would make a cross-machine snapshot comparison spuriously diverge. */
function compareCodepoints(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

function parseFlagRecords(raw: string): ReadonlyMap<string, string> {
    const flagByPath = new Map<string, string>();
    for (const record of splitNulRecords(raw)) {
        const separatorIndex = record.indexOf(" ");
        if (separatorIndex === -1) {
            throw new Error(`snapshotIndex: malformed "ls-files -v" record: ${JSON.stringify(record)}`);
        }
        const flag = record.slice(0, separatorIndex);
        const path = record.slice(separatorIndex + 1);
        flagByPath.set(path, flag);
    }
    return flagByPath;
}

function parseStageRecord(record: string, flagByPath: ReadonlyMap<string, string>): IndexEntry {
    const tabIndex = record.indexOf("\t");
    if (tabIndex === -1) {
        throw new Error(`snapshotIndex: malformed "ls-files --stage" record: ${JSON.stringify(record)}`);
    }
    const path = record.slice(tabIndex + 1);
    const [mode, objectId, stageText] = record.slice(0, tabIndex).split(" ");
    const stage = Number(stageText);
    if (!mode || !objectId || !VALID_STAGES.has(stage)) {
        throw new Error(`snapshotIndex: malformed "ls-files --stage" record: ${JSON.stringify(record)}`);
    }
    const flag = flagByPath.get(path);
    if (flag === undefined) {
        throw new Error(`snapshotIndex: "ls-files -v" reported no flag for staged path ${path}`);
    }
    return { path, stage: stage as 0 | 1 | 2 | 3, mode, objectId, flag };
}
