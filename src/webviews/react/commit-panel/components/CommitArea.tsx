// Bottom area of the commit tab: amend checkbox, commit message textarea,
// and commit/commit+push buttons.

import React from "react";
import { Flex, Box, Textarea, Button, Checkbox } from "@chakra-ui/react";

interface Props {
    commitMessage: string;
    isAmend: boolean;
    onMessageChange: (message: string) => void;
    onAmendChange: (isAmend: boolean) => void;
    onCommit: () => void;
    onCommitAndPush: () => void;
}

export function CommitArea({
    commitMessage,
    isAmend,
    onMessageChange,
    onAmendChange,
    onCommit,
    onCommitAndPush,
}: Props): React.ReactElement {
    return (
        <Flex direction="column" overflow="hidden" flex={1}>
            <Flex align="center" gap="6px" px="8px" py="4px" fontSize="12px">
                <Checkbox
                    size="sm"
                    isChecked={isAmend}
                    onChange={(e) => onAmendChange(e.target.checked)}
                >
                    Amend
                </Checkbox>
            </Flex>
            <Box px="8px" flex={1} overflow="hidden">
                <Textarea
                    value={commitMessage}
                    onChange={(e) => onMessageChange(e.target.value)}
                    placeholder="Commit Message"
                    resize="none"
                    w="100%"
                    h="100%"
                    bg="var(--vscode-input-background)"
                    color="var(--vscode-input-foreground)"
                    border="1px solid"
                    borderColor="var(--vscode-input-border, var(--vscode-panel-border, #444))"
                    borderRadius="3px"
                    p="6px 8px"
                    fontFamily="var(--vscode-font-family)"
                    fontSize="var(--vscode-font-size)"
                    _placeholder={{ color: "var(--vscode-input-placeholderForeground)" }}
                    _focus={{ borderColor: "var(--vscode-focusBorder)" }}
                />
            </Box>
            <Flex align="center" gap="10px" p="6px 8px">
                <Button
                    variant="primary"
                    size="sm"
                    onClick={onCommit}
                    fontSize="13px"
                    fontFamily="var(--vscode-font-family)"
                >
                    Commit
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={onCommitAndPush}
                    fontSize="13px"
                    fontFamily="var(--vscode-font-family)"
                >
                    Commit and Push...
                </Button>
            </Flex>
        </Flex>
    );
}
