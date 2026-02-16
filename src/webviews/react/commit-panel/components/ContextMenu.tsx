// Right-click context menu for file rows. Rendered via portal at the
// document body level, positioned at cursor coordinates with viewport clamping.

import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from "react";
import { Box } from "@chakra-ui/react";

export interface ContextMenuItem {
    label: string;
    action: string;
    separator?: boolean;
    icon?: React.ReactNode;
}

interface Props {
    x: number;
    y: number;
    items: ContextMenuItem[];
    onSelect: (action: string) => void;
    onClose: () => void;
}

export function ContextMenu({ x, y, items, onSelect, onClose }: Props): React.ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: x, top: y });

    useLayoutEffect(() => {
        if (!ref.current) return;
        const rect = ref.current.getBoundingClientRect();
        const pad = 4;
        let left = x;
        let top = y;
        if (top + rect.height > window.innerHeight - pad) {
            top = Math.max(pad, window.innerHeight - rect.height - pad);
        }
        if (left + rect.width > window.innerWidth - pad) {
            left = Math.max(pad, window.innerWidth - rect.width - pad);
        }
        setPos({ left, top });
    }, [x, y]);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        const handleContextMenu = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                e.preventDefault();
                onClose();
            }
        };
        document.addEventListener("mousedown", handleClick);
        document.addEventListener("keydown", handleKey);
        document.addEventListener("contextmenu", handleContextMenu);
        return () => {
            document.removeEventListener("mousedown", handleClick);
            document.removeEventListener("keydown", handleKey);
            document.removeEventListener("contextmenu", handleContextMenu);
        };
    }, [onClose]);

    const handleItemClick = useCallback(
        (action: string) => {
            onSelect(action);
            onClose();
        },
        [onSelect, onClose],
    );

    return (
        <Box
            ref={ref}
            position="fixed"
            left={`${pos.left}px`}
            top={`${pos.top}px`}
            zIndex={1000}
            bg="var(--vscode-menu-background, #252526)"
            border="1px solid"
            borderColor="var(--vscode-menu-border, #454545)"
            borderRadius="5px"
            py="4px"
            minW="180px"
            boxShadow="0 2px 8px rgba(0,0,0,0.35)"
        >
            {items.map((item, i) => {
                if (item.separator) {
                    return (
                        <Box
                            key={`sep-${i}`}
                            h="1px"
                            mx="8px"
                            my="4px"
                            bg="var(--vscode-menu-separatorBackground, #454545)"
                        />
                    );
                }
                return (
                    <Box
                        key={item.action}
                        display="flex"
                        alignItems="center"
                        gap="8px"
                        px="10px"
                        pr="20px"
                        py="4px"
                        cursor="pointer"
                        fontSize="12px"
                        color="var(--vscode-menu-foreground, #ccc)"
                        whiteSpace="nowrap"
                        _hover={{
                            bg: "var(--vscode-menu-selectionBackground, #094771)",
                            color: "var(--vscode-menu-selectionForeground, #fff)",
                        }}
                        onClick={() => handleItemClick(item.action)}
                    >
                        {item.icon && (
                            <Box as="span" w="14px" h="14px" flexShrink={0}>
                                {item.icon}
                            </Box>
                        )}
                        {item.label}
                    </Box>
                );
            })}
        </Box>
    );
}
