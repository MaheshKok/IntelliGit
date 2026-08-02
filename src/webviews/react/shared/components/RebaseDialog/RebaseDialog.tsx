import React, { memo, useCallback, useRef, useState } from "react";
import { Box, Button, Flex } from "@chakra-ui/react";
import type {
    InteractiveRebaseRangeCommit,
    RebaseAction,
    RebaseTodoEntry,
} from "../../../../protocol/commitGraphTypes";
import { t } from "../../i18n";
import { formatDateTime } from "../../date";
import {
    restoreShelfDialogFocus,
    useShelfDialogFocus,
} from "../../../commit-panel/components/ShelfDialogFocus";
import {
    changeRebaseAction,
    changeRebaseMessage,
    createRebaseEntries,
    moveRebaseEntry,
    reorderRebaseEntries,
} from "./rebaseDialogState";
import type { RebaseDialogProps, RebaseEntryMutation } from "./types";
import "./RebaseDialog.css";

const ACTIONS: readonly RebaseAction[] = ["pick", "reword", "squash", "fixup", "drop"];

/** Props-only editor for an offered interactive-rebase todo range. */
export function RebaseDialog({
    commits,
    returnFocusTarget,
    onCancel,
    onSubmit,
}: RebaseDialogProps): React.ReactElement {
    const cancelRef = useRef<HTMLButtonElement>(null);
    useShelfDialogFocus(returnFocusTarget, cancelRef);
    const [entries, setEntries] = useState<readonly RebaseTodoEntry[]>(() =>
        createRebaseEntries(commits),
    );
    const [notice, setNotice] = useState(false);
    const commitKey = commits.map((commit) => commit.hash).join("\0");
    const [lastCommitKey, setLastCommitKey] = useState(commitKey);
    const entriesRef = useRef(entries);
    const commitsRef = useRef(commits);
    const editedMessageHashesRef = useRef<ReadonlySet<string>>(new Set());
    const draggedHashRef = useRef<string>();

    commitsRef.current = commits;
    // A changed offered range reseeds during render rather than from an effect. An effect runs
    // after the commit, so the dialog would first paint one frame of the previous range's entries
    // against the new commit map — rows the user is no longer being offered, and a stale notice —
    // and only then reseed. React discards this render pass and re-runs it with the new state
    // instead of committing it, and `createRebaseEntries` is pure, so the discarded pass costs one
    // array build.
    if (lastCommitKey !== commitKey) {
        const nextEntries = createRebaseEntries(commits);
        setLastCommitKey(commitKey);
        editedMessageHashesRef.current = new Set();
        entriesRef.current = nextEntries;
        setEntries(nextEntries);
        setNotice(false);
    }

    const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
    const firstActiveHash = entries.find((entry) => entry.action !== "drop")?.hash;
    const missingMessageEntries = entries.filter(
        (entry) =>
            (entry.action === "reword" || entry.action === "squash") &&
            (typeof entry.message !== "string" || entry.message.trim().length === 0),
    );
    // Keyed rather than scanned per row: a linear `some()` inside the row map is O(n²) once a
    // large range has many blank messages, and the offered range can be hundreds of commits.
    const missingMessageHashes = new Set(missingMessageEntries.map((entry) => entry.hash));

    const applyMutation = useCallback((mutation: RebaseEntryMutation) => {
        entriesRef.current = mutation.entries;
        setEntries(mutation.entries);
        setNotice(mutation.firstActionCleared);
    }, []);
    const close = useCallback(() => {
        onCancel();
        restoreShelfDialogFocus(returnFocusTarget);
    }, [onCancel, returnFocusTarget]);
    const changeAction = useCallback(
        (hash: string, action: RebaseAction) => {
            const editedMessageHashes = new Set(editedMessageHashesRef.current);
            editedMessageHashes.delete(hash);
            editedMessageHashesRef.current = editedMessageHashes;
            applyMutation(
                changeRebaseAction(
                    entriesRef.current,
                    commitsRef.current,
                    hash,
                    action,
                    editedMessageHashes,
                ),
            );
        },
        [applyMutation],
    );
    const changeMessage = useCallback((hash: string, message: string) => {
        editedMessageHashesRef.current = new Set(editedMessageHashesRef.current).add(hash);
        const nextEntries = changeRebaseMessage(entriesRef.current, hash, message);
        entriesRef.current = nextEntries;
        setEntries(nextEntries);
    }, []);
    const move = useCallback(
        (hash: string, direction: "up" | "down") =>
            applyMutation(
                moveRebaseEntry(
                    entriesRef.current,
                    hash,
                    direction,
                    commitsRef.current,
                    editedMessageHashesRef.current,
                ),
            ),
        [applyMutation],
    );
    const startDrag = useCallback((hash: string, event: React.DragEvent<HTMLDivElement>) => {
        event.dataTransfer.setData("text/plain", hash);
        event.dataTransfer.effectAllowed = "move";
        draggedHashRef.current = hash;
    }, []);
    const drop = useCallback(
        (targetHash: string, event: React.DragEvent<HTMLDivElement>) => {
            const sourceHash = event.dataTransfer.getData("text/plain") || draggedHashRef.current;
            if (sourceHash) {
                applyMutation(
                    reorderRebaseEntries(
                        entriesRef.current,
                        sourceHash,
                        targetHash,
                        commitsRef.current,
                        editedMessageHashesRef.current,
                    ),
                );
            }
            draggedHashRef.current = undefined;
        },
        [applyMutation],
    );

    return (
        <Flex
            role="presentation"
            position="fixed"
            inset={0}
            zIndex="var(--intelligit-z-modal, 50)"
            align="center"
            justify="center"
            bg="rgba(0, 0, 0, 0.45)"
            onMouseDown={(event) => event.currentTarget === event.target && close()}
            onKeyDown={(event) => event.key === "Escape" && close()}
        >
            <Flex
                role="dialog"
                aria-modal="true"
                aria-labelledby="rebase-title"
                direction="column"
                gap="12px"
                w="min(900px, calc(100vw - 32px))"
                p="16px"
                border="1px solid var(--intelligit-pycharm-border)"
                borderRadius="4px"
                bg="var(--intelligit-pycharm-panel)"
                color="var(--intelligit-pycharm-foreground)"
            >
                <Box as="h2" id="rebase-title" fontSize="14px" fontWeight={600}>
                    {t("rebase.dialog.title")}
                </Box>
                {commits.some((commit) => commit.isPushed) && (
                    <Box role="alert">{t("rebase.dialog.pushedWarning")}</Box>
                )}
                {notice && <Box role="status">{t("rebase.dialog.firstActionCleared")}</Box>}
                {missingMessageEntries.length > 0 && (
                    <Box role="alert" data-rebase-missing-message>
                        {missingMessageEntries
                            .map(
                                (entry) =>
                                    `${t("rebase.dialog.message")}: ${entry.hash.slice(0, 8)}`,
                            )
                            .join(", ")}
                    </Box>
                )}
                <Box className="rebase-dialog-list">
                    {entries.map((entry) => {
                        const commit = commitsByHash.get(entry.hash);
                        return commit ? (
                            <RebaseRow
                                key={entry.hash}
                                entry={entry}
                                commit={commit}
                                isFirstActive={entry.hash === firstActiveHash}
                                messageMissing={missingMessageHashes.has(entry.hash)}
                                onActionChange={changeAction}
                                onMessageChange={changeMessage}
                                onMove={move}
                                onDragStart={startDrag}
                                onDrop={drop}
                            />
                        ) : null;
                    })}
                </Box>
                <Flex justify="flex-end" gap="8px">
                    <Button ref={cancelRef} variant="secondary" size="sm" onClick={close}>
                        {t("common.cancel")}
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        isDisabled={missingMessageEntries.length > 0}
                        onClick={() => onSubmit(entries)}
                    >
                        {t("rebase.dialog.start")}
                    </Button>
                </Flex>
            </Flex>
        </Flex>
    );
}

