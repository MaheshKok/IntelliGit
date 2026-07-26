import React from "react";
import type { ShelfHealthWarning } from "../../../protocol/commitPanelMessages";
import { useShelfTabController } from "./ShelfTabController";
import type { ShelfTabProps } from "./ShelfTabTypes";
import { ShelfTabView } from "./ShelfTabView";

export type { ShelfMutationOutcome, ShelfTabProps } from "./ShelfTabTypes";

const EMPTY_SHELF_HEALTH: ShelfHealthWarning[] = [];

/** Renders the shelf surface while keeping selection, dialogs, and mutations in a focused controller. */
export function ShelfTab({
    shelfHealth = EMPTY_SHELF_HEALTH,
    ...props
}: ShelfTabProps): React.ReactElement {
    const resolvedProps = { ...props, shelfHealth };
    const controller = useShelfTabController(resolvedProps);
    return <ShelfTabView controller={controller} props={resolvedProps} />;
}
