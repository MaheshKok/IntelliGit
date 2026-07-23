import React, { useMemo, useState } from "react";
import { Box, Button, Checkbox, Flex, Input } from "@chakra-ui/react";
import type { WorkingFile } from "../../../../types";

/** User-supplied shelf metadata and selected working-tree paths. */
export interface ShelveDialogSubmit {
    name: string;
    paths: string[];
}

/** Inputs and callbacks for the Shelve Changes dialog. */
export interface ShelveDialogProps {
    files: WorkingFile[];
    defaultName: string;
    selectedPaths: readonly string[];
    onClose: () => void;
    onSubmit: (input: ShelveDialogSubmit) => void;
}

/** File selection and name only; the host owns shelf-name validation and persistence. */
export function ShelveDialog({
    files,
    defaultName,
    selectedPaths,
    onClose,
    onSubmit,
}: ShelveDialogProps): React.ReactElement {
    const [name, setName] = useState(defaultName);
    const [selected, setSelected] = useState<Set<string>>(() => new Set(selectedPaths));
    const paths = useMemo(() => files.filter((file) => selected.has(file.path)).map((file) => file.path), [files, selected]);

    const toggle = (path: string): void => {
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
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
                if (event.currentTarget === event.target) onClose();
            }}
        >
            <Flex
                role="dialog"
                aria-modal="true"
                aria-labelledby="shelve-title"
                direction="column"
                gap="12px"
                w="min(420px, calc(100vw - 32px))"
                p="16px"
                border="1px solid var(--intelligit-pycharm-border)"
                borderRadius="4px"
                bg="var(--intelligit-pycharm-panel)"
                color="var(--intelligit-pycharm-foreground)"
            >
                <Box as="h2" id="shelve-title" fontSize="14px" fontWeight={600}>
                    Shelve Changes
                </Box>
                <Input
                    aria-label="Shelf name"
                    size="sm"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                />
                <Flex direction="column" gap="4px">
                    {files.map((file) => (
                        <Checkbox
                            key={file.path}
                            aria-label={file.path}
                            isChecked={selected.has(file.path)}
                            onChange={() => toggle(file.path)}
                        >
                            {file.path}
                        </Checkbox>
                    ))}
                </Flex>
                <Flex justify="flex-end" gap="8px">
                    <Button variant="secondary" size="sm" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        isDisabled={paths.length === 0}
                        onClick={() => onSubmit({ name, paths })}
                    >
                        Shelve Changes
                    </Button>
                </Flex>
            </Flex>
        </Flex>
    );
}
