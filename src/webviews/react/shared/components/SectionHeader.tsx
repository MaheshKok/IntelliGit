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

/**
 * Heading wrapper around a section's toggle row.
 *
 * The APG disclosure pattern nests the control inside a heading rather than
 * putting heading semantics on the control, so screen-reader users can move
 * between sections with heading navigation while the row keeps its button role
 * and expanded state. The wrapper paints nothing and inherits its typography, so
 * the row lays out exactly as it did before.
 */
function SectionHeading({ children }: { children: React.ReactNode }): React.ReactElement {
    return (
        <Box
            as="h3"
            m={0}
            color="inherit"
            fontFamily="inherit"
            fontSize="inherit"
            fontWeight="inherit"
            lineHeight="inherit"
        >
            {children}
        </Box>
    );
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
        <SectionHeading>
            <Flex
                align="center"
                gap="4px"
                px="6px"
                py="2px"
                mx="4px"
                my="1px"
                borderRadius={`${JETBRAINS_UI.size.selectedRadius}px`}
                cursor="pointer"
                userSelect="none"
                fontWeight={600}
                fontSize="12px"
                fontFamily={SYSTEM_FONT_STACK}
                lineHeight={`${JETBRAINS_UI.size.treeRowHeight}px`}
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
                    // Tabular figures keep the counts a fixed width, so the +/-
                    // pair stops jittering as a section's numbers change under it.
                    //
                    // These counts deliberately carry NO diff-status colour, unlike the
                    // per-file counts in FileTreeRows. The header row above sets
                    // `bg="var(--intelligit-pycharm-selected)"` unconditionally -- it is
                    // always drawn on the selection background, not only when something is
                    // selected -- and the status colours are chosen to sit on the panel
                    // background. Measured on that surface they came out at 1.4:1
                    // (HC Black, deleted), 2.6:1 (Dark Modern, deleted), 4.0:1 and 4.3:1
                    // for added. Inheriting the header's own foreground is the same
                    // resolution used for selected file rows, and unlike desaturating the
                    // tokens it costs nothing on the rows that are NOT on this surface.
                    <Box
                        as="span"
                        ml="auto"
                        fontSize="11px"
                        flexShrink={0}
                        sx={{ fontVariantNumeric: "tabular-nums" }}
                    >
                        {stats.additions > 0 ? (
                            <Box as="span" mr={stats.deletions > 0 ? "3px" : "0"}>
                                +{stats.additions}
                            </Box>
                        ) : null}
                        {stats.deletions > 0 ? <Box as="span">-{stats.deletions}</Box> : null}
                    </Box>
                ) : null}
            </Flex>
        </SectionHeading>
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
        <SectionHeading>
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
        </SectionHeading>
    );
}
