import React, { useRef } from "react";
import { Box, Button, Flex } from "@chakra-ui/react";
import { ChangesFileTree } from "../../shared/components/ChangesFileTree";
import { ContextMenu } from "../../shared/components/ContextMenu";
import { COMMIT_PANEL_SECTION_GUIDE_LEFT } from "../../shared/components/FileTreeRows";
import { t } from "../../shared/i18n";
import { directoryKey } from "../../shared/treeExpansion";
import { CleanUpDialog } from "./CleanUpDialog";
import { ShelfList } from "./ShelfList";
import { resultMessage, statusMessage } from "./ShelfMessages";
import { shelfFileDragStart } from "./shelfDrag";
import {
    RenameStructuralDialog,
    ShelfDeleteConfirmation,
    ShelfHealthWarningBanner,
} from "./ShelfTabDialogs";
import { ShelfToolbar } from "./ShelfToolbar";
import type { ShelfTabController } from "./ShelfTabController";
import type { ShelfTabProps } from "./ShelfTabTypes";
import { getShelfMenuItems } from "./shelfMenu";
import { UnshelveDialog } from "./UnshelveDialog";

interface ShelfTabViewProps {
    controller: ShelfTabController;
    props: ShelfTabProps & { shelfHealth: NonNullable<ShelfTabProps["shelfHealth"]> };
}

/** Composes the shelf list, status feedback, and overlays without owning mutation state. */
export function ShelfTabView({ controller, props }: ShelfTabViewProps): React.ReactElement {
    const tabRef = useRef<HTMLDivElement>(null);
    return (
        <Flex
            ref={tabRef}
            data-testid="shelf-tab"
            direction="column"
            flex={1}
            minH={0}
            overflow="hidden"
            bg="var(--intelligit-pycharm-panel)"
            color="var(--intelligit-pycharm-foreground)"
            onDragOver={props.onDragOver}
            onDrop={props.onDrop}
            onKeyDown={controller.handleShelfShortcut}
        >
            <ShelfHealthWarningBanner warnings={props.shelfHealth} />
            <ShelfToolbar
                canExpandOrCollapse={props.shelves.length > 0}
                groupByDir={props.groupByDir ?? false}
                isRefreshing={props.isRefreshing ?? false}
                onRefresh={props.onRefresh}
                showAlreadyUnshelved={controller.showAlreadyUnshelved}
                onToggleGroupBy={props.onToggleGroupBy}
                onExpandAll={controller.expandAll}
                onCollapseAll={controller.collapseAll}
                onToggleAlreadyUnshelved={controller.toggleAlreadyUnshelved}
                onCleanUp={controller.openCleanUp}
            />
            <ShelfList
                shelves={props.shelves}
                selectedShelfId={controller.displayedSelectedShelfId}
                hasSelectedFile={controller.selectedFile !== null}
                showAlreadyUnshelved={controller.showAlreadyUnshelved}
                expandedShelfIds={controller.expandedShelfIds}
                renamingShelfId={controller.renamingShelfId}
                renameError={controller.renameError}
                onSelect={controller.selectShelf}
                onToggleExpand={controller.toggleShelfExpansion}
                renderSubtree={(shelf) => (
                    <ShelfFileSubtree controller={controller} props={props} shelf={shelf} />
                )}
                onContextMenu={controller.openContextMenu}
                onRenameSubmit={controller.onRenameSubmit}
                onRenameCancel={controller.onRenameCancel}
                onRestore={(shelf) => controller.handleContextAction(shelf, "restore")}
                onDragStart={controller.handleShelfRowDragStart}
            />
            <ShelfMutationOutcomeRegion controller={controller} props={props} />
            <ShelfTabOverlays controller={controller} props={props} />
        </Flex>
    );
}

interface ShelfFileSubtreeProps extends ShelfTabViewProps {
    shelf: ShelfTabProps["shelves"][number];
}

/** Renders one expanded shelf's immutable files through the shared file tree. */
function ShelfFileSubtree({ controller, props, shelf }: ShelfFileSubtreeProps): React.ReactElement {
    const onDragStart = shelfFileDragStart(props.onShelfEntryDragStart, shelf);
    return (
        <ChangesFileTree
            files={controller.shelfDisplayFilesById.get(shelf.id)?.files ?? []}
            groupByDir={props.groupByDir ?? false}
            depth={0}
            sectionGuideLeft={COMMIT_PANEL_SECTION_GUIDE_LEFT}
            selectedId={
                controller.selectedFile?.shelfId === shelf.id
                    ? controller.selectedFile.changeId
                    : null
            }
            getId={(file) => file.shelfEntry.changeId}
            isDirectoryCollapsed={(path) =>
                controller.collapsedDirectories.has(directoryKey(shelf.id, path))
            }
            onToggleDirectory={(path) => controller.toggleDirectory(shelf.id, path)}
            folderIcon={props.folderIcon}
            folderExpandedIcon={props.folderExpandedIcon}
            folderIconsByName={props.folderIconsByName}
            onSelect={(file) => controller.onFileSelect(shelf, file)}
            onActivate={(file) => controller.onFileActivate(shelf, file)}
            onContextMenu={(file, x, y, target) =>
                controller.onFileContextMenu(shelf, file, x, y, target)
            }
            onDragStart={
                onDragStart ? (event, file) => onDragStart(event, file.shelfEntry) : undefined
            }
            dataAttributes={(file) => ({ "shelf-file": file.shelfEntry.changeId })}
            emptyState={
                <Box px="12px" py="6px" fontSize="12px" color="var(--intelligit-pycharm-muted)">
                    {t("shelf.filePane.empty")}
                </Box>
            }
        />
    );
}

