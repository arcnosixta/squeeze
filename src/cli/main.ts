#!/usr/bin/env node
import { runBench, runRealBench } from "../../scripts/bench.ts";
import { createProxy } from "../proxy/server.ts";
import { compress, expand } from "../core/compress.ts";
import { Store, defaultStorePath } from "../core/stats.ts";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const VERSION = "0.1.0";

const USAGE = `squeeze ${VERSION} — lossless token compression for coding agents

Usage:
  squeeze bench [safe|aggressive|none]  run the compression benchmark
  squeeze bench real [level]           benchmark real collected tool output
  squeeze bench all [level]            synthetic and real side by side
  squeeze serve                        start the proxy (default port 8899)
  squeeze compress <file>              compress a file from stdin or path
  squeeze expand <file>                resolve refs back to the original text
  squeeze inspect <file>                show what would change, no output write
  squeeze doctor                       check environment and upstream config
  squeeze selftest                     verify the compressor end to end
  squeeze version                      print the version
  squeeze mcp                          run the MCP server on stdio

Environment:
  SQUEEZE_LEVEL        none | safe | aggressive   (default aggressive)
  SQUEEZE_PORT         proxy port                (default 8899)
  SQUEEZE_HOST         bind address              (default 127.0.0.1)
  SQUEEZE_UPSTREAM_URL forward target            (default api.openai.com)
  SQUEEZE_UPSTREAM     openai | anthropic        (default openai)
  SQUEEZE_STORE        ref store file            (default .squeeze/store.jsonl)

Point your agent at the proxy:
  export ANTHROPIC_BASE_URL=http://127.0.0.1:8899
  export OPENAI_BASE_URL=http://127.0.0.1:8899
`;

function table(rows: { name: string; originalChars: number; compressedChars: number; reductionPct: number }[]) {
  let o = 0, c = 0;
  for (const r of rows) { o += r.originalChars; c += r.compressedChars; }
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(22)} ${String(r.originalChars).padStart(7)} -> ${String(r.compressedChars).padStart(7)}  ${r.reductionPct.toFixed(1).padStart(5)}%`,
    );
  }
  const pct = o === 0 ? 0 : (100 * (o - c)) / o;
  console.log(`\ntotal ${o} -> ${c} chars (${pct.toFixed(1)}% reduction)`);
}

function cmdBench(args: string[]) {
  const mode = args[0] === "real" || args[0] === "all" ? args[0] : "synthetic";
  const level = resolveLevel(mode === "synthetic" ? args : args.slice(1));

  if (mode === "synthetic") {
    table(runBench(level));
    return;
  }
  if (mode === "real") {
    const rows = runRealBench(level);
    if (rows.length === 0) {
      console.log("no real fixtures found; run ./scripts/collect-real.sh");
      return;
    }
    console.log("real tool output (scripts/collect-real.sh):\n");
    table(rows);
    return;
  }
  console.log("synthetic fixtures:\n");
  table(runBench(level));
  console.log("\nreal tool output:\n");
  const real = runRealBench(level);
  if (real.length === 0) console.log("none collected; run ./scripts/collect-real.sh");
  else table(real);
}

async function cmdServe() {
  const { server, cfg } = createProxy();
  server.listen(cfg.port, cfg.host, () => {
    process.stderr.write(`squeeze proxy on http://${cfg.host}:${cfg.port}\n`);
  });
}

function readInput(path: string): string {
  if (path === "-" || path === "/dev/stdin") {
    return readFileSync(0, "utf8");
  }
  return readFileSync(path, "utf8");
}

const LEVEL_NAMES = new Set(["none", "safe", "aggressive"]);
type Level = "none" | "safe" | "aggressive";
const isLevel = (v: string | undefined): v is Level =>
  v !== undefined && LEVEL_NAMES.has(v);

function resolveLevel(args: string[]): Level {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--level=")) {
      const v = a.slice("--level=".length);
      if (isLevel(v)) return v;
    } else if (a === "--level") {
      const v = args[i + 1];
      if (isLevel(v)) return v;
    } else if (a.startsWith("--") && a !== "--") {
      const name = a.slice(2);
      if (isLevel(name)) return name;
    } else if (isLevel(a)) {
      return a;
    }
  }
  const env = process.env.SQUEEZE_LEVEL;
  return isLevel(env) ? env : "aggressive";
}

function cmdCompress(args: string[]) {
  const path = args.find((a) => !a.startsWith("--")) ?? "-";
  const level = resolveLevel(args);
  const text = readInput(path);
  // Refs must outlive the command, or `squeeze expand` could never resolve
  // them. Same persisted store the proxy and selftest use.
  const store = new Store({ path: defaultStorePath() });
  const r = compress(text, { level, store });
  process.stdout.write(r.text);
  if (r.text.length < text.length) process.stderr.write(
    `\n[squeeze] ${text.length} -> ${r.text.length} chars (-${(100 * (text.length - r.text.length) / text.length).toFixed(1)}%), ${store.size} refs\n`,
  );
}

