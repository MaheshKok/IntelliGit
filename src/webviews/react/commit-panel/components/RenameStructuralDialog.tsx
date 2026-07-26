import React, { useRef, useState } from "react";
import { Box, Button, Flex, Input } from "@chakra-ui/react";
import { t } from "../../shared/i18n";
import { restoreShelfDialogFocus, useShelfDialogFocus } from "./ShelfDialogFocus";

interface RenameStructuralDialogProps {
    path: string;
    onClose: () => void;
    onConfirm: (targetPath: string) => void;
    returnFocusTarget?: HTMLElement | null;
}

/** Modal prompting for the local target path of a structural rename resolution. */
export function RenameStructuralDialog({
    path,
    onClose,
    onConfirm,
    returnFocusTarget,
}: RenameStructuralDialogProps): React.ReactElement {
    const inputRef = useRef<HTMLInputElement>(null);
    const targetPathRef = useRef(path);
    const [isDisabled, setIsDisabled] = useState(!path.trim());
    useShelfDialogFocus(returnFocusTarget, inputRef);
    const close = (): void => {
        onClose();
        restoreShelfDialogFocus(returnFocusTarget);
    };
    const submit = (): void => {
        const trimmedTargetPath = targetPathRef.current.trim();
        if (trimmedTargetPath) onConfirm(trimmedTargetPath);
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
                    {t("shelf.dialog.renameLocal.title")}
                </Box>
                <Input
                    aria-label={t("shelf.dialog.renameLocal.input")}
                    ref={inputRef}
                    size="sm"
                    defaultValue={path}
                    onChange={(event) => {
                        targetPathRef.current = event.target.value;
                        setIsDisabled(!event.target.value.trim());
                    }}
                />
                <Flex justify="flex-end" gap="8px">
                    <Button variant="secondary" size="sm" onClick={close}>
                        {t("common.cancel")}
                    </Button>
                    <Button variant="primary" size="sm" isDisabled={isDisabled} onClick={submit}>
                        {t("shelf.action.renameLocal")}
                    </Button>
                </Flex>
            </Flex>
        </Flex>
    );
}
