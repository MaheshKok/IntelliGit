import type {
    InteractiveRebaseRangeCommit,
    RebaseTodoEntry,
} from "../../../../protocol/commitGraphTypes";

/** Inputs and host callbacks for the presentational interactive-rebase dialog. */
export interface RebaseDialogProps {
    /** Commits offered by the host in the exact oldest-first todo order. */
    commits: readonly InteractiveRebaseRangeCommit[];
    /** Optional control that invoked the dialog and regains focus on dismissal. */
    returnFocusTarget?: HTMLElement | null;
    /** Receives the immutable ordered todo entries selected by the user. */
    onSubmit: (entries: readonly RebaseTodoEntry[]) => void;
    /** Dismisses the dialog; the host owns request lifecycle and messaging. */
    onCancel: () => void;
}

/** Result of an immutable entry mutation and first-active-action normalization. */
export interface RebaseEntryMutation {
    /** Updated entries in oldest-first todo order. */
    entries: readonly RebaseTodoEntry[];
    /** Indicates a first non-dropped squash or fixup action was changed to pick. */
    firstActionCleared: boolean;
}
