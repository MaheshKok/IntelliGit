import React, { useRef } from "react";
import { Box, Button, Flex } from "@chakra-ui/react";
import type { ShelfEntry } from "../../../protocol/commitPanelMessages";
import { t } from "../../shared/i18n";
import { restoreShelfDialogFocus, useShelfDialogFocus } from "./ShelfDialogFocus";
import { Z_INDEX } from "../../shared/tokens";

interface ShelfDeleteConfirmationProps {
    shelf: ShelfEntry;
    onClose: () => void;
    onConfirm: () => void;
    returnFocusTarget?: HTMLElement | null;
}

/** Confirmation modal for permanently deleting one shelf. */
export function ShelfDeleteConfirmation({
    shelf,
    onClose,
    onConfirm,
    returnFocusTarget,
}: ShelfDeleteConfirmationProps): React.ReactElement {
    const cancelRef = useRef<HTMLButtonElement>(null);
    useShelfDialogFocus(returnFocusTarget, cancelRef);
    const close = (): void => {
        onClose();
        restoreShelfDialogFocus(returnFocusTarget);
    };
    const confirm = (): void => {
        restoreShelfDialogFocus(returnFocusTarget);
        onConfirm();
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
                    {t("shelf.dialog.delete.title")}
                </Box>
                <Box fontSize="12px">{shelf.metadata.name}</Box>
                <Flex justify="flex-end" gap="8px">
                    <Button ref={cancelRef} variant="secondary" size="sm" onClick={close}>
                        {t("common.cancel")}
                    </Button>
                    <Button variant="danger" size="sm" onClick={confirm}>
                        {t("shelf.action.deleteShelf")}
                    </Button>
                </Flex>
            </Flex>
        </Flex>
    );
}
