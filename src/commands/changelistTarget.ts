import * as vscode from "vscode";
import type { ChangelistState } from "../webviews/protocol/changeSelection";
import type { ChangelistTarget, ShelfDraftChoice } from "../webviews/protocol/changelists";

/** Captured source identity and draft remain available after the live list changes or disappears. */
export interface CapturedSourceList {
    readonly id: string;
    readonly name: string;
    readonly draft: string;
}

/** Inputs are authoritative snapshots; the picker itself never creates or changes a list. */
export interface ChangelistTargetPrompt {
    readonly state: ChangelistState;
    readonly suggestedName?: string;
    readonly sourceLists?: readonly CapturedSourceList[];
}

/** Immutable prompt result revalidated under the metadata lease by the eventual mutator. */
export interface ChangelistTargetSelection {
    readonly target: ChangelistTarget;
    readonly draftChoice?: ShelfDraftChoice;
}

type TargetPick = vscode.QuickPickItem & {
    readonly targetKind: "existing" | "new";
    readonly target?: Extract<ChangelistTarget, { kind: "existing" }>;
};

type DraftPick = vscode.QuickPickItem & { readonly choice: ShelfDraftChoice };

/** Collects destination and optional draft intent without performing metadata or Git mutations. */
export async function pickChangelistTarget(
    prompt: ChangelistTargetPrompt,
): Promise<ChangelistTargetSelection | undefined> {
    const targets: TargetPick[] = prompt.state.lists.map((list) => ({
        label: list.name,
        description: vscode.l10n.t("Existing changelist"),
        targetKind: "existing",
        target: { kind: "existing", id: list.id, revision: prompt.state.revision },
    }));
    if (prompt.state.lists.length < 100)
        targets.push({
            label: vscode.l10n.t("Create New Changelist…"),
            description: vscode.l10n.t("Choose a name without creating it yet"),
            targetKind: "new",
        });
    const picked = await vscode.window.showQuickPick(targets, {
        placeHolder: vscode.l10n.t("Select a destination changelist"),
    });
    if (!picked) return undefined;

    let target: ChangelistTarget;
    let destinationDraft = "";
    if (picked.targetKind === "existing" && picked.target) {
        const existingTarget = picked.target;
        target = existingTarget;
        destinationDraft =
            prompt.state.lists.find((list) => list.id === existingTarget.id)?.draft ?? "";
    } else {
        const name = await vscode.window.showInputBox({
            prompt: vscode.l10n.t("Name the new destination changelist"),
            value: prompt.suggestedName,
            validateInput: (value) => targetNameError(prompt.state, value),
        });
        if (name === undefined) return undefined;
        const normalized = normalizedTargetName(name);
        if (!normalized || targetNameError(prompt.state, normalized)) return undefined;
        target = { kind: "new", name: normalized, revision: prompt.state.revision };
    }

    const sources = new Map<string, CapturedSourceList>();
    for (const source of prompt.sourceLists ?? [])
        if (!sources.has(source.id)) sources.set(source.id, source);
    if (sources.size === 0) return { target };
    const drafts: DraftPick[] = [
        {
            label: vscode.l10n.t("Keep Destination Draft"),
            detail: destinationDraft,
            choice: { kind: "keep" },
        },
        ...[...sources.values()].map((list) => ({
            label: vscode.l10n.t("Copy Draft from {name}", { name: list.name }),
            description: vscode.l10n.t("Replaces the destination draft shown below"),
            detail: `${list.draft ?? ""}\n${vscode.l10n.t("Current destination draft: {draft}", {
                draft: destinationDraft,
            })}`,
            choice: {
                kind: "copySource" as const,
                sourceListId: list.id,
                expectedDestinationDraft: destinationDraft,
            },
        })),
    ];
    const draft = await vscode.window.showQuickPick(drafts, {
        placeHolder: vscode.l10n.t("Choose how to handle the destination draft"),
    });
    return draft ? { target, draftChoice: draft.choice } : undefined;
}

/** Rejects stale or missing destinations before a caller begins its guarded mutation. */
export function assertChangelistTargetCurrent(
    state: ChangelistState,
    target: ChangelistTarget,
): void {
    if (state.revision !== target.revision)
        throw new Error("Changelists changed. Refresh before retrying.");
    if (target.kind === "existing") {
        if (!state.lists.some((list) => list.id === target.id))
            throw new Error("The destination changelist no longer exists.");
        return;
    }
    const name = normalizedTargetName(target.name);
    if (!name || name !== target.name || targetNameError(state, name))
        throw new Error("The destination changelist is no longer available.");
}

/** Mirrors current store naming rules for prompt feedback; guarded creation validates them again. */
function targetNameError(state: ChangelistState, value: string): string | undefined {
    const name = normalizedTargetName(value);
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name))
        return vscode.l10n.t("Use 1 to 80 printable characters.");
    if (state.lists.some((list) => list.name.normalize("NFC").toLowerCase() === name.toLowerCase()))
        return vscode.l10n.t("A changelist with this name already exists.");
    if (state.lists.length >= 100) return vscode.l10n.t("Too many changelists.");
    return undefined;
}

/** Picker intents use the same NFC and surrounding-whitespace normalization as storage. */
function normalizedTargetName(value: string): string {
    return value.normalize("NFC").trim();
}
