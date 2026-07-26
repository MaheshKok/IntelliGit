// Collapsible section headers shared by the commit panel and commit-info pane.

import React from "react";
import { Box, Flex } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import { ChevronIcon } from "./Icons";
import { VscCheckbox } from "./VscCheckbox";
import { t } from "../i18n";
import { JETBRAINS_UI } from "../tokens";

interface SectionStats {
    additions: number;
    deletions: number;
}

interface SectionCheckbox {
    isAllChecked: boolean;
    isSomeChecked: boolean;
    onToggle: () => void;
    visibility?: "visible" | "hidden" | "none";
}

interface SectionDragState {
    isOver?: boolean;
    onDragOver?: React.DragEventHandler<HTMLDivElement>;
    onDragLeave?: React.DragEventHandler<HTMLDivElement>;
    onDrop?: React.DragEventHandler<HTMLDivElement>;
}

interface CommitPanelSectionHeaderProps {
    variant?: "commit-panel";
    label: string;
    count?: number;
    stats?: SectionStats;
    isOpen?: boolean;
    onToggleOpen?: () => void;
    checkbox?: SectionCheckbox;
    drag?: SectionDragState;
}

interface CommitInfoSectionHeaderProps {
    variant: "commit-info";
    label: string;
    stats?: SectionStats;
    expanded?: boolean;
    onToggle?: () => void;
    borderBottom?: boolean;
}

type SectionHeaderProps = CommitPanelSectionHeaderProps | CommitInfoSectionHeaderProps;

/** Renders a commit-panel selection header or the DOM-preserving commit-info header. */
export function SectionHeader(props: SectionHeaderProps): React.ReactElement {
    if (props.variant === "commit-info") return <CommitInfoSectionHeader {...props} />;
    return <CommitPanelSectionHeader {...props} />;
}

function CommitPanelSectionHeader({
    label,
    count = 0,
    stats,
    isOpen = false,
    onToggleOpen,
    checkbox,
    drag,
}: CommitPanelSectionHeaderProps): React.ReactElement {
    const checkboxVisibility = checkbox?.visibility ?? "visible";
    const isDragOver = drag?.isOver ?? false;
    return (
        <Flex
            align="center"
            gap="4px"
            px="5px"
            py="2px"
            mx="4px"
            my="1px"
            borderRadius="5px"
            cursor="pointer"
            userSelect="none"
            fontWeight={600}
            fontSize="12px"
            fontFamily={SYSTEM_FONT_STACK}
            lineHeight="22px"
            position="relative"
            color="var(--intelligit-pycharm-foreground)"
            bg={
                isDragOver
                    ? "var(--intelligit-pycharm-focus-border, var(--intelligit-pycharm-blue))"
                    : "var(--intelligit-pycharm-selected)"
            }
            outline={isDragOver ? "2px solid var(--intelligit-pycharm-blue)" : "none"}
            outlineOffset="-1px"
            tabIndex={0}
            role="button"
            aria-expanded={isOpen}
            onClick={(event) => {
                if ((event.target as HTMLElement).tagName !== "INPUT") onToggleOpen?.();
            }}
            onKeyDown={(event) => {
                if ((event.target as HTMLElement).tagName === "INPUT") return;
                if (event.key === "Enter" || event.key === " ") {
                    if (event.key === " ") event.preventDefault();
                    onToggleOpen?.();
                }
            }}
            onDragOver={drag?.onDragOver}
            onDragLeave={drag?.onDragLeave}
            onDrop={drag?.onDrop}
        >
            <ChevronIcon expanded={isOpen} />
            {checkboxVisibility === "hidden" ? (
                <Box as="span" aria-hidden="true" w="14px" h="14px" flexShrink={0} />
            ) : checkboxVisibility === "visible" && checkbox ? (
                <VscCheckbox
                    isChecked={checkbox.isAllChecked}
                    isIndeterminate={checkbox.isSomeChecked}
                    onChange={checkbox.onToggle}
                    ariaLabel={label}
                />
            ) : null}
            <Box as="span">{label}</Box>
            <Box
                as="span"
                color="var(--intelligit-pycharm-muted)"
                opacity={0.88}
                fontWeight="normal"
                fontSize="11px"
            >
                {t("common.fileCount", { count })}
            </Box>
            {stats && (stats.additions > 0 || stats.deletions > 0) ? (
                <Box as="span" ml="auto" fontSize="11px" flexShrink={0}>
                    {stats.additions > 0 ? (
                        <Box
                            as="span"
                            color="var(--intelligit-pycharm-added)"
                            mr={stats.deletions > 0 ? "3px" : "0"}
                        >
                            +{stats.additions}
                        </Box>
                    ) : null}
                    {stats.deletions > 0 ? (
                        <Box as="span" color="var(--intelligit-pycharm-deleted)">
                            -{stats.deletions}
                        </Box>
                    ) : null}
                </Box>
            ) : null}
        </Flex>
    );
}

function CommitInfoSectionHeader({
    label,
    expanded = false,
    onToggle,
    stats,
    borderBottom = false,
}: CommitInfoSectionHeaderProps): React.ReactElement {
    return (
        <Box
            display="flex"
            alignItems="center"
            px="8px"
            py="4px"
            fontWeight={600}
            fontSize="12px"
            color={JETBRAINS_UI.color.muted}
            bg={JETBRAINS_UI.color.toolbar}
            borderBottom={borderBottom ? `1px solid ${JETBRAINS_UI.color.border}` : undefined}
            cursor={onToggle ? "pointer" : undefined}
            tabIndex={onToggle ? 0 : undefined}
            role={onToggle ? "button" : undefined}
            aria-expanded={onToggle ? expanded : undefined}
            onClick={onToggle}
            onKeyDown={
                onToggle
                    ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onToggle();
                          }
                      }
                    : undefined
            }
        >
            <ChevronIcon expanded={expanded} />
            <Box as="span">{label}</Box>
            {stats && (stats.additions > 0 || stats.deletions > 0) && (
                <Box as="span" ml="auto" fontSize="11px" flexShrink={0}>
                    {stats.additions > 0 && (
                        <Box
                            as="span"
                            color="var(--intelligit-pycharm-added)"
                            mr={stats.deletions > 0 ? "4px" : "0"}
                        >
                            +{stats.additions}
                        </Box>
                    )}
                    {stats.deletions > 0 && (
                        <Box as="span" color="var(--intelligit-pycharm-deleted)">
                            -{stats.deletions}
                        </Box>
                    )}
                </Box>
            )}
        </Box>
    );
}
