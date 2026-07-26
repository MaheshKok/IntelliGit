import type { PerEntryResult, ShelfMutationStatus } from "../../../protocol/commitPanelMessages";
import { t } from "../../shared/i18n";

export function statusMessage(status: ShelfMutationStatus): string {
    return {
        ok: t("shelf.status.completed"),
        partial: t("shelf.status.partial"),
        conflicts: t("shelf.status.conflicts"),
        staleShelf: t("shelf.status.staleShelf"),
        staleCatalog: t("shelf.status.staleCatalog"),
        busy: t("shelf.status.busy"),
        recoveryFull: t("shelf.status.recoveryFull"),
        error: t("shelf.status.failed"),
    }[status];
}

export function resultMessage(result: PerEntryResult): string {
    switch (result.kind) {
        case "applied":
            return t("shelf.result.applied");
        case "conflicted":
            return t("shelf.result.conflicted");
        case "retained":
            return t("shelf.result.retained", { reason: result.reason });
        case "flattenedResidue":
            return t("shelf.result.flattenedResidue");
        case "refused":
            return t("shelf.result.refused", { reason: result.reason });
        case "structuralPending":
            return t("shelf.result.structuralPending", { reason: result.reason });
    }
}
