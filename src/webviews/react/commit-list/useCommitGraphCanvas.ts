import { useEffect } from "react";
import { DOT_RADIUS, LANE_WIDTH, ROW_HEIGHT, type GraphRow } from "../graph";

interface Args {
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    rows: GraphRow[];
    graphWidth: number;
    rowCount: number;
}

export function useCommitGraphCanvas({ canvasRef, rows, graphWidth, rowCount }: Args): void {
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || rowCount === 0) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const bgColor =
            getComputedStyle(document.documentElement)
                .getPropertyValue("--vscode-editor-background")
                .trim() || "#1e1e1e";

        const dpr = window.devicePixelRatio || 1;
        const totalHeight = rowCount * ROW_HEIGHT;
        canvas.width = graphWidth * dpr;
        canvas.height = totalHeight * dpr;
        canvas.style.width = `${graphWidth}px`;
        canvas.style.height = `${totalHeight}px`;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, graphWidth, totalHeight);
        ctx.lineCap = "round";

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const y = i * ROW_HEIGHT;
            const cy = y + ROW_HEIGHT / 2;
            const cx = row.column * LANE_WIDTH + LANE_WIDTH / 2 + 4;

            for (const lane of row.passThroughLanes) {
                const lx = lane.column * LANE_WIDTH + LANE_WIDTH / 2 + 4;
                ctx.beginPath();
                ctx.strokeStyle = lane.color;
                ctx.lineWidth = 2;
                ctx.moveTo(lx, y);
                ctx.lineTo(lx, y + ROW_HEIGHT);
                ctx.stroke();
            }

            if (i > 0) {
                const prev = rows[i - 1];
                const incoming =
                    prev.connectionsDown.some((c) => c.toCol === row.column) ||
                    prev.passThroughLanes.some((l) => l.column === row.column);
                if (incoming) {
                    ctx.beginPath();
                    ctx.strokeStyle = row.color;
                    ctx.lineWidth = 2;
                    ctx.moveTo(cx, y);
                    ctx.lineTo(cx, cy);
                    ctx.stroke();
                }
            }

            for (const conn of row.connectionsDown) {
                const fx = conn.fromCol * LANE_WIDTH + LANE_WIDTH / 2 + 4;
                const tx = conn.toCol * LANE_WIDTH + LANE_WIDTH / 2 + 4;
                ctx.beginPath();
                ctx.strokeStyle = conn.color;
                ctx.lineWidth = 2;
                if (conn.fromCol === conn.toCol) {
                    ctx.moveTo(fx, cy);
                    ctx.lineTo(tx, y + ROW_HEIGHT);
                } else {
                    ctx.moveTo(fx, cy);
                    ctx.bezierCurveTo(
                        fx,
                        cy + ROW_HEIGHT * 0.4,
                        tx,
                        y + ROW_HEIGHT - ROW_HEIGHT * 0.3,
                        tx,
                        y + ROW_HEIGHT,
                    );
                }
                ctx.stroke();
            }

            ctx.beginPath();
            ctx.fillStyle = bgColor;
            ctx.arc(cx, cy, DOT_RADIUS + 1, 0, Math.PI * 2);
            ctx.fill();

            ctx.beginPath();
            ctx.strokeStyle = row.color;
            ctx.lineWidth = 2.5;
            ctx.arc(cx, cy, DOT_RADIUS, 0, Math.PI * 2);
            ctx.stroke();

            ctx.beginPath();
            ctx.fillStyle = row.color;
            ctx.arc(cx, cy, 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }, [canvasRef, graphWidth, rowCount, rows]);
}
