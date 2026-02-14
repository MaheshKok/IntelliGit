export const COLORS = [
    '#4CAF50', '#2196F3', '#FF9800', '#E91E63', '#9C27B0',
    '#00BCD4', '#FF5722', '#8BC34A', '#3F51B5', '#FFC107',
];

export const LANE_WIDTH = 20;
export const DOT_RADIUS = 5;
export const ROW_HEIGHT = 28;

export interface GraphRow {
    column: number;
    color: string;
    numColumns: number;
    passThroughLanes: Array<{ column: number; color: string }>;
    connectionsDown: Array<{ fromCol: number; toCol: number; color: string }>;
}

export function computeGraph(
    commits: Array<{ hash: string; parentHashes: string[] }>,
): GraphRow[] {
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
            let pCol = lanes.indexOf(ph);

            if (pCol >= 0) {
                connectionsDown.push({ fromCol: col, toCol: pCol, color: COLORS[pCol % COLORS.length] });
            } else if (p === 0) {
                lanes[col] = ph;
                connectionsDown.push({ fromCol: col, toCol: col, color: COLORS[col % COLORS.length] });
            } else {
                const nc = findFree();
                lanes[nc] = ph;
                connectionsDown.push({ fromCol: col, toCol: nc, color: COLORS[nc % COLORS.length] });
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