interface RebaseRowProps {
    entry: RebaseTodoEntry;
    commit: InteractiveRebaseRangeCommit;
    isFirstActive: boolean;
    messageMissing: boolean;
    onActionChange: (hash: string, action: RebaseAction) => void;
    onMessageChange: (hash: string, message: string) => void;
    onMove: (hash: string, direction: "up" | "down") => void;
    onDragStart: (hash: string, event: React.DragEvent<HTMLDivElement>) => void;
    onDrop: (hash: string, event: React.DragEvent<HTMLDivElement>) => void;
}

const RebaseRow = memo(function RebaseRow({
    entry,
    commit,
    isFirstActive,
    messageMissing,
    onActionChange,
    onMessageChange,
    onMove,
    onDragStart,
    onDrop,
}: RebaseRowProps): React.ReactElement {
    const subject = commit.body.split(/\r?\n/, 1)[0];
    return (
        <Flex
            className="rebase-dialog-row"
            data-rebase-hash={entry.hash}
            direction="column"
            gap="6px"
            py="8px"
            draggable
            onDragStart={(event) => onDragStart(entry.hash, event)}
            onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                onDrop(entry.hash, event);
            }}
        >
            <Flex align="center" gap="8px">
                <select
                    aria-label={t("rebase.dialog.action")}
                    value={entry.action}
                    onChange={(event) =>
                        onActionChange(entry.hash, event.target.value as RebaseAction)
                    }
                >
                    {ACTIONS.map((action) => (
                        <option
                            key={action}
                            value={action}
                            disabled={isFirstActive && (action === "squash" || action === "fixup")}
                        >
                            {action === "drop" ? t("common.drop") : t(`rebase.action.${action}`)}
                        </option>
                    ))}
                </select>
                <Box flex={1}>{subject}</Box>
                <Box fontFamily="mono">{entry.hash.slice(0, 8)}</Box>
                <Box>{commit.authorName}</Box>
                <Box>{formatDateTime(commit.authoredAt)}</Box>
                <Button
                    size="xs"
                    aria-label={t("rebase.dialog.moveUp")}
                    onClick={() => onMove(entry.hash, "up")}
                >
                    ↑
                </Button>
                <Button
                    size="xs"
                    aria-label={t("rebase.dialog.moveDown")}
                    onClick={() => onMove(entry.hash, "down")}
                >
                    ↓
                </Button>
            </Flex>
            {(entry.action === "reword" || entry.action === "squash") && (
                <textarea
                    aria-label={t("rebase.dialog.message")}
                    aria-invalid={messageMissing}
                    value={entry.message ?? ""}
                    onChange={(event) => onMessageChange(entry.hash, event.target.value)}
                />
            )}
        </Flex>
    );
});
