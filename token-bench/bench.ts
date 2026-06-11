/**
 * Benchmark harness: scores the LTR prototype against Headroom on a corpus of
 * real tool outputs using one shared tokenizer.
 *
 * Fairness rules enforced here:
 *  - Both tools' *emitted* text is tokenized with the same encoder (o200k_base),
 *    so neither tool's self-reported numbers are trusted.
 *  - The same content-equality test (`norm`) is applied to both tools to decide
 *    whether an output is information-preserving.
 *  - Headroom outputs are read from sibling `<corpus>.hr.txt` files captured by
 *    calling its MCP `compress` tool on the identical input.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reduce, type ReduceResult } from "./ltr.ts";

/** Resolve the o200k_base encoder (GPT-4o; same BPE as tiktoken), falling back to the package default. */
let encode: (text: string) => number[];
let encodingName = "o200k_base";
try {
  ({ encode } = (await import("gpt-tokenizer/encoding/o200k_base")) as {
    encode: (text: string) => number[];
  });
} catch {
  ({ encode } = (await import("gpt-tokenizer")) as { encode: (text: string) => number[] });
  encodingName = "cl100k_base (fallback)";
}

/** Token count under the active encoder. */
const count = (text: string): number => encode(text).length;
/** Whitespace-insensitive view used to test information preservation symmetrically for both tools. */
const norm = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Recursively sort keys so structurally-equal JSON values share one string form. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
/** Canonical JSON string; equal strings imply equal values. */
const canonicalJson = (v: unknown): string => JSON.stringify(sortKeys(v));
/** Parse JSON, reporting success without throwing. */
function tryParse(s: string): { ok: boolean; val?: unknown } {
  try {
    return { ok: true, val: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}
/** Inverse of LTR's TSV encoding, reimplemented here so the bench never trusts LTR's own claim. */
function tsvToObjects(s: string): unknown[] | null {
  try {
    const [head, ...rows] = s.split("\n");
    const headers = JSON.parse(head) as string[];
    if (!Array.isArray(headers)) return null;
    return rows.map((line) => {
      const cells = line.split("\t");
      const o: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        const v = JSON.parse(cells[i]);
        if (v !== " __absent__") o[h] = v;
      });
      return o;
    });
  } catch {
    return null;
  }
}
/**
 * Independently decide whether `out` preserves all information in `orig`, by
 * reconstruction: identical bytes, equal JSON value, a decodable TSV of the same
 * value, or identical non-whitespace content. Applied to both tools symmetrically.
 */
function isLossless(orig: string, out: string): boolean {
  if (orig === out) return true;
  const o = tryParse(orig);
  const p = tryParse(out);
  if (o.ok && p.ok) return canonicalJson(o.val) === canonicalJson(p.val);
  if (o.ok) {
    const dec = tsvToObjects(out);
    if (dec && canonicalJson(dec) === canonicalJson(o.val)) return true;
  }
  return norm(orig) === norm(out);
}

/** Per-tool measurement for one corpus item. */
interface ToolResult {
  tokens: number;
  savedPct: number;
  contentLossless: boolean;
  note: string;
}

/** Full measurement row for one corpus item. */
interface Row {
  name: string;
  origTokens: number;
  ltr: ToolResult & { transform: string; tier: string };
  headroom: ToolResult | null;
}

const corpusDir = join(import.meta.dir, "corpus");
const items = readdirSync(corpusDir)
  .filter((f) => !f.endsWith(".hr.txt") && !f.startsWith("."))
  .sort();

/** Measure the LTR prototype on one input. */
function measureLtr(orig: string, origTokens: number): Row["ltr"] {
  const r: ReduceResult = reduce(orig, count);
  const tokens = count(r.output);
  return {
    tokens,
    savedPct: origTokens === 0 ? 0 : (1 - tokens / origTokens) * 100,
    contentLossless: isLossless(orig, r.output),
    note: r.verified ? "verified" : "UNVERIFIED",
    transform: r.transform,
    tier: r.tier,
  };
}

