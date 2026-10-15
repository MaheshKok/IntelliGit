import React from "react";
import {
    VscAdd,
    VscEdit,
    VscTrash,
    VscStarEmpty,
    VscArrowRight,
    VscDiff,
    VscClearAll,
    VscWarning,
} from "react-icons/vsc";
import { t } from "../../shared/i18n";
import type { useChangelists } from "../hooks/useChangelists";

type Workflow = ReturnType<typeof useChangelists>;
const buttonStyle: React.CSSProperties = {
    width: 24,
    height: 24,
    flexShrink: 0,
    padding: 0,
    border: 0,
    borderRadius: 2,
    color: "var(--vscode-foreground)",
    background: "transparent",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
};

/** Compact list controls operate only on metadata and an explicitly selected file. */
export function ChangelistToolbar({
    workflow,
    disabled,
}: {
    workflow: Workflow;
    disabled: boolean;
}) {
    const state = workflow.metadata;
    if (!state) return null;
    const own = workflow.filter !== "all";
    const tools = [
        {
            icon: VscAdd,
            label: t("changes.newList"),
            run: () => workflow.command("create"),
            disabled: false,
        },
        {
            icon: VscEdit,
            label: t("changes.editList"),
            run: () => workflow.command("rename"),
            disabled: !own,
        },
        {
            icon: VscTrash,
            label: t("changes.removeList"),
            run: () => workflow.command("remove"),
            disabled: !own,
        },
        {
            icon: VscStarEmpty,
            label: t("changes.makeActive"),
            run: () => workflow.command("activate"),
            disabled: workflow.filter === "all" || workflow.filter === state.activeId,
        },
        {
            icon: VscArrowRight,
            label: t("changes.moveSelected"),
            run: () => workflow.command("move"),
            disabled:
                workflow.checkedPaths.size === 0 ||
                [...workflow.checkedPaths].some((file) => workflow.partialPaths.has(file)),
        },
        {
            icon: VscDiff,
            label: t("changes.partial"),
            run: workflow.openPartial,
            disabled: workflow.checkedPaths.size !== 1,
        },
        {
            icon: VscClearAll,
            label: t("changes.wholeFile"),
            run: () => workflow.command("resetSelection"),
            disabled: ![...workflow.checkedPaths].some(
                (file) => state.changes[file]?.selections?.[workflow.filter] !== undefined,
            ),
        },
    ];
    return (
        <div
            style={{
                display: "flex",
                gap: 2,
                alignItems: "center",
                padding: "3px 8px",
                borderBottom: "1px solid var(--vscode-panel-border)",
                minHeight: 30,
            }}
        >
            <select
                aria-label={t("changes.changelists")}
                value={workflow.filter}
                onChange={(event) => workflow.choose(event.currentTarget.value)}
                disabled={disabled || workflow.busy}
                style={{
                    minWidth: 80,
                    flex: "1 1 auto",
                    width: 0,
                    height: 24,
                    fontSize: 12,
                    color: "var(--vscode-input-foreground)",
                    background: "var(--vscode-input-background)",
                    border: "1px solid var(--vscode-input-border)",
                    borderRadius: 2,
                }}
            >
                <option value="all">{t("changes.all")}</option>
                {state.lists.map((list) => (
                    <option key={list.id} value={list.id}>
                        {list.name}
                        {list.id === state.activeId ? ` (${t("changes.active")})` : ""}
                    </option>
                ))}
            </select>
            {workflow.hasRecoveryIssues ? (
                <button
                    type="button"
                    style={buttonStyle}
                    title={t("changes.reviewRecovery")}
                    aria-label={t("changes.reviewRecovery")}
                    disabled={disabled || workflow.busy}
                    onClick={() => workflow.command("reviewRecovery")}
                >
                    <VscWarning />
                </button>
            ) : null}
            {tools.map((tool) => (
                <button
                    key={tool.label}
                    title={tool.label}
                    aria-label={tool.label}
                    style={buttonStyle}
                    onClick={tool.run}
                    disabled={disabled || workflow.busy || tool.disabled}
                >
                    <tool.icon size={15} />
                </button>
            ))}
        </div>
    );
}
