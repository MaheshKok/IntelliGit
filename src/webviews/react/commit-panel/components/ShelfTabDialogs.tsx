import React, { useState } from "react";
import { Box, Button, Flex, Input } from "@chakra-ui/react";
import type { ShelfEntry, ShelfHealthWarning } from "../../../protocol/commitPanelMessages";

/** Compact warning banner plus a details dialog for observable shelf health. */
export function ShelfHealthWarningBanner({
    warnings,
}: {
    warnings: ShelfHealthWarning[];
}): React.ReactElement | null {
    const [open, setOpen] = useState(false);
    if (!warnings.length) return null;
    const summary =
        warnings.length === 1 ? "Shelf has 1 warning." : `Shelf has ${warnings.length} warnings.`;
    return (
        <>
            <Flex
                role="alert"
                align="center"
                gap="8px"
                px="10px"
                py="5px"
                fontSize="12px"
                bg="var(--vscode-inputValidation-warningBackground)"
                color="var(--vscode-inputValidation-warningForeground)"
            >
                {summary}
                <Button ml="auto" size="xs" variant="secondary" onClick={() => setOpen(true)}>
                    Details
                </Button>
            </Flex>
            {open ? (
                <Flex
                    role="presentation"
                    position="fixed"
                    inset={0}
                    zIndex="var(--intelligit-z-modal, 50)"
                    align="center"
                    justify="center"
                    bg="rgba(0, 0, 0, 0.45)"
                >
                    <Flex
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="shelf-health-title"
                        direction="column"
                        gap="12px"
                        w="min(390px, calc(100vw - 32px))"
                        p="16px"
                        border="1px solid var(--intelligit-pycharm-border)"
                        borderRadius="4px"
                        bg="var(--intelligit-pycharm-panel)"
                    >
                        <Box as="h2" id="shelf-health-title" fontSize="14px" fontWeight={600}>
                            Shelf warnings
                        </Box>
                        {warnings.map((warning) => (
                            <Box key={`${warning.kind}-${warning.detail}`} fontSize="12px">
                                {warning.kind}: {warning.detail}
                            </Box>
                        ))}
                        <Flex justify="flex-end">
                            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
                                Close
                            </Button>
                        </Flex>
                    </Flex>
                </Flex>
            ) : null}
        </>
    );
}

/** Modal prompting for the local target path of a structural rename resolution. */
export function RenameStructuralDialog({
    path,
    onClose,
    onConfirm,
}: {
    path: string;
    onClose: () => void;
    onConfirm: (targetPath: string) => void;
}): React.ReactElement {
    const [targetPath, setTargetPath] = useState(path);
    return (
        <Flex
            role="presentation"
            position="fixed"
            inset={0}
            zIndex="var(--intelligit-z-modal, 50)"
            align="center"
            justify="center"
            bg="rgba(0, 0, 0, 0.45)"
        >
            <Flex
                role="dialog"
                aria-modal="true"
                aria-labelledby="rename-local-title"
                direction="column"
                gap="12px"
                w="min(390px, calc(100vw - 32px))"
                p="16px"
                border="1px solid var(--intelligit-pycharm-border)"
                borderRadius="4px"
                bg="var(--intelligit-pycharm-panel)"
            >
                <Box as="h2" id="rename-local-title" fontSize="14px" fontWeight={600}>
                    Rename local file
                </Box>
                <Input
                    aria-label="Rename local path"
                    size="sm"
                    value={targetPath}
                    onChange={(event) => setTargetPath(event.target.value)}
                />
                <Flex justify="flex-end" gap="8px">
                    <Button variant="secondary" size="sm" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        isDisabled={!targetPath.trim()}
                        onClick={() => onConfirm(targetPath.trim())}
                    >
                        Rename Local
                    </Button>
                </Flex>
            </Flex>
        </Flex>
    );
}

/** Confirmation modal for permanently deleting one shelf. */
export function ShelfDeleteConfirmation({
    shelf,
    onClose,
    onConfirm,
}: {
    shelf: ShelfEntry;
    onClose: () => void;
    onConfirm: () => void;
}): React.ReactElement {
    return (
        <Flex
            role="presentation"
            position="fixed"
            inset={0}
            zIndex="var(--intelligit-z-modal, 50)"
            align="center"
            justify="center"
            bg="rgba(0, 0, 0, 0.45)"
        >
            <Flex
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="delete-shelf-title"
                direction="column"
                gap="12px"
                w="min(390px, calc(100vw - 32px))"
                p="16px"
                border="1px solid var(--intelligit-pycharm-border)"
                borderRadius="4px"
                bg="var(--intelligit-pycharm-panel)"
            >
                <Box as="h2" id="delete-shelf-title" fontSize="14px" fontWeight={600}>
                    Delete shelf?
                </Box>
                <Box fontSize="12px">{shelf.metadata.name}</Box>
                <Flex justify="flex-end" gap="8px">
                    <Button variant="secondary" size="sm" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button variant="danger" size="sm" onClick={onConfirm}>
                        Delete Shelf
                    </Button>
                </Flex>
            </Flex>
        </Flex>
    );
}