function cmdExpand(args: string[]) {
  const path = args.find((a) => !a.startsWith("--")) ?? "-";
  const text = readInput(path);
  const store = new Store({ path: defaultStorePath() });
  const out = expand(text, store);
  process.stdout.write(out);
  if (out !== text) process.stderr.write(`\n[squeeze] ${store.keys().length} refs in store\n`);
}

function cmdInspect(args: string[]) {
  const path = args.find((a) => !a.startsWith("--")) ?? "-";
  const level = resolveLevel(args);
  const text = readInput(path);
  const store = new Store();
  const r = compress(text, { level, store });
  const pct = text.length === 0 ? 0 : (100 * (text.length - r.text.length)) / text.length;
  console.log(`file      ${path}`);
  console.log(`level     ${level}`);
  console.log(`original  ${text.length} chars`);
  console.log(`compressed${String(r.text.length).padStart(6)} chars`);
  console.log(`reduction ${pct.toFixed(1)}%`);
  console.log(`refs      ${store.size}`);
  console.log(`\n--- output preview ---`);
  console.log(r.text.slice(0, 800));
  if (r.text.length > 800) console.log(`\n... (${r.text.length - 800} more chars)`);
}

function canWriteStore(): boolean {
  try {
    const p = defaultStorePath();
    const dir = dirname(p);
    mkdirSync(dir, { recursive: true });
    // Probe inside the containing directory, not inside the store file itself.
    const probe = join(dir, `.probe-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function cmdDoctor() {
  const node = process.versions.node;
  // Type stripping became the default in Node 22.18, which is why engines
  // requires it: earlier 22.x needs an experimental flag to run .ts directly.
  const [maj, min] = node.split(".").map(Number);
  const checks: [string, boolean, string][] = [
    ["node >= 22.18 (native TS)", maj > 22 || (maj === 22 && min >= 18), `v${node}`],
    ["ref store writable", canWriteStore(), process.env.SQUEEZE_STORE ?? ".squeeze/store.jsonl (default)"],
    ["upstream configured", !!process.env.SQUEEZE_UPSTREAM_URL, process.env.SQUEEZE_UPSTREAM_URL ?? "(default api.openai.com)"],
    ["level set", ["none","safe","aggressive"].includes(process.env.SQUEEZE_LEVEL ?? "aggressive"), process.env.SQUEEZE_LEVEL ?? "aggressive (default)"],
    ["api key present", !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY), (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) ? "set" : "unset (ok for bench)"],
  ];
  console.log("");
  let bad = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? "ok  " : "warn"}  ${name.padEnd(26)} ${detail}`);
    if (!ok) bad++;
  }
  console.log(`\n${bad === 0 ? "all checks passed" : `${bad} check(s) need attention`}\n`);
}

function cmdSelfTest() {
  const fixture = Array.from({ length: 200 }, (_, i) => `src/mod${i}.ts(${i},1): error TS2322: type mismatch`).join("\n");

  // Use the real persisted store: this is the store a running proxy would use,
  // so the selftest exercises durability rather than a private scratch map.
  const store = new Store({ path: defaultStorePath() });
  const r = compress(fixture, { level: "aggressive", store });

  const problems: string[] = [];

  const shrank = r.text.length < fixture.length / 10;
  if (!shrank) problems.push(`compression too weak: ${r.text.length} chars`);

  // The claim that matters is the one the model would act on: every ref printed
  // into the output resolves back to a byte-exact slice of the original. The
  // shared persisted store also holds refs from earlier runs, which are
  // unrelated to this fixture, so verify only the refs actually referenced.
  const emitted = [...r.text.matchAll(/ref=([0-9a-f]+)/g)].map((m) => m[1]);
  let verified = 0;
  for (const ref of emitted) {
    const held = store.get(ref);
    if (held === undefined) {
      problems.push(`ref ${ref} is referenced but not resolvable`);
      continue;
    }
    if (!fixture.includes(held)) {
      problems.push(`ref ${ref} does not hold a slice of the original input`);
      continue;
    }
    verified++;
  }
  if (verified === 0 && emitted.length > 0) problems.push("no refs were produced");

  // Read the file back through a fresh store: proves a restart keeps refs.
  store.close();
  const reloaded = new Store({ path: defaultStorePath() });
  for (const ref of store.keys()) {
    if (reloaded.get(ref) === undefined) {
      problems.push(`ref ${ref} did not survive a reload`);
      break;
    }
  }

  for (const p of problems) console.error(`  fail  ${p}`);
  const ok = problems.length === 0;
  console.log(
    `self-test: ${fixture.length} -> ${r.text.length} chars, ${store.size} refs, ` +
      `${verified} verified byte-exact, ${ok ? "PASS" : "FAIL"}`,
  );
  process.exit(ok ? 0 : 1);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "bench": cmdBench(rest); break;
  case "serve": await cmdServe(); break;
  case "compress": cmdCompress(rest); break;
  case "expand": cmdExpand(rest); break;
  case "inspect": cmdInspect(rest); break;
  case "doctor": cmdDoctor(); break;
  case "selftest": cmdSelfTest(); break;
  case "mcp": await import("../mcp/server.ts"); break;
  case "version": case "--version": console.log(VERSION); break;
  default: process.stdout.write(USAGE);
}
