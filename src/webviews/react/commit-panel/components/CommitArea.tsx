// Bottom area of the commit tab: amend checkbox, commit message textarea,
// and commit button.

import React from "react";
import { Flex, Box, Textarea, Button } from "@chakra-ui/react";
import { VscDebugStop, VscSparkle } from "react-icons/vsc";
import { VscCheckbox } from "../../shared/components/VscCheckbox";
import { ToolbarIconButton } from "../../shared/components/ToolbarIconButton";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import { t } from "../../shared/i18n";
import { JETBRAINS_UI, Z_INDEX } from "../../shared/tokens";

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

// A disabled filled button keeps its shape and loses its voice: the host's own
// disabled foreground on a transparent ground, with the border tinted from that
// same token. The white wash and the fixed light border this replaced both
// assumed a dark panel, so on a light theme the button read as *more* prominent
// disabled than enabled. Opacity stays off the list because
// `--vscode-disabledForeground` is already translucent — dimming it twice makes
// the control vanish rather than read as unavailable.
const disabledButtonStyles = {
    bg: "transparent",
    color: JETBRAINS_UI.color.disabled,
    borderColor: `color-mix(in srgb, ${JETBRAINS_UI.color.disabled} 45%, transparent)`,
    cursor: "default",
    opacity: 1,
};

// The width the tint above never declared. Chakra's CSS reset gives every element
// `border-width: 0; border-style: solid` through a zero-specificity `:where(*, *::before,
// *::after)` rule, and the `primary` variant declares no border to replace it (theme.ts:82-91),
// so `borderColor` alone lands on a 0px border and paints nothing: a disabled Commit lost its
// fill AND its edge and read as a line of grey text -- the opposite of the shape the comment
// above promises. The two variants that get this right, `secondary` and `danger`, both win by
// setting the `border` shorthand (theme.ts:100, theme.ts:163); this follows them. Reserved on
// the ENABLED state too, and transparent there, so the button measures the same in both states
// and becoming available cannot nudge its neighbour by the border's 2px.
const RESERVED_BORDER = "1px solid transparent";

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
        <Flex
            data-commit-area="true"
            direction="column"
            overflow="hidden"
            flex={1}
            bg="var(--intelligit-pycharm-panel)"
        >
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
                {/* Above the focused textarea, whose Chakra outline variant raises itself to z-index 1. */}
                <Box
                    position="absolute"
                    top="4px"
                    right="12px"
                    zIndex={Z_INDEX.sticky}
                    // An icon button has nothing to cut, copy, or paste; without this the
                    // webview's native editing menu opens over it.
                    onContextMenu={(event) => event.preventDefault()}
                >
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
                    borderRadius={`${JETBRAINS_UI.size.radius}px`}
                    p="6px 8px"
                    pr="32px"
                    aria-busy={isGenerationActive}
                    fontFamily={SYSTEM_FONT_STACK}
                    fontSize="12px"
                    // The host owns placeholder contrast. The fixed
                    // `rgba(214,219,229,0.48)` this replaced was a light grey
                    // tuned for a dark well; on a light theme it left the
                    // placeholder barely visible against the field.
                    _placeholder={{
                        color: "var(--vscode-input-placeholderForeground, rgba(215, 220, 229, 0.62))",
                    }}
                    // Border only. DESIGN.md §5 gives inputs a focus border and
                    // explicitly no glow, and the 1px blue halo that used to sit
                    // here doubled the focus ring on every theme that already
                    // draws one.
                    _focus={{ borderColor: "var(--intelligit-pycharm-blue)" }}
                />
            </Box>
            <Flex align="center" gap="8px" p="6px 8px 8px">
                <Button
                    data-testid="commit-action-commit"
                    variant="primary"
                    size="sm"
                    onClick={isCommitDisabled ? undefined : onCommit}
                    isDisabled={isCommitDisabled}
                    fontSize="12px"
                    fontFamily={SYSTEM_FONT_STACK}
                    border={RESERVED_BORDER}
                    _disabled={disabledButtonStyles}
                >
                    {isAmend ? t("commit.action.amend") : t("commit.action.commit")}
                </Button>
                <Button
                    data-testid="commit-action-push"
                    variant="primary"
                    size="sm"
                    onClick={onPush}
                    isDisabled={isPushButtonDisabled}
                    aria-disabled={isPushVisuallyDisabled || undefined}
                    fontSize="12px"
                    fontFamily={SYSTEM_FONT_STACK}
                    border={RESERVED_BORDER}
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
