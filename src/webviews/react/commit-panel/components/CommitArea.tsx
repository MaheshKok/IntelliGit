// Bottom area of the commit tab: amend checkbox, commit message textarea,
// and commit button.

import React from "react";
import { Flex, Box, Textarea, Button } from "@chakra-ui/react";
import { VscCheckbox } from "./VscCheckbox";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import { t } from "../../shared/i18n";

interface Props {
    commitMessage: string;
    isAmend: boolean;
    onMessageChange: (message: string) => void;
    onAmendChange: (isAmend: boolean) => void;
    onCommit: () => void;
    onPush: () => void;
    canCommit: boolean;
    canPush: boolean;
    pushLabel: string;
    currentBranchName: string | null;
    currentBranchUpstream: string | null;
}

const disabledButtonStyles = {
    bg: "rgba(255,255,255,0.03)",
    color: "var(--vscode-disabledForeground)",
    borderColor: "rgba(176, 186, 205, 0.24)",
    cursor: "default",
    opacity: 0.62,
};

/**
 * Renders amend controls, the commit message editor, and the commit action.
 *
 * The component does not talk to the extension host directly; callers decide how
 * message changes, amend toggles, and commit requests are translated into outbound webview messages.
 */
export function CommitArea({
    commitMessage,
    isAmend,
    onMessageChange,
    onAmendChange,
    onCommit,
    onPush,
    canCommit,
    canPush,
    pushLabel,
    currentBranchName,
    currentBranchUpstream,
}: Props): React.ReactElement {
    const amendCheckboxId = "commit-area-amend-checkbox";
    const branchLabel = currentBranchName
        ? currentBranchUpstream
            ? t("commit.branchIndicator.tracking", {
                  branch: currentBranchName,
                  upstream: currentBranchUpstream,
              })
            : t("commit.branchIndicator.local", { branch: currentBranchName })
        : null;
    return (
        <Flex direction="column" overflow="hidden" flex={1} bg="var(--intelligit-pycharm-panel)">
            {branchLabel ? (
                <Box
                    px="7px"
                    py="5px"
                    fontSize="12px"
                    color="var(--vscode-descriptionForeground)"
                    borderBottom="1px solid var(--intelligit-pycharm-border)"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    title={branchLabel}
                >
                    {branchLabel}
                </Box>
            ) : null}
            <Flex
                as="label"
                htmlFor={amendCheckboxId}
                align="center"
                gap="5px"
                px="7px"
                py="3px"
                fontSize="12px"
                minH="24px"
                cursor="pointer"
            >
                <VscCheckbox
                    isChecked={isAmend}
                    onChange={() => onAmendChange(!isAmend)}
                    inputId={amendCheckboxId}
                    inputTestId="amend-checkbox"
                />
                <Box as="span" color="var(--intelligit-pycharm-foreground)" opacity={0.92}>
                    {t("commit.amend")}
                </Box>
            </Flex>
            <Box px="7px" flex={1} overflow="hidden">
                <Textarea
                    value={commitMessage}
                    onChange={(e) => onMessageChange(e.target.value)}
                    placeholder={t("commit.message.placeholder")}
                    resize="none"
                    w="100%"
                    h="100%"
                    bg="var(--intelligit-pycharm-input)"
                    color="var(--intelligit-pycharm-foreground)"
                    border="1px solid"
                    borderColor="var(--intelligit-pycharm-input-border)"
                    borderRadius="3px"
                    p="7px 9px"
                    fontFamily={SYSTEM_FONT_STACK}
                    fontSize="12px"
                    _placeholder={{ color: "rgba(214, 219, 229, 0.48)" }}
                    _focus={{
                        borderColor: "var(--intelligit-pycharm-blue)",
                        boxShadow: "0 0 0 1px rgba(95, 140, 255, 0.28)",
                    }}
                />
            </Box>
            <Flex align="center" gap="8px" p="6px 7px 8px">
                <Button
                    variant="primary"
                    size="sm"
                    onClick={onCommit}
                    isDisabled={!canCommit}
                    fontSize="12px"
                    fontFamily={SYSTEM_FONT_STACK}
                    _disabled={disabledButtonStyles}
                >
                    {isAmend ? t("commit.action.amend") : t("commit.action.commit")}
                </Button>
                <Button
                    variant="primary"
                    size="sm"
                    onClick={onPush}
                    isDisabled={!canPush}
                    fontSize="12px"
                    fontFamily={SYSTEM_FONT_STACK}
                    _disabled={disabledButtonStyles}
                >
                    {t(pushLabel)}
                </Button>
            </Flex>
        </Flex>
    );
}
