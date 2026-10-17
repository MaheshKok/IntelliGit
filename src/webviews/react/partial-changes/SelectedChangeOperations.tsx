import React, { useRef, useState } from "react";
import { VscArchive, VscDiscard, VscEllipsis, VscExport, VscSave } from "react-icons/vsc";
import { ContextMenu, type MenuCloseReason } from "../shared/components/ContextMenu";
import { t } from "../shared/i18n";
import type { PartialEditorOutbound } from "../../protocol/changelists";

type Operation = Extract<PartialEditorOutbound, { type: "selectedOperation" }>["operation"];

/** Reuses the workbench menu and its keyboard behavior instead of widening the compact action row. */
export function SelectedChangeOperations({
    enabled,
    canShelf,
    canRemove,
    onChoose,
}: {
    enabled: boolean;
    canShelf: boolean;
    canRemove: boolean;
    onChoose: (operation: Operation) => void;
}) {
    const button = useRef<HTMLButtonElement>(null);
    const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
    const close = (reason?: MenuCloseReason) => {
        setAnchor(null);
        if (reason === "escape") button.current?.focus();
    };
    return (
        <>
            <button
                ref={button}
                className="partial-more-actions"
                title={t("changes.moreActions")}
                aria-label={t("changes.moreActions")}
                aria-haspopup="menu"
                aria-expanded={anchor !== null}
                disabled={!enabled}
                onClick={() => {
                    const bounds = button.current!.getBoundingClientRect();
                    setAnchor(anchor ? null : { x: bounds.left, y: bounds.bottom + 4 });
                }}
            >
                <VscEllipsis />
            </button>
            {anchor && (
                <ContextMenu
                    x={anchor.x}
                    y={anchor.y}
                    items={[
                        {
                            label: t("changes.exportPatch"),
                            action: "export",
                            icon: <VscExport />,
                            disabled: !enabled,
                        },
                        {
                            label: t("shelf.action.save"),
                            action: "save",
                            icon: <VscSave />,
                            disabled: !enabled || !canShelf,
                        },
                        {
                            label: t("changes.shelveSelected"),
                            action: "shelve",
                            icon: <VscArchive />,
                            disabled: !enabled || !canShelf || !canRemove,
                        },
                        { label: "", action: "", separator: true },
                        {
                            label: t("changes.rollbackSelected"),
                            action: "rollback",
                            icon: <VscDiscard />,
                            disabled: !enabled || !canShelf || !canRemove,
                        },
                    ]}
                    onClose={close}
                    onSelect={(operation) => {
                        if (
                            operation === "export" ||
                            operation === "save" ||
                            operation === "shelve" ||
                            operation === "rollback"
                        )
                            onChoose(operation);
                    }}
                />
            )}
        </>
    );
}