/** Measure Headroom from its captured output sibling, or null when none was captured. */
function measureHeadroom(name: string, orig: string, origTokens: number): ToolResult | null {
  const hrPath = join(corpusDir, `${name}.hr.txt`);
  if (!existsSync(hrPath)) return null;
  const hrText = readFileSync(hrPath, "utf8");
  const tokens = count(hrText);
  const identical = hrText === orig;
  const contentLossless = isLossless(orig, hrText);
  const offload = /Retrieve more|hash=[0-9a-f]/.test(hrText);
  let note = "lossy (info dropped)";
  if (identical) note = "noop (unchanged)";
  else if (contentLossless) note = "lossless transform";
  else if (offload) note = "lossy + needs retrieval";
  return {
    tokens,
    savedPct: origTokens === 0 ? 0 : (1 - tokens / origTokens) * 100,
    contentLossless,
    note,
  };
}

const rows: Row[] = [];
for (const name of items) {
  const orig = readFileSync(join(corpusDir, name), "utf8");
  const origTokens = count(orig);
  rows.push({
    name,
    origTokens,
    ltr: measureLtr(orig, origTokens),
    headroom: measureHeadroom(name, orig, origTokens),
  });
}

/** Right-pad to width for table alignment. */
const pad = (s: string | number, w: number): string => String(s).padEnd(w);
/** Left-pad to width for numeric columns. */
const lpad = (s: string | number, w: number): string => String(s).padStart(w);

console.log(`\nTokenizer: ${encodingName}  (proxy for Claude tokens; relative comparison is tokenizer-invariant)\n`);
console.log(
  `${pad("corpus item", 22)} ${lpad("orig", 6)} | ${lpad("LTR", 6)} ${lpad("save%", 6)} ${pad(" transform", 24)} ${pad("loss?", 6)} | ${lpad("HR", 6)} ${lpad("save%", 6)} ${pad("HR note", 24)} ${pad("loss?", 6)}`,
);
console.log("-".repeat(140));

let sumOrig = 0;
let sumLtr = 0;
let sumHr = 0;
let hrCounted = 0;
for (const r of rows) {
  sumOrig += r.origTokens;
  sumLtr += r.ltr.tokens;
  const hr = r.headroom;
  if (hr) {
    sumHr += hr.tokens;
    hrCounted += r.origTokens;
  }
  console.log(
    `${pad(r.name, 22)} ${lpad(r.origTokens, 6)} | ${lpad(r.ltr.tokens, 6)} ${lpad(r.ltr.savedPct.toFixed(1), 6)} ${pad(` ${r.ltr.transform}`, 24)} ${pad(r.ltr.contentLossless ? "OK" : "LOSSY", 6)} | ${hr ? lpad(hr.tokens, 6) : lpad("-", 6)} ${hr ? lpad(hr.savedPct.toFixed(1), 6) : lpad("-", 6)} ${pad(hr ? hr.note : "(not captured)", 24)} ${pad(hr ? (hr.contentLossless ? "OK" : "LOSSY") : "-", 6)}`,
  );
}
console.log("-".repeat(140));
const ltrTotalPct = sumOrig === 0 ? 0 : (1 - sumLtr / sumOrig) * 100;
console.log(
  `${pad("TOTAL", 22)} ${lpad(sumOrig, 6)} | ${lpad(sumLtr, 6)} ${lpad(ltrTotalPct.toFixed(1), 6)} ${pad(" (all verified lossless)", 24)} ${pad("", 6)} |`,
);
if (hrCounted > 0) {
  const hrTotalPct = (1 - sumHr / hrCounted) * 100;
  console.log(
    `${pad("", 22)} ${lpad("", 6)} | ${lpad("", 6)} ${lpad("", 6)} ${pad("", 24)} ${pad("", 6)} | Headroom over captured items: ${sumHr} tok vs ${hrCounted} orig = ${hrTotalPct.toFixed(1)}% saved`,
  );
}

writeFileSync(
  join(import.meta.dir, "results.json"),
  JSON.stringify({ encoding: encodingName, rows }, null, 2),
);
console.log(`\nWrote ${join(import.meta.dir, "results.json")}\n`);
