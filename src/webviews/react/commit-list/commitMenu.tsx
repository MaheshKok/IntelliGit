import React from "react";
import type { Commit } from "../../../types";
import type { CommitAction } from "../commitGraphTypes";
import type { MenuItem } from "../shared/components/ContextMenu";
import { t } from "../shared/i18n";

type SeparatorAction = `sep-${string}`;
type CommitMenuItem = Omit<MenuItem, "action"> & { action: CommitAction | SeparatorAction };

export function getCommitMenuItems(
    commit: Commit,
    isUnpushed: boolean,
    canCherryPick: boolean,
): CommitMenuItem[] {
    const isPushed = !isUnpushed;
    const isMergeCommit = commit.parentHashes.length > 1;

    const items: CommitMenuItem[] = [
        { label: t("commit.menu.copyRevision"), action: "copyRevision", icon: iconCopy() },
        { label: t("commit.menu.createPatch"), action: "createPatch", icon: iconPatch() },
        {
            label: t("commit.menu.cherryPick"),
            action: "cherryPick",
            disabled: !canCherryPick,
            icon: iconCherry(),
        },
        { separator: true, label: "", action: "sep-checkout" },
    ];

    items.push({ label: t("commit.menu.checkoutRevision"), action: "checkoutRevision" });

    items.push({ separator: true, label: "", action: "sep-reset" });
    items.push({
        label: t("commit.menu.resetCurrentToHere"),
        action: "resetCurrentToHere",
        icon: iconReset(),
    });
    items.push({ label: t("commit.menu.revertCommit"), action: "revertCommit" });
    items.push({
        label: t("commit.menu.pushAllUpToHere"),
        action: "pushAllUpToHere",
        disabled: isPushed,
        icon: iconPush(),
    });
    items.push({
        label: t("commit.menu.undoCommit"),
        action: "undoCommit",
        disabled: isPushed || isMergeCommit,
    });

    items.push({ separator: true, label: "", action: "sep-history" });
    items.push({
        label: t("commit.menu.editMessage"),
        action: "editCommitMessage",
        disabled: isPushed || isMergeCommit,
    });
    items.push({
        label: t("commit.menu.squashCommits"),
        action: "squashCommits",
        disabled: isPushed || isMergeCommit,
    });
    items.push({
        label: t("commit.menu.dropCommit"),
        action: "dropCommit",
        disabled: isPushed || isMergeCommit,
    });
    items.push({
        label: t("commit.menu.interactiveRebaseFromHere"),
        action: "interactiveRebaseFromHere",
        disabled: isPushed || isMergeCommit,
    });

    items.push({ separator: true, label: "", action: "sep-create" });
    items.push({ label: t("commit.menu.newBranch"), action: "newBranch" });
    items.push({ label: t("commit.menu.newTag"), action: "newTag" });

    return items;
}

function iconCopy(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path
                fill="currentColor"
                d="M3 2h8a1 1 0 0 1 1 1v1h-1V3H3v8H2V3a1 1 0 0 1 1-1zm2 3h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm0 1v8h8V6H5z"
            />
        </svg>
    );
}

function iconPatch(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path
                fill="currentColor"
                d="M6.5 1a2.5 2.5 0 0 0 0 5h1V4h1v2h1a2.5 2.5 0 1 0 0-5h-1v2h-1V1h-1zm-4 7h4v1h-4V8zm0 3h7v1h-7v-1zm6 1.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0zm1 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0z"
            />
        </svg>
    );
}

function iconCherry(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path
                fill="currentColor"
                d="M8.2 3.2a2.2 2.2 0 1 0-2.4-2.2h1a1.2 1.2 0 1 1 1.2 1.2H6.9c-2.6 0-4.7 2-4.7 4.6 0 2.2 1.8 4 4 4a3.9 3.9 0 0 0 2-7.2V3.2zm-2 6.6a2.9 2.9 0 1 1 0-5.8 2.9 2.9 0 0 1 0 5.8zm4.6-5.2a3.9 3.9 0 1 0 0 7.8 3.9 3.9 0 0 0 0-7.8z"
            />
        </svg>
    );
}

function iconReset(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path
                fill="currentColor"
                d="M8 2a6 6 0 1 1-4.8 2.4L1 6.6V2h4.6L4 3.6A5 5 0 1 0 8 3v-1z"
            />
        </svg>
    );
}

function iconPush(): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path
                fill="currentColor"
                d="M8 1l3 3H9v5H7V4H5l3-3zm-4 9h8a2 2 0 0 1 2 2v3h-1v-3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v3H2v-3a2 2 0 0 1 2-2z"
            />
        </svg>
    );
}
