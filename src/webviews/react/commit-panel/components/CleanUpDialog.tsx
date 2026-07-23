import React, { useMemo, useState } from "react";
import { Box, Button, Checkbox, Flex, Input } from "@chakra-ui/react";
import type { ShelfEntry } from "../../../protocol/commitPanelMessages";

interface CleanUpDialogProps {
    shelves: ShelfEntry[];
    now?: number;
    onClose: () => void;
    onSubmit: (shelfIds: string[]) => void;
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
}: CleanUpDialogProps): React.ReactElement {
    const candidates = useMemo(() => appliedShelves(shelves), [shelves]);
    const [selected, setSelected] = useState<Set<string>>(
        () => new Set(candidates.map((shelf) => shelf.id)),
    );
    const [days, setDays] = useState("30");
    const selectedIds = candidates
        .filter((shelf) => selected.has(shelf.id))
        .map((shelf) => shelf.id);
    const selectOlderThan = (): void => {
        const daysValue = Number(days);
        if (!Number.isFinite(daysValue) || daysValue < 0) return;
        const cutoff = now - daysValue * 86_400_000;
        setSelected(
            new Set(
                candidates.filter((shelf) => shelf.appliedAt < cutoff).map((shelf) => shelf.id),
            ),
        );
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
                if (event.currentTarget === event.target) onClose();
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
                <Box as="h2" id="cleanup-shelf-title" fontSize="14px" fontWeight={600}>
                    Clean Up Shelf
                </Box>
                <Box fontSize="12px" color="var(--intelligit-pycharm-muted)">
                    This permanently deletes selected shelves. Recovery snapshots are kept separately.
                </Box>
                {candidates.length === 0 ? (
                    <Box color="var(--intelligit-pycharm-muted)" fontSize="12px">
                        No already unshelved shelves to clean up.
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
                                All ghosts
                            </Button>
                            <Input
                                aria-label="Older than days"
                                type="number"
                                min={0}
                                value={days}
                                onChange={(event) => setDays(event.target.value)}
                            />
                            <Button variant="secondary" size="sm" onClick={selectOlderThan}>
                                Select older than
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
                    <Button variant="secondary" size="sm" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        isDisabled={selectedIds.length === 0}
                        onClick={() => onSubmit(selectedIds)}
                    >
                        Clean Up Shelf
                    </Button>
                </Flex>
            </Flex>
        </Flex>
    );
}
