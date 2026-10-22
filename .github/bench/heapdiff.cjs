"use strict";
// Bench-only: diffs the first and last gzipped host heap snapshots in a directory by constructor.
// Usage: node heapdiff.cjs <dir>. Streams each snapshot (a 2 GB heap is too big for one string),
// builds its dominator tree (Cooper-Harvey-Kennedy) and reports per-constructor growth plus the
// dominator chain of the largest new object of the top three constructors.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const UNSET = 0xffffffff;

async function parseSnapshot(file) {
    const input = fs.createReadStream(file).pipe(zlib.createGunzip());
    let header = "";
    let meta;
    let mode = "header";
    let target;
    let filled = 0;
    let value = 0;
    let inNumber = false;
    let depth = 0;
    let key = "";
    let parts;
    let escaped = false;
    const strings = [];
    const out = {};
    const endNumbers = () => {
        if (filled !== target.length)
            throw new Error(`${file}: filled ${filled} of ${target.length} values`);
        mode = "seek";
        key = "";
    };
    for await (const chunk of input) {
        let i = 0;
        if (mode === "header") {
            // The header before "nodes" is ASCII, so latin1 offsets equal byte offsets.
            header += chunk.toString("latin1");
            const at = header.indexOf('"nodes":[');
            if (at < 0) continue;
            meta = JSON.parse(`${header.slice(0, header.lastIndexOf(",", at))}}`).snapshot;
            out.nodes = new Uint32Array(meta.node_count * meta.meta.node_fields.length);
            out.edges = new Uint32Array(meta.edge_count * meta.meta.edge_fields.length);
            i = chunk.length - (header.length - (at + '"nodes":['.length));
            header = "";
            mode = "numbers";
            target = out.nodes;
            filled = 0;
        }
        let start = i;
        for (; i < chunk.length; i++) {
            const c = chunk[i];
            if (mode === "numbers") {
                if (c >= 48 && c <= 57) {
                    value = value * 10 + (c - 48);
                    inNumber = true;
                } else {
                    if (inNumber) {
                        if (value > UNSET || filled >= target.length)
                            throw new Error(`${file}: value ${value} at ${filled} does not fit`);
                        target[filled++] = value;
                        value = 0;
                        inNumber = false;
                    }
                    if (c === 93) endNumbers();
                }
            } else if (mode === "seek") {
                if (c === 91) {
                    if (key.includes('"edges"')) {
                        mode = "numbers";
                        target = out.edges;
                        filled = 0;
                    } else if (key.includes('"strings"')) {
                        mode = "strings";
                    } else {
                        mode = "skip";
                        depth = 1;
                    }
                    key = "";
                } else key += String.fromCharCode(c);
            } else if (mode === "skip") {
                if (c === 91) depth++;
                else if (c === 93 && --depth === 0) mode = "seek";
            } else if (mode === "strings") {
                if (parts) {
                    if (escaped) escaped = false;
                    else if (c === 92) escaped = true;
                    else if (c === 34) {
                        parts.push(Buffer.from(chunk.subarray(start, i + 1)));
                        strings.push(JSON.parse(Buffer.concat(parts).toString("utf8")));
                        parts = undefined;
                    }
                } else if (c === 34) {
                    parts = [];
                    start = i;
                } else if (c === 93) mode = "done";
            }
        }
        if (parts) parts.push(Buffer.from(chunk.subarray(start)));
    }
    if (mode !== "done" && mode !== "seek") throw new Error(`${file}: ended in ${mode}`);
    if (strings.length === 0) throw new Error(`${file}: no strings section`);
    return { meta, nodes: out.nodes, edges: out.edges, strings };
}

