// Modal controls for applying a stash to its current branch or a new branch.

import React, { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Flex } from "@chakra-ui/react";
import { isValidBranchName } from "../../../../utils/gitRefs";
import { t } from "../../shared/i18n";

/** Props for the compact unstash dialog owned by StashTab. */
export interface StashUnstashDialogProps {
    currentBranchName: string | null;
    returnFocusTarget: HTMLElement | null;
    onClose: () => void;
    onCurrentBranchSubmit: (action: "apply" | "pop", reinstateIndex: boolean) => void;
    onBranchSubmit: (branchName: string) => void;
}

/**
 * Renders the compact unstash modal and rejects invalid new branch names before posting.
 *
 * The dialog captures initial focus in the branch field, restores it on close, and treats
 * Escape as cancellation so its focus and keyboard behavior remains modal rather than menu-like.
 */
export function StashUnstashDialog({
    currentBranchName,
    returnFocusTarget,
    onClose,
    onCurrentBranchSubmit,
    onBranchSubmit,
}: StashUnstashDialogProps): React.ReactElement {
    const inputRef = useRef<HTMLInputElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const [branchName, setBranchName] = useState("");
    const [popStash, setPopStash] = useState(false);
    const [reinstateIndex, setReinstateIndex] = useState(false);
    const [isBranchError, setIsBranchError] = useState(false);
    const trimmedBranchName = branchName.trim();
    const usesNewBranch = trimmedBranchName.length > 0;

    useEffect(() => {
        inputRef.current?.focus();
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
            }
            if (event.key === "Tab" && dialogRef.current) {
                const controls = Array.from(
                    dialogRef.current.querySelectorAll<HTMLElement>(
                        "button:not([disabled]), input:not([disabled])",
                    ),
                );
                if (controls.length === 0) return;
                const first = controls[0];
                const last = controls.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            if (returnFocusTarget?.isConnected) returnFocusTarget.focus();
        };
    }, [onClose, returnFocusTarget]);

    const submit = (): void => {
        if (usesNewBranch) {
            if (!isValidBranchName(trimmedBranchName)) {
                setIsBranchError(true);
                return;
            }
            onBranchSubmit(trimmedBranchName);
            return;
        }
        onCurrentBranchSubmit(popStash ? "pop" : "apply", reinstateIndex);
    };

    return (
        <Flex
            role="presentation"
            position="fixed"
            inset={0}
            zIndex="var(--intelligit-z-modal, 50)"
            align="center"
            justify="center"
            bg="var(--vscode-editor-background, rgba(0, 0, 0, 0.45))"
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--vscode-editor-background) 54%, transparent)",
            }}
        >
            <Flex
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="stash-unstash-title"
                direction="column"
                gap="12px"
                w="min(390px, calc(100vw - 32px))"
                p="16px"
                border="1px solid var(--intelligit-pycharm-border)"
                borderRadius="4px"
                bg="var(--intelligit-pycharm-panel)"
                color="var(--intelligit-pycharm-foreground)"
                boxShadow="0 4px 8px rgba(0, 0, 0, 0.32)"
            >
                <Flex as="h2" id="stash-unstash-title" fontSize="14px" fontWeight={600}>
                    {t("stash.action.unstash")}
                </Flex>
                <Flex direction="column" gap="4px">
                    <label htmlFor="stash-current-branch">{t("stash.dialog.currentBranch")}</label>
                    <output id="stash-current-branch" aria-label={t("stash.dialog.currentBranch")}>
                        {currentBranchName ?? t("stash.dialog.noBranch")}
                    </output>
                </Flex>
                <Flex direction="column" gap="4px">
                    <label htmlFor="stash-branch-name">{t("stash.dialog.asNewBranch")}</label>
                    <input
                        ref={inputRef}
                        id="stash-branch-name"
                        aria-label={t("stash.dialog.asNewBranch")}
                        value={branchName}
                        onChange={(event) => {
                            setBranchName(event.target.value);
                            setIsBranchError(false);
                        }}
                        style={{
                            minHeight: "26px",
                            padding: "3px 6px",
                            color: "var(--intelligit-pycharm-foreground)",
                            background: "var(--intelligit-pycharm-input)",
                            border: "1px solid var(--intelligit-pycharm-input-border)",
                            borderRadius: "3px",
                        }}
                    />
                    {isBranchError ? (
                        <span
                            role="alert"
                            style={{ color: "var(--vscode-errorForeground)", fontSize: "12px" }}
                        >
                            {t("stash.dialog.invalidBranch")}
                        </span>
                    ) : null}
                </Flex>
                <Flex direction="column" gap="6px">
                    <Checkbox
                        aria-label={t("stash.dialog.popStash")}
                        isChecked={popStash}
                        isDisabled={usesNewBranch}
                        onChange={(event) => setPopStash(event.target.checked)}
                    >
                        {t("stash.dialog.popStash")}
                    </Checkbox>
                    <Checkbox
                        aria-label={t("stash.dialog.reinstateIndex")}
                        isChecked={reinstateIndex}
                        isDisabled={usesNewBranch}
                        onChange={(event) => setReinstateIndex(event.target.checked)}
                    >
                        {t("stash.dialog.reinstateIndex")}
                    </Checkbox>
                </Flex>
                <Flex justify="flex-end" gap="8px">
                    <Button variant="secondary" size="sm" onClick={onClose}>
                        {t("common.cancel")}
                    </Button>
                    <Button variant="primary" size="sm" onClick={submit}>
                        {usesNewBranch
                            ? t("stash.action.branch")
                            : popStash
                              ? t("stash.action.popStash")
                              : t("stash.action.applyStash")}
                    </Button>
                </Flex>
            </Flex>
        </Flex>
    );
}
