import React, { useMemo, useRef, useState } from "react";
import { Box, Button, Checkbox, Flex } from "@chakra-ui/react";
import type { ShelfFileEntry } from "../../../../shelf/model";
import { t } from "../../shared/i18n";
import { restoreShelfDialogFocus, useShelfDialogFocus } from "./ShelfDialogFocus";

/** Whole-entry selection and remove-on-success choice for flattened unshelve. */
export interface UnshelveDialogSubmit {
    changeIds: string[];
    removeFromShelf: boolean;
}

/** Inputs and callbacks for the flattened unshelve dialog. */
export interface UnshelveDialogProps {
    entries: ShelfFileEntry[];
    /** Activation-time default for removal after a successful apply. */
    defaultRemoveFromShelf?: boolean;
    returnFocusTarget?: HTMLElement | null;
    onClose: () => void;
    onSubmit: (input: UnshelveDialogSubmit) => void;
}

function entryLabel(entry: ShelfFileEntry): string {
    return entry.worktreeBlock?.path ?? entry.indexBlock?.path ?? entry.changeId;
}

/** Flattened-mode shelf apply dialog. Host owns validation and exact-state policy. */
export function UnshelveDialog({
    entries,
    defaultRemoveFromShelf = true,
    returnFocusTarget,
    onClose,
    onSubmit,
}: UnshelveDialogProps): React.ReactElement {
    const cancelRef = useRef<HTMLButtonElement>(null);
    useShelfDialogFocus(returnFocusTarget, cancelRef);
    const [selected, setSelected] = useState<Set<string>>(
        () => new Set(entries.map((entry) => entry.changeId)),
    );
    const [removeFromShelf, setRemoveFromShelf] = useState(defaultRemoveFromShelf);
    const selectedIds = useMemo(
        () =>
            entries.filter((entry) => selected.has(entry.changeId)).map((entry) => entry.changeId),
        [entries, selected],
    );
    const toggle = (changeId: string): void => {
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(changeId)) next.delete(changeId);
            else next.add(changeId);
            return next;
        });
    };
    const close = (): void => {
        onClose();
        restoreShelfDialogFocus(returnFocusTarget);
    };

    return (
        <Flex
            role="presentation"
            position="fixed"
            inset={0}
            zIndex="var(--intelligit-z-modal, 50)"
            align="center"
            justify="center"
            bg="rgba(0, 0, 0, 0.45)"
            onMouseDown={(event) => {
                if (event.currentTarget === event.target) close();
            }}
            onKeyDown={(event) => {
                if (event.key === "Escape") close();
            }}
        >
            <Flex
                role="dialog"
                aria-modal="true"
                aria-labelledby="unshelve-title"
                direction="column"
                gap="12px"
                w="min(420px, calc(100vw - 32px))"
                p="16px"
                border="1px solid var(--intelligit-pycharm-border)"
                borderRadius="4px"
                bg="var(--intelligit-pycharm-panel)"
                color="var(--intelligit-pycharm-foreground)"
            >
                <Box as="h2" id="unshelve-title" fontSize="14px" fontWeight={600}>
                    {t("shelf.dialog.unshelve.title")}
                </Box>
                <Box fontSize="12px" color="var(--intelligit-pycharm-muted)">
                    {t("shelf.dialog.unshelve.flattenedMode")}
                </Box>
                <Flex direction="column" gap="4px">
                    {entries.map((entry) => (
                        <Checkbox
                            key={entry.changeId}
                            aria-label={entryLabel(entry)}
                            isChecked={selected.has(entry.changeId)}
                            onChange={() => toggle(entry.changeId)}
                        >
                            {entryLabel(entry)}
                        </Checkbox>
                    ))}
                </Flex>
                <Checkbox
                    aria-label={t("shelf.dialog.unshelve.removeApplied")}
                    isChecked={removeFromShelf}
                    onChange={(event) => setRemoveFromShelf(event.target.checked)}
                >
                    {t("shelf.dialog.unshelve.removeApplied")}
                </Checkbox>
                <Flex justify="flex-end" gap="8px">
                    <Button ref={cancelRef} variant="secondary" size="sm" onClick={close}>
                        {t("common.cancel")}
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        isDisabled={selectedIds.length === 0}
                        onClick={() => onSubmit({ changeIds: selectedIds, removeFromShelf })}
                    >
                        {t("shelf.action.unshelve")}
                    </Button>
                </Flex>
            </Flex>
        </Flex>
    );
}