function analyse({ meta, nodes, edges, strings }, previousIds) {
    const m = meta.meta;
    const NF = m.node_fields.length;
    const EF = m.edge_fields.length;
    const [nType, nName, nId, nSize, nEdges] = [
        "type",
        "name",
        "id",
        "self_size",
        "edge_count",
    ].map((field) => m.node_fields.indexOf(field));
    const [eType, eName, eTo] = ["type", "name_or_index", "to_node"].map((field) =>
        m.edge_fields.indexOf(field),
    );
    const nodeTypes = m.node_types[nType];
    const edgeTypes = m.edge_types[eType];
    const weak = edgeTypes.indexOf("weak");
    const N = meta.node_count;

    const classIds = new Map();
    const classNames = [];
    const classOf = new Uint32Array(N);
    for (let n = 0; n < N; n++) {
        const type = nodeTypes[nodes[n * NF + nType]];
        const name =
            type === "object" || type === "native" ? strings[nodes[n * NF + nName]] : `(${type})`;
        let id = classIds.get(name);
        if (id === undefined) {
            id = classNames.length;
            classIds.set(name, id);
            classNames.push(name);
        }
        classOf[n] = id;
    }
    const firstEdge = new Uint32Array(N + 1);
    for (let n = 0; n < N; n++) firstEdge[n + 1] = firstEdge[n] + nodes[n * NF + nEdges] * EF;

    // Post-order DFS from the synthetic root over non-weak edges.
    const post = new Uint32Array(N).fill(UNSET);
    const order = new Uint32Array(N);
    const stackNode = new Uint32Array(N);
    const stackEdge = new Uint32Array(N);
    const seen = new Uint8Array(N);
    let sp = 0;
    let count = 0;
    stackNode[0] = 0;
    stackEdge[0] = firstEdge[0];
    seen[0] = 1;
    while (sp >= 0) {
        const n = stackNode[sp];
        const e = stackEdge[sp];
        if (e < firstEdge[n + 1]) {
            stackEdge[sp] = e + EF;
            if (edges[e + eType] === weak) continue;
            const to = edges[e + eTo] / NF;
            if (!seen[to]) {
                seen[to] = 1;
                sp++;
                stackNode[sp] = to;
                stackEdge[sp] = firstEdge[to];
            }
        } else {
            post[n] = count;
            order[count++] = n;
            sp--;
        }
    }

    // Predecessors by post-order number, from reachable nodes over non-weak edges.
    const predStart = new Uint32Array(count + 1);
    for (let k = 0; k < count; k++) {
        const n = order[k];
        for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += EF)
            if (edges[e + eType] !== weak) predStart[post[edges[e + eTo] / NF] + 1]++;
    }
    for (let k = 0; k < count; k++) predStart[k + 1] += predStart[k];
    const preds = new Uint32Array(predStart[count]);
    const cursor = predStart.slice(0, count);
    for (let k = 0; k < count; k++) {
        const n = order[k];
        for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += EF)
            if (edges[e + eType] !== weak) preds[cursor[post[edges[e + eTo] / NF]]++] = k;
    }

    // Immediate dominators by post-order number; the root has the highest number.
    const idom = new Uint32Array(count).fill(UNSET);
    const root = count - 1;
    idom[root] = root;
    const intersect = (a, b) => {
        while (a !== b) {
            while (a < b) a = idom[a];
            while (b < a) b = idom[b];
        }
        return a;
    };
    let passes = 0;
    for (let changed = true; changed;) {
        changed = false;
        passes++;
        for (let k = root - 1; k >= 0; k--) {
            let next = UNSET;
            for (let p = predStart[k]; p < predStart[k + 1]; p++) {
                const q = preds[p];
                if (idom[q] === UNSET) continue;
                next = next === UNSET ? q : intersect(q, next);
            }
            if (idom[k] !== next) {
                idom[k] = next;
                changed = true;
            }
        }
    }

    // A dominator always has a higher post-order number, so ascending order sums children first.
    const retained = new Float64Array(count);
    for (let k = 0; k < count; k++) retained[k] = nodes[order[k] * NF + nSize];
    for (let k = 0; k < root; k++) retained[idom[k]] += retained[k];

    // Class retained size counts an object only when its dominator is of another class.
    const byClass = new Map();
    const row = (name) => {
        let r = byClass.get(name);
        if (!r) {
            r = {
                count: 0,
                self: 0,
                retained: 0,
                newCount: 0,
                newSelf: 0,
                biggest: -1,
                biggestNew: -1,
            };
            byClass.set(name, r);
        }
        return r;
    };
    for (let k = 0; k < root; k++) {
        const n = order[k];
        const c = classOf[n];
        const r = row(classNames[c]);
        r.count++;
        r.self += nodes[n * NF + nSize];
        if (classOf[order[idom[k]]] !== c) r.retained += retained[k];
        if (r.biggest < 0 || retained[k] > retained[r.biggest]) r.biggest = k;
        if (previousIds && !hasId(previousIds, nodes[n * NF + nId])) {
            r.newCount++;
            r.newSelf += nodes[n * NF + nSize];
            if (r.biggestNew < 0 || retained[k] > retained[r.biggestNew]) r.biggestNew = k;
        }
    }
    const ids = new Uint32Array(count);
    for (let k = 0; k < count; k++) ids[k] = nodes[order[k] * NF + nId];
    ids.sort();

    const label = (n) => `${classNames[classOf[n]]}@${nodes[n * NF + nId]}`;
    const edgeName = (from, to) => {
        for (let e = firstEdge[from]; e < firstEdge[from + 1]; e += EF) {
            if (edges[e + eTo] / NF !== to) continue;
            const type = edgeTypes[edges[e + eType]];
            const name = edges[e + eName];
            return type === "element" || type === "hidden"
                ? `[${name}]`
                : `.${String(strings[name]).slice(0, 60)}`;
        }
        return " (via)";
    };
    const chain = (k) => {
        const steps = [];
        for (let at = k; at !== root && steps.length < 30; at = idom[at]) {
            const n = order[at];
            const parent = order[idom[at]];
            steps.push(
                `${label(n)} retained=${mb(retained[at])}MB <-${edgeName(parent, n)}- ${label(parent)}`,
            );
        }
        return steps;
    };
    return { N, reachable: count, passes, totalRetained: retained[root], byClass, ids, chain };
}

