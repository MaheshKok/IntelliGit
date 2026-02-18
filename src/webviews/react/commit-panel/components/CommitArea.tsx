// Bottom area of the commit tab: amend checkbox, commit message textarea,
// and commit/commit+push buttons.

import React from "react";
import { Flex, Box, Textarea, Button } from "@chakra-ui/react";
import { VscCheckbox } from "./VscCheckbox";

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
            <Flex align="center" gap="5px" px="7px" py="3px" fontSize="12px" minH="24px">
                <VscCheckbox isChecked={isAmend} onChange={() => onAmendChange(!isAmend)} />
                <Box as="span" color="var(--vscode-foreground)" opacity={0.9}>
                    Amend
                </Box>
            </Flex>
            <Box px="7px" flex={1} overflow="hidden">
                <Textarea
                    value={commitMessage}
                    onChange={(e) => onMessageChange(e.target.value)}
                    placeholder="Commit Message"
                    resize="none"
                    w="100%"
                    h="100%"
                    bg="rgba(16, 21, 31, 0.72)"
                    color="var(--vscode-input-foreground)"
                    border="1px solid"
                    borderColor="rgba(176, 186, 205, 0.35)"
                    borderRadius="3px"
                    p="7px 9px"
                    fontFamily="var(--vscode-font-family)"
                    fontSize="12px"
                    _placeholder={{ color: "var(--vscode-input-placeholderForeground)" }}
                    _focus={{ borderColor: "#5a8fe9" }}
                />
            </Box>
            <Flex align="center" gap="8px" p="6px 7px 8px">
                <Button
                    variant="primary"
                    size="sm"
                    onClick={onCommit}
                    fontSize="12px"
                    fontFamily="var(--vscode-font-family)"
                >
                    Commit
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={onCommitAndPush}
                    fontSize="12px"
                    fontFamily="var(--vscode-font-family)"
                >
                    Commit and Push...
                </Button>
            </Flex>
        </Flex>
    );
}
