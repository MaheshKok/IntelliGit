import type {
    InteractiveRebaseRangeCommit,
    RebaseAction,
    RebaseTodoEntry,
} from "../../../../protocol/commitGraphTypes";
import type { RebaseEntryMutation } from "./types";

const EMPTY_EDITED_MESSAGES: ReadonlySet<string> = new Set();

/** Creates the default pick entries in the host's oldest-first todo order. */
export function createRebaseEntries(
    commits: readonly InteractiveRebaseRangeCommit[],
): readonly RebaseTodoEntry[] {
    return commits.map(({ hash }) => ({ hash, action: "pick" }));
}

/** Applies an action change and recomputes any unedited reword or squash message drafts. */
export function changeRebaseAction(
    entries: readonly RebaseTodoEntry[],
    commits: readonly InteractiveRebaseRangeCommit[],
    hash: string,
    action: RebaseAction,
    editedMessageHashes: ReadonlySet<string> = EMPTY_EDITED_MESSAGES,
): RebaseEntryMutation {
    if (!entries.some((entry) => entry.hash === hash)) {
        return { entries, firstActionCleared: false };
    }
    return recomputeRebaseMessages(
        entries.map((entry) => (entry.hash === hash ? { hash: entry.hash, action } : entry)),
        commits,
        editedMessageHashes,
    );
}

/** Replaces an existing reword or squash message without mutating the entry array. */
export function changeRebaseMessage(
    entries: readonly RebaseTodoEntry[],
    hash: string,
    message: string,
): readonly RebaseTodoEntry[] {
    return entries.map((entry) => (entry.hash === hash ? { ...entry, message } : entry));
}

/** Moves a todo entry one position in the requested direction. */
export function moveRebaseEntry(
    entries: readonly RebaseTodoEntry[],
    hash: string,
    direction: "up" | "down",
    commits?: readonly InteractiveRebaseRangeCommit[],
    editedMessageHashes: ReadonlySet<string> = EMPTY_EDITED_MESSAGES,
): RebaseEntryMutation {
    const source = entries.findIndex((entry) => entry.hash === hash);
    const target = source + (direction === "up" ? -1 : 1);
    return target < 0 || target >= entries.length
        ? { entries, firstActionCleared: false }
        : reorderAt(entries, source, target, commits, editedMessageHashes);
}

/** Moves one entry before another entry, as used by the native HTML drag-and-drop interaction. */
export function reorderRebaseEntries(
    entries: readonly RebaseTodoEntry[],
    sourceHash: string,
    targetHash: string,
    commits?: readonly InteractiveRebaseRangeCommit[],
    editedMessageHashes: ReadonlySet<string> = EMPTY_EDITED_MESSAGES,
): RebaseEntryMutation {
    const source = entries.findIndex((entry) => entry.hash === sourceHash);
    const target = entries.findIndex((entry) => entry.hash === targetHash);
    return source < 0 || target < 0 || source === target
        ? { entries, firstActionCleared: false }
        : reorderAt(entries, source, target, commits, editedMessageHashes);
}

function reorderAt(
    entries: readonly RebaseTodoEntry[],
    source: number,
    target: number,
    commits?: readonly InteractiveRebaseRangeCommit[],
    editedMessageHashes: ReadonlySet<string> = EMPTY_EDITED_MESSAGES,
): RebaseEntryMutation {
    const next = [...entries];
    const [entry] = next.splice(source, 1);
    next.splice(target, 0, entry);
    return commits
        ? recomputeRebaseMessages(next, commits, editedMessageHashes)
        : normalizeFirstActive(next);
}

function recomputeRebaseMessages(
    entries: readonly RebaseTodoEntry[],
    commits: readonly InteractiveRebaseRangeCommit[],
    editedMessageHashes: ReadonlySet<string>,
): RebaseEntryMutation {
    const normalized = normalizeFirstActive(entries);
    const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
    const recomputed: RebaseTodoEntry[] = [];

    for (const entry of normalized.entries) {
        const commit = commitsByHash.get(entry.hash);
        if (!commit || editedMessageHashes.has(entry.hash)) {
            recomputed.push(entry);
            continue;
        }
        if (entry.action === "reword") {
            recomputed.push({ hash: entry.hash, action: entry.action, message: commit.body });
            continue;
        }
        if (entry.action === "squash") {
            const target = [...recomputed]
                .reverse()
                .find(
                    (candidate) =>
                        candidate.action === "pick" ||
                        candidate.action === "reword" ||
                        candidate.action === "squash",
                );
            const targetCommit = target ? commitsByHash.get(target.hash) : undefined;
            recomputed.push({
                hash: entry.hash,
                action: entry.action,
                message:
                    target && targetCommit
                        ? `${target.message ?? targetCommit.body}\n\n${commit.body}`
                        : commit.body,
            });
            continue;
        }
        recomputed.push({ hash: entry.hash, action: entry.action });
    }

    return { entries: recomputed, firstActionCleared: normalized.firstActionCleared };
}

function normalizeFirstActive(entries: readonly RebaseTodoEntry[]): RebaseEntryMutation {
    const firstActive = entries.findIndex((entry) => entry.action !== "drop");
    if (
        firstActive < 0 ||
        (entries[firstActive].action !== "squash" && entries[firstActive].action !== "fixup")
    ) {
        return { entries, firstActionCleared: false };
    }
    return {
        entries: entries.map((entry, index) =>
            index === firstActive ? { hash: entry.hash, action: "pick" } : entry,
        ),
        firstActionCleared: true,
    };
}
