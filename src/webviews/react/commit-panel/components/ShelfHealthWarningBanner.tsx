import React, { useRef, useState } from "react";
import { Box, Button, Flex } from "@chakra-ui/react";
import type { ShelfHealthWarning } from "../../../protocol/commitPanelMessages";
import { t } from "../../shared/i18n";
import { useShelfDialogFocus } from "./ShelfDialogFocus";

/** Compact warning banner plus a details dialog for observable shelf health. */
export function ShelfHealthWarningBanner({
    warnings,
}: {
    warnings: ShelfHealthWarning[];
}): React.ReactElement | null {
    const [open, setOpen] = useState(false);
    const detailsRef = useRef<HTMLButtonElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    useShelfDialogFocus(open ? detailsRef.current : null, closeRef);
    if (!warnings.length) return null;
    const summary =
        warnings.length === 1
            ? t("shelf.health.oneWarning")
            : t("shelf.health.manyWarnings", { count: warnings.length });
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
                <Button
                    ref={detailsRef}
                    ml="auto"
                    size="xs"
                    variant="secondary"
                    onClick={() => setOpen(true)}
                >
                    {t("shelf.health.details")}
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
                    onMouseDown={(event) => {
                        if (event.currentTarget === event.target) setOpen(false);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") setOpen(false);
                    }}
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
                            {t("shelf.health.title")}
                        </Box>
                        {warnings.map((warning) => (
                            <Box key={`${warning.kind}-${warning.detail}`} fontSize="12px">
                                {warning.kind}: {warning.detail}
                            </Box>
                        ))}
                        <Flex justify="flex-end">
                            <Button
                                ref={closeRef}
                                variant="secondary"
                                size="sm"
                                onClick={() => setOpen(false)}
                            >
                                {t("shelf.health.close")}
                            </Button>
                        </Flex>
                    </Flex>
                </Flex>
            ) : null}
        </>
    );
}
