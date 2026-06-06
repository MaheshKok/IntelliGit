import { GRAPH_LANE_COLORS, JETBRAINS_UI } from "./shared/tokens";

const COLORS = GRAPH_LANE_COLORS;

/** Horizontal spacing between adjacent commit-graph lanes. */
export const LANE_WIDTH = JETBRAINS_UI.graph.laneWidth;

/** Radius used by canvas renderers for each commit dot. */
export const DOT_RADIUS = JETBRAINS_UI.graph.dotRadius;

/** Shared vertical row height that keeps commit rows and graph lanes aligned. */
export const ROW_HEIGHT = JETBRAINS_UI.size.rowHeight;

/**
 * Layout instructions for one visible commit row, including active lanes and
 * parent connections that the canvas renderer turns into graph strokes.
 */
export interface GraphRow {
    column: number;
    color: string;
    numColumns: number;
    passThroughLanes: Array<{ column: number; color: string }>;
    connectionsDown: Array<{ fromCol: number; toCol: number; color: string }>;
}

/**
 * Computes lane assignments for commits in display order, reusing parent lanes
 * where possible and allocating side lanes for merge parents.
 */
export function computeGraph(commits: Array<{ hash: string; parentHashes: string[] }>): GraphRow[] {
    const lanes: (string | null)[] = [];
    const rows: GraphRow[] = [];

    function findFree(): number {
        const i = lanes.indexOf(null);
        if (i >= 0) return i;
        lanes.push(null);
        return lanes.length - 1;
    }

    for (const commit of commits) {
        let col = lanes.indexOf(commit.hash);
        if (col === -1) col = findFree();

        const passThroughLanes: Array<{ column: number; color: string }> = [];
        for (let i = 0; i < lanes.length; i++) {
            if (i !== col && lanes[i] !== null) {
                passThroughLanes.push({ column: i, color: COLORS[i % COLORS.length] });
            }
        }

        lanes[col] = null;

        const connectionsDown: Array<{ fromCol: number; toCol: number; color: string }> = [];

        for (let p = 0; p < commit.parentHashes.length; p++) {
            const ph = commit.parentHashes[p];
            const pCol = lanes.indexOf(ph);

            if (pCol >= 0) {
                connectionsDown.push({
                    fromCol: col,
                    toCol: pCol,
                    color: COLORS[pCol % COLORS.length],
                });
            } else if (p === 0) {
                lanes[col] = ph;
                connectionsDown.push({
                    fromCol: col,
                    toCol: col,
                    color: COLORS[col % COLORS.length],
                });
            } else {
                const nc = findFree();
                lanes[nc] = ph;
                connectionsDown.push({
                    fromCol: col,
                    toCol: nc,
                    color: COLORS[nc % COLORS.length],
                });
            }
        }

        while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

        rows.push({
            column: col,
            color: COLORS[col % COLORS.length],
            numColumns: Math.max(lanes.length, col + 1),
            passThroughLanes,
            connectionsDown,
        });
    }

    return rows;
}