/** Announces reportable mutation outcomes and exposes conflict-resolution actions. */
function ShelfMutationOutcomeRegion({ controller, props }: ShelfTabViewProps): React.ReactElement {
    const { outcomeShelf, reportedOutcome } = controller;
    return (
        <Box
            role="region"
            aria-label={t("a11y.shelfMutationOutcome")}
            aria-live="polite"
            flexShrink={0}
            maxH={reportedOutcome ? "160px" : undefined}
            overflowY={reportedOutcome ? "auto" : undefined}
            p={reportedOutcome ? "10px" : 0}
            fontSize="12px"
        >
            {reportedOutcome ? (
                <>
                    <Box data-testid="shelf-mutation-status" fontWeight={600}>
                        {statusMessage(reportedOutcome.status)}
                    </Box>
                    {reportedOutcome.entries.map((result) => (
                        <Box key={`${result.changeId}-${result.kind}`} mt="3px">
                            {result.changeId}: {resultMessage(result)}
                            {result.kind === "conflicted" && outcomeShelf ? (
                                <Button
                                    ml="6px"
                                    size="xs"
                                    variant="secondary"
                                    onClick={() =>
                                        props.onOpenConflictEditor({
                                            type: "shelfOpenConflictEditor",
                                            repositoryRoot: props.repositoryRoot,
                                            shelfId: outcomeShelf.id,
                                            changeId: result.changeId,
                                        })
                                    }
                                >
                                    {t("shelf.action.merge")}
                                </Button>
                            ) : null}
                            {result.kind === "structuralPending" && outcomeShelf ? (
                                <Flex as="span" display="inline-flex" gap="4px" ml="6px">
                                    <Button
                                        size="xs"
                                        variant="secondary"
                                        isDisabled={controller.structuralPendingRequestId !== null}
                                        onClick={() =>
                                            controller.resolveStructural(result, "keepLocal")
                                        }
                                    >
                                        {t("shelf.action.keepLocal")}
                                    </Button>
                                    <Button
                                        size="xs"
                                        variant="secondary"
                                        isDisabled={controller.structuralPendingRequestId !== null}
                                        onClick={() =>
                                            controller.resolveStructural(result, "useShelved")
                                        }
                                    >
                                        {t("shelf.action.useShelved")}
                                    </Button>
                                    <Button
                                        size="xs"
                                        variant="secondary"
                                        isDisabled={controller.structuralPendingRequestId !== null}
                                        onClick={() =>
                                            controller.resolveStructural(result, "deleteLocal")
                                        }
                                    >
                                        {t("shelf.action.deleteLocal")}
                                    </Button>
                                    <Button
                                        size="xs"
                                        variant="secondary"
                                        isDisabled={controller.structuralPendingRequestId !== null}
                                        onClick={() => controller.openRenameStructural(result)}
                                    >
                                        {t("shelf.action.renameLocalMenu")}
                                    </Button>
                                </Flex>
                            ) : null}
                        </Box>
                    ))}
                    {reportedOutcome.requestId === controller.lastExportRequestId &&
                    reportedOutcome.status === "ok" &&
                    !reportedOutcome.message ? (
                        <Box mt="3px">{t("shelf.status.exportFlattened")}</Box>
                    ) : null}
                </>
            ) : null}
        </Box>
    );
}

/** Renders context menus and dialogs from the shelf controller's current local state. */
function ShelfTabOverlays({ controller, props }: ShelfTabViewProps): React.ReactElement {
    return (
        <>
            {controller.contextMenu ? (
                <ContextMenu
                    x={controller.contextMenu.x}
                    y={controller.contextMenu.y}
                    minWidth={220}
                    onClose={controller.closeContextMenu}
                    onSelect={(action) =>
                        controller.handleContextAction(
                            controller.contextMenu!.shelf,
                            action as import("./ShelfRow").ShelfContextAction,
                            controller.contextMenu!.targetChangeId,
                        )
                    }
                    items={getShelfMenuItems({
                        shelf: controller.contextMenu.shelf,
                        targetChangeId: controller.contextMenu.targetChangeId,
                        shelfFilesAreCurrent: true,
                        canUnshelve: controller.canUnshelve,
                        canExportPatch:
                            controller.contextMenu.targetChangeId !== undefined ||
                            controller.contextMenu.shelf.files.length > 0,
                        isMac: controller.isMacWebview,
                    })}
                />
            ) : null}
            {controller.unshelveShelf ? (
                <UnshelveDialog
                    entries={controller.unshelveShelf.files}
                    defaultRemoveFromShelf={props.shelfRemoveOnUnshelve ?? true}
                    returnFocusTarget={controller.dialogFocusTargetRef.current}
                    onClose={controller.closeUnshelve}
                    onSubmit={controller.submitUnshelve}
                />
            ) : null}
            {controller.deleteShelf ? (
                <ShelfDeleteConfirmation
                    shelf={controller.deleteShelf}
                    returnFocusTarget={controller.dialogFocusTargetRef.current}
                    onClose={controller.closeDelete}
                    onConfirm={controller.confirmDelete}
                />
            ) : null}
            {controller.isCleanUpOpen ? (
                <CleanUpDialog
                    shelves={props.shelves}
                    returnFocusTarget={controller.dialogFocusTargetRef.current}
                    onClose={controller.closeCleanUp}
                    onSubmit={controller.submitCleanUp}
                />
            ) : null}
            {controller.renameStructuralResult ? (
                <RenameStructuralDialog
                    path={controller.renameStructuralResult.path}
                    returnFocusTarget={controller.dialogFocusTargetRef.current}
                    onClose={controller.closeRenameStructural}
                    onConfirm={controller.confirmRenameStructural}
                />
            ) : null}
        </>
    );
}
