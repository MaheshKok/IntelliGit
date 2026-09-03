import React, { useMemo, useRef, useState } from "react";
import { Box, Button, Checkbox, Flex, Input } from "@chakra-ui/react";
import type { ShelfEntry } from "../../../protocol/commitPanelMessages";
import { t } from "../../shared/i18n";
import { restoreShelfDialogFocus, useShelfDialogFocus } from "./ShelfDialogFocus";
import { TYPE_SCALE, Z_INDEX } from "../../shared/tokens";

interface CleanUpDialogProps {
    shelves: ShelfEntry[];
    now?: number;
    onClose: () => void;
    onSubmit: (shelfIds: string[]) => void;
    returnFocusTarget?: HTMLElement | null;
}

type AppliedShelf = ShelfEntry & { appliedAt: number };

function appliedShelves(shelves: ShelfEntry[]): AppliedShelf[] {
    return shelves.flatMap((shelf) => {
        const appliedAt = shelf.metadata.appliedAt ?? Number.NaN;
        return shelf.metadata.lifecycle === "applied" && Number.isFinite(appliedAt)
            ? [{ ...shelf, appliedAt }]
            : [];
    });
}

/** Selects persisted already-unshelved shelves for catalog-CAS deletion. */
export function CleanUpDialog({
    shelves,
    now = Date.now(),
    onClose,
    onSubmit,
    returnFocusTarget,
}: CleanUpDialogProps): React.ReactElement {
    const cancelRef = useRef<HTMLButtonElement>(null);
    useShelfDialogFocus(returnFocusTarget, cancelRef);
    const candidates = useMemo(() => appliedShelves(shelves), [shelves]);
    const [selected, setSelected] = useState<Set<string>>(
        () => new Set(candidates.map((shelf) => shelf.id)),
    );
    const [days, setDays] = useState("30");
    const selectedIds: string[] = [];
    for (const shelf of candidates) {
        if (selected.has(shelf.id)) selectedIds.push(shelf.id);
    }
    const selectOlderThan = (): void => {
        const daysValue = Number(days);
        if (!Number.isFinite(daysValue) || daysValue < 0) return;
        const cutoff = now - daysValue * 86_400_000;
        const olderShelfIds = new Set<string>();
        for (const shelf of candidates) {
            if (shelf.appliedAt < cutoff) olderShelfIds.add(shelf.id);
        }
        setSelected(olderShelfIds);
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
            zIndex={Z_INDEX.modal}
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
                aria-labelledby="cleanup-shelf-title"
                direction="column"
                gap="12px"
                w="min(420px, calc(100vw - 32px))"
                p="16px"
                border="1px solid var(--intelligit-pycharm-border)"
                borderRadius="4px"
                bg="var(--intelligit-pycharm-panel)"
                color="var(--intelligit-pycharm-foreground)"
            >
                <Box
                    as="h2"
                    id="cleanup-shelf-title"
                    fontSize={`${TYPE_SCALE.dialogTitle}px`}
                    fontWeight={600}
                >
                    {t("shelf.dialog.cleanup.title")}
                </Box>
                <Box fontSize="12px" color="var(--intelligit-pycharm-muted)">
                    {t("shelf.dialog.cleanup.description")}
                </Box>
                {candidates.length === 0 ? (
                    <Box color="var(--intelligit-pycharm-muted)" fontSize="12px">
                        {t("shelf.dialog.cleanup.empty")}
                    </Box>
                ) : (
                    <>
                        <Flex gap="8px" align="center">
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() =>
                                    setSelected(new Set(candidates.map((shelf) => shelf.id)))
                                }
                            >
                                {t("shelf.dialog.cleanup.allGhosts")}
                            </Button>
                            <Input
                                aria-label={t("shelf.dialog.cleanup.olderThanDays")}
                                type="number"
                                min={0}
                                value={days}
                                onChange={(event) => setDays(event.target.value)}
                            />
                            <Button variant="secondary" size="sm" onClick={selectOlderThan}>
                                {t("shelf.dialog.cleanup.selectOlderThan")}
                            </Button>
                        </Flex>
                        <Flex direction="column" gap="4px">
                            {candidates.map((shelf) => (
                                <Checkbox
                                    key={shelf.id}
                                    aria-label={shelf.metadata.name}
                                    isChecked={selected.has(shelf.id)}
                                    onChange={() =>
                                        setSelected((current) => {
                                            const next = new Set(current);
                                            if (next.has(shelf.id)) next.delete(shelf.id);
                                            else next.add(shelf.id);
                                            return next;
                                        })
                                    }
                                >
                                    {shelf.metadata.name}
                                </Checkbox>
                            ))}
                        </Flex>
                    </>
                )}
                <Flex justify="flex-end" gap="8px">
                    <Button ref={cancelRef} variant="secondary" size="sm" onClick={close}>
                        {t("common.cancel")}
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        isDisabled={selectedIds.length === 0}
                        onClick={() => onSubmit(selectedIds)}
                    >
                        {t("shelf.dialog.cleanup.title")}
                    </Button>
                </Flex>
            </Flex>
        </Flex>
    );
}
