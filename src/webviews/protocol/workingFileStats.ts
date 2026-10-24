import type { WorkingFile } from "../../types";

/** One host-to-renderer terminal statistics update for a status revision. */
export interface WorkingFileStatsReply {
    type: "workingFileStats";
    repositoryRoot: string;
    revision: string;
    files: Pick<WorkingFile, "path" | "staged" | "additions" | "deletions" | "statsState">[];
}

/** Old or out-of-order counts cannot replace status, icons, inclusion, or a newer refresh. */
export function mergeWorkingFileStats(
    files: readonly WorkingFile[],
    reply: Pick<WorkingFileStatsReply, "revision" | "files">,
): WorkingFile[] {
    const counts = new Map(reply.files.map((file) => [`${file.path}\0${file.staged}`, file]));
    return files.map((file) => {
        if (file.statsRevision !== reply.revision) return file;
        const loaded = counts.get(`${file.path}\0${file.staged}`);
        return loaded
            ? {
                  ...file,
                  additions: loaded.additions,
                  deletions: loaded.deletions,
                  statsState: loaded.statsState,
              }
            : file;
    });
}