function hasId(sorted, id) {
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid] === id) return true;
        if (sorted[mid] < id) lo = mid + 1;
        else hi = mid - 1;
    }
    return false;
}

const mb = (bytes) => (bytes / 1048576).toFixed(1);

async function main() {
    const dir = process.argv[2];
    if (!dir) throw new Error("usage: heapdiff.cjs <dir>");
    const files = fs
        .readdirSync(dir)
        .filter((name) => /^host-heap-\d+s\.heapsnapshot\.gz$/.test(name))
        .sort((a, b) => parseInt(a.slice(10), 10) - parseInt(b.slice(10), 10));
    if (files.length < 2) throw new Error(`need two snapshots in ${dir}, found ${files.length}`);
    const [first, last] = [files[0], files[files.length - 1]];
    const time = (label, work) => {
        const started = Date.now();
        return Promise.resolve(work()).then((result) => {
            console.log(`${label} took ${((Date.now() - started) / 1000).toFixed(0)} s`);
            return result;
        });
    };
    const a = await time(`A ${first}`, async () =>
        analyse(await parseSnapshot(path.join(dir, first))),
    );
    const b = await time(`B ${last}`, async () =>
        analyse(await parseSnapshot(path.join(dir, last)), a.ids),
    );
    for (const [name, s] of [
        [first, a],
        [last, b],
    ])
        console.log(
            `${name}: nodes=${s.N} reachable=${s.reachable} dominatorPasses=${s.passes} retained=${mb(s.totalRetained)}MB`,
        );
    const rows = [...b.byClass].map(([name, r]) => {
        const before = a.byClass.get(name) ?? { count: 0, self: 0, retained: 0 };
        return { name, r, grow: r.retained - before.retained, before };
    });
    rows.sort((x, y) => y.grow - x.grow);
    console.log("\nTop 10 constructors by retained-size growth (A -> B)");
    console.log(
        "constructor | retained MB A -> B (+grow) | count A -> B | self MB A -> B | new in B: count, self MB",
    );
    for (const { name, r, grow, before } of rows.slice(0, 10))
        console.log(
            `${name} | ${mb(before.retained)} -> ${mb(r.retained)} (+${mb(grow)}) | ${before.count} -> ${r.count} | ${mb(before.self)} -> ${mb(r.self)} | ${r.newCount}, ${mb(r.newSelf)}`,
        );
    for (const { name, r } of rows.slice(0, 3)) {
        const fresh = r.biggestNew >= 0;
        console.log(
            `\nDominator chain of the largest ${fresh ? "new " : ""}${name} in B (object first, root last):`,
        );
        for (const step of b.chain(fresh ? r.biggestNew : r.biggest)) console.log(`  ${step}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
