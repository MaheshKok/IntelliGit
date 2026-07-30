// Bottom area of the commit tab: amend checkbox, commit message textarea,
// and commit button.

import React from "react";
import { Flex, Box, Textarea, Button } from "@chakra-ui/react";
import { VscDebugStop, VscSparkle } from "react-icons/vsc";
import { VscCheckbox } from "../../shared/components/VscCheckbox";
import { ToolbarIconButton } from "../../shared/components/ToolbarIconButton";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import { t } from "../../shared/i18n";

/** The host lifecycle states that fence commit-message generation controls. */
export type CommitMessageGenerationStatus = "idle" | "requested" | "running";

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
    currentBranchAhead?: number;
    currentBranchName: string | null;
    currentBranchUpstream: string | null;
    /** Latest host-observed generation lifecycle; defaults safely while callers migrate. */
    generationStatus?: CommitMessageGenerationStatus;
    /** Requests generation from the host when the current index selection is valid. */
    onGenerateMessage?: () => void;
    /** Cancels an in-flight generation request through the host. */
    onCancelGeneration?: () => void;
    /** Distinguishes amendable detached histories from an unborn repository. */
    hasCommits?: boolean;
    /** Whether at least one working-tree path is selected for a new commit message. */
    hasCheckedPaths?: boolean;
    /** Disables a new request while the whole index is being mutated. */
    wholeIndexOperationInProgress?: boolean;
}

const NOOP = (): void => undefined;

const disabledButtonStyles = {
    bg: "rgba(255,255,255,0.03)",
    color: "var(--vscode-disabledForeground)",
    borderColor: "rgba(176, 186, 205, 0.24)",
    cursor: "default",
    opacity: 0.62,
};

/** Trims the upstream branch label used by the commit form branch indicator. */
function getBranchIndicatorUpstream(
    currentBranchName: string | null,
    currentBranchUpstream: string | null,
): string | null {
    const upstream = currentBranchUpstream?.trim();
    return upstream && currentBranchName ? upstream : null;
}

/**
 * Renders amend controls, the commit message editor, and the commit action.
 *
 * The component does not talk to the extension host directly; callers decide how
 * message changes, amend toggles, commit requests, and message-generation lifecycle
 * callbacks are translated into outbound webview messages.
 */
// react-doctor-disable-next-line react-doctor/no-many-boolean-props
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
    currentBranchAhead = 0,
    currentBranchName,
    currentBranchUpstream,
    generationStatus = "idle",
    onGenerateMessage = NOOP,
    onCancelGeneration = NOOP,
    hasCommits = true,
    hasCheckedPaths = false,
    wholeIndexOperationInProgress = false,
}: Props): React.ReactElement {
    const amendCheckboxId = "commit-area-amend-checkbox";
    const branchUpstream = getBranchIndicatorUpstream(currentBranchName, currentBranchUpstream);
    const isGenerationActive = generationStatus !== "idle";
    const isAmendDisabled = !hasCommits || isGenerationActive;
    const isGenerateDisabled =
        wholeIndexOperationInProgress ||
        (isAmend ? !hasCommits : !hasCheckedPaths) ||
        isGenerationActive;
    const isCommitDisabled = !canCommit || isGenerationActive;
    const isPushVisuallyDisabled = !canPush;
    const isPushButtonDisabled = !canPush;
    const branchLabel = currentBranchName
        ? branchUpstream
            ? t("commit.branchIndicator.tracking", {
                  branch: currentBranchName,
                  upstream: branchUpstream,
              })
            : t("commit.branchIndicator.local", { branch: currentBranchName })
        : null;
    return (
        <Flex direction="column" overflow="hidden" flex={1} bg="var(--intelligit-pycharm-panel)">
            {branchLabel ? (
                <Box
                    px="8px"
                    py="4px"
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
                px="8px"
                py="3px"
                fontSize="12px"
                minH="24px"
                cursor={isAmendDisabled ? "default" : "pointer"}
                opacity={isAmendDisabled ? 0.62 : 1}
                aria-disabled={isAmendDisabled || undefined}
            >
                <VscCheckbox
                    isChecked={isAmend}
                    onChange={() => onAmendChange(!isAmend)}
                    disabled={isAmendDisabled}
                    inputId={amendCheckboxId}
                    inputTestId="amend-checkbox"
                    ariaLabel={t("commit.amend")}
                />
                <Box as="span" color="var(--intelligit-pycharm-foreground)" opacity={0.92}>
                    {t("commit.amend")}
                </Box>
            </Flex>
            <Box px="8px" flex={1} overflow="hidden" position="relative">
                <Box position="absolute" top="4px" right="12px" zIndex={1}>
                    {isGenerationActive ? (
                        <ToolbarIconButton
                            label={t("commit.message.stopGeneration")}
                            icon={<VscDebugStop size={16} />}
                            onClick={onCancelGeneration}
                            color="var(--vscode-errorForeground)"
                        />
                    ) : (
                        <ToolbarIconButton
                            label={t("commit.message.generate")}
                            icon={<VscSparkle size={16} />}
                            onClick={onGenerateMessage}
                            disabled={isGenerateDisabled}
                            color="var(--intelligit-pycharm-blue)"
                        />
                    )}
                </Box>
                <Textarea
                    value={commitMessage}
                    onChange={(e) => onMessageChange(e.target.value)}
                    readOnly={isGenerationActive}
                    placeholder={t("commit.message.placeholder")}
                    resize="none"
                    w="100%"
                    h="100%"
                    bg="var(--intelligit-pycharm-input)"
                    color="var(--intelligit-pycharm-foreground)"
                    border="1px solid"
                    borderColor="var(--intelligit-pycharm-input-border)"
                    borderRadius="4px"
                    p="6px 8px"
                    pr="32px"
                    aria-busy={isGenerationActive}
                    fontFamily={SYSTEM_FONT_STACK}
                    fontSize="12px"
                    _placeholder={{ color: "rgba(214, 219, 229, 0.48)" }}
                    _focus={{
                        borderColor: "var(--intelligit-pycharm-blue)",
                        boxShadow: "0 0 0 1px rgba(95, 140, 255, 0.28)",
                    }}
                />
            </Box>
            <Flex align="center" gap="8px" p="6px 8px 8px">
                <Button
                    variant="primary"
                    size="sm"
                    onClick={isCommitDisabled ? undefined : onCommit}
                    isDisabled={isCommitDisabled}
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
                    isDisabled={isPushButtonDisabled}
                    aria-disabled={isPushVisuallyDisabled || undefined}
                    fontSize="12px"
                    fontFamily={SYSTEM_FONT_STACK}
                    _disabled={disabledButtonStyles}
                    sx={isPushVisuallyDisabled ? disabledButtonStyles : undefined}
                >
                    {t(pushLabel)}
                    {currentBranchAhead > 0 ? (
                        <Box as="span" data-testid="push-ahead-count" ml="4px">
                            ↑{currentBranchAhead}
                        </Box>
                    ) : null}
                </Button>
            </Flex>
        </Flex>
    );
}
