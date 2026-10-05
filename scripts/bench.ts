import { Store, type Level, type Stats, ZERO, savedChars } from "../src/core/stats.ts";
import { compress, stripAnsi } from "../src/core/compress.ts";

interface Fixture {
  name: string;
  kind: string;
  text: string;
}

const A = "[32m";
const R = "[0m";
const D = "[2m";

function npmInstall(): string {
  const rows: string[] = [];
  for (let i = 1; i <= 340; i++) {
    rows.push(
      `npm warn deprecated ${["left-pad","request","underscore","glob","rimraf"][i % 5]}@1.${i % 9}.${i % 7}: use ${["left-pad","request","underscore","glob","rimraf"][i % 5]}@2.x`,
    );
  }
  return [
    ...rows,
    ...Array.from({ length: 12 }, (_, i) =>
      `2026-10-04T11:${String(i).padStart(2, "0")}:22.${i}1Z INFO  module-loader resolved chunk ${i}`,
    ),
    "added 2841 packages, and audited 2842 packages in 41s",
    "",
    "",
    "",
    "found 0 vulnerabilities",
  ].join("\n");
}

function tscOutput(): string {
  const errs: string[] = [];
  for (let i = 1; i <= 120; i++) {
    errs.push(
      `src/module${i}/index.ts(${i},${i * 3}): error TS2322: Type 'string' is not assignable to type 'number'.`,
    );
  }
  return errs.join("\n");
}

function jsonDump(): string {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < 60; i++) {
    obj[`field_${i}`] = {
      id: i,
      name: `record-name-${i}`,
      tags: ["alpha", "beta", "gamma"],
      nested: { x: i * 2, y: i * 3, note: "lorem ipsum dolor sit amet " + i },
    };
  }
  return JSON.stringify(obj, null, 2);
}

function testRun(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 400; i++) lines.push(`  ✓ suite${i} > case ${i} passed (${i}ms)`);
  return lines.join("\n");
}

function repetitiveLogs(): string {
  const out: string[] = [];
  for (let i = 0; i < 90; i++) {
    out.push(`2026-10-04T09:${String(i % 60).padStart(2, "0")}:11Z INFO  worker-${i % 5} heartbeat seq=${i}`);
  }
  return out.join("\n");
}

function sourceFile(): string {
  return `import { readFile } from "node:fs/promises";

export async function loadConfig(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}


`.repeat(1) + Array.from({ length: 40 }, (_, i) => `
export const helper${i} = (input: string): string => {
  return input.trim().toLowerCase().replace(/\\s+/g, "-");
};
`).join("");
}

function blankHeavy(): string {
  // Real files carry long blank runs between sections and inside wrapped
  // output; single alternating blanks are common too.
  const out: string[] = [];
  for (let i = 0; i < 60; i++) {
    out.push(`field ${i}: value ${i}`);
    out.push("");
    out.push("");
    out.push("");
  }
  return out.join("\n");
}

function dupBlocks(): string {
  const block = Array.from({ length: 10 }, (_, i) => `cache entry ${i} loaded`).join("\n");
  return Array.from({ length: 14 }, () => block).join("\n");
}

export const FIXTURES: Fixture[] = [
  { name: "npm-install-verbose", kind: "log-noise", text: npmInstall() },
  { name: "tsc-errors", kind: "compiler", text: tscOutput() },
  { name: "json-dump", kind: "structured", text: jsonDump() },
  { name: "test-run", kind: "repetitive", text: testRun() },
  { name: "heartbeat-logs", kind: "log-noise", text: repetitiveLogs() },
  { name: "source-file", kind: "source", text: sourceFile() },
  { name: "blank-heavy", kind: "whitespace", text: blankHeavy() },
  { name: "dup-blocks", kind: "duplicated", text: dupBlocks() },
];

export interface BenchRow {
  name: string;
  kind: string;
  originalChars: number;
  compressedChars: number;
  savedChars: number;
  reductionPct: number;
  handles: number;
}

function approxTokens(chars: number): number {
  return Math.round(chars / 3.6);
}

export function runBench(
  level: Level,
  fixtures: Fixture[] = FIXTURES,
): BenchRow[] {
  const rows: BenchRow[] = [];
  for (const f of fixtures) {
    const store = new Store();
    const r = compress(f.text, { level, store });
    rows.push({
      name: f.name,
      kind: f.kind,
      originalChars: r.stats.originalChars,
      compressedChars: r.stats.compressedChars,
      savedChars: savedChars(r.stats),
      reductionPct:
        r.stats.originalChars === 0
          ? 0
          : (100 * savedChars(r.stats)) / r.stats.originalChars,
      handles: store.size,
    });
  }
  return rows;
}

export function printBench(level: Level): void {
  const rows = runBench(level);
  let o = 0;
  let c = 0;
  let h = 0;
  for (const r of rows) {
    o += r.originalChars;
    c += r.compressedChars;
    h += r.handles;
  }
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const rpad = (s: string | number, n: number) => String(s).padStart(n);

  console.log(`\n  squeeze benchmark — level=${level}\n`);
  console.log(
    `  ${pad("fixture", 22)}${pad("kind", 13)}${rpad("orig", 9)}${rpad("after", 9)}${rpad("saved", 9)}${rpad("reduct", 9)}${rpad("refs", 6)}`,
  );
  console.log(`  ${"-".repeat(76)}`);
  for (const r of rows) {
    console.log(
      `  ${pad(r.name, 22)}${pad(r.kind, 13)}${rpad(r.originalChars, 9)}${rpad(r.compressedChars, 9)}${rpad(r.savedChars, 9)}${rpad(r.reductionPct.toFixed(1) + "%", 9)}${rpad(r.handles, 6)}`,
    );
  }
  const pct = o === 0 ? 0 : (100 * (o - c)) / o;
  console.log(`  ${"-".repeat(76)}`);
  console.log(
    `  ${pad("TOTAL", 22)}${pad("", 13)}${rpad(o, 9)}${rpad(c, 9)}${rpad(o - c, 9)}${rpad(pct.toFixed(1) + "%", 9)}${rpad(h, 6)}`,
  );
  console.log(
    `\n  approx tokens: ${approxTokens(o)} -> ${approxTokens(c)} (saves ~${approxTokens(o - c)} tokens/request)\n`,
  );
}

export { stripAnsi };

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  const level =
    arg === "none" || arg === "safe" || arg === "aggressive"
      ? arg
      : "safe";
  printBench(level);
}
