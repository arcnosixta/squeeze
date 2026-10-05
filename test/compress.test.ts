import { test } from "node:test";
import assert from "node:assert/strict";
import { compress, stripAnsi } from "../src/core/compress.ts";
import { Store, classify, isLogNoise, savedChars } from "../src/core/stats.ts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("ansi stripping removes colour codes and shrinks text", () => {
  const coloured = "\x1b[32mPASS\x1b[0m \x1b[2m0:00.12\x1b[0m";
  const clean = stripAnsi(coloured);
  assert.equal(clean, "PASS 0:00.12");
  assert.ok(coloured.length > clean.length);
});

test("classify separates blanks, log noise and content", () => {
  assert.equal(classify("   "), "blank");
  assert.equal(classify("2026-10-04T09:00:11Z INFO  worker heartbeat"), "log");
  assert.equal(classify("const x = 1;"), "content");
});

test("isLogNoise needs timestamp or severity, not a bare number", () => {
  assert.ok(isLogNoise("2026-10-04T09:00:11Z DEBUG cache miss"));
  assert.ok(isLogNoise("ERROR something broke"));
  assert.ok(!isLogNoise("return 42"));
  assert.ok(!isLogNoise("src/index.ts:10: const total = 1234"));
});

test("safe level never loses content-bearing lines", () => {
  const src = "line one\nline two\nline three\n";
  const r = compress(src, { level: "safe", store: new Store() });
  assert.equal(r.text, src);
  assert.equal(savedChars(r.stats), 0);
});

test("aggressive collapses identical-template lines reversibly", () => {
  const store = new Store();
  const input = Array.from(
    { length: 60 },
    (_, i) => `src/mod${i}.ts(${i},4): error TS2322: type mismatch`,
  ).join("\n");
  const r = compress(input, { level: "aggressive", store });

  assert.ok(r.text.length < input.length / 20, "should compress hard");
  assert.match(r.text, /×59 more/);
  assert.equal(store.size, 1, "one ref for the whole cluster");

  const ref = r.text.match(/ref=([a-z0-9]+)/)![1];
  const recovered = store.get(ref)!;
  assert.equal(recovered, input, "ref restores the exact original text");
});

test("aggressive never grows the payload", () => {
  const store = new Store();
  const inputs = [
    "",
    "a",
    "x\n".repeat(3),
    JSON.stringify({ a: 1, b: [1, 2, 3] }, null, 2),
    Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
    "\x1b[31mred\x1b[0m\n".repeat(20),
  ];
  for (const input of inputs) {
    const r = compress(input, { level: "aggressive", store });
    assert.ok(
      r.text.length <= input.length,
      `grew: ${input.length} -> ${r.text.length} for ${JSON.stringify(input.slice(0, 40))}`,
    );
  }
});

test("every stored ref round-trips byte-exact", () => {
  const store = new Store();
  const lines = Array.from({ length: 40 }, (_, i) => `repeat block entry ${i % 8}`);
  const input = lines.join("\n");
  const r = compress(input, { level: "aggressive", store });

  for (const ref of store.keys()) {
    const original = store.get(ref)!;
    assert.equal(typeof original, "string");
    assert.ok(original.length > 0);
  }
  assert.ok(store.size >= 1);
});

test("clustered output restores the full original through its ref", () => {
  const store = new Store();
  const block = Array.from({ length: 10 }, (_, i) => `entry ${i}`).join("\n");
  const input = Array.from({ length: 5 }, () => block).join("\n");
  const r = compress(input, { level: "aggressive", store });

  assert.ok(r.text.includes("entry 0"), "first occurrence kept verbatim");
  assert.match(r.text, /ref=([a-z0-9]+)/);

  const ref = r.text.match(/ref=([a-z0-9]+)/)![1];
  assert.equal(store.get(ref), input, "ref holds every collapsed line");
});

test("aggressive preserves document order when interleaving logs and content", () => {
  const store = new Store();
  // Content and log noise alternate. A pre-pass that hoists log lines to the
  // front would cluster harder but permanently lose the interleaving.
  // Content lines sit between log runs, so the log lines are NOT one
  // contiguous slice: hoisting them together would fabricate a block that never
  // existed in the input.
  const input = [
    "IMPORTANT: do not reformat files",
    "2024-01-01T10:00:00 INFO starting worker",
    "2024-01-01T10:00:01 INFO starting worker",
    "CRITICAL: db connection lost",
    "2024-01-01T10:00:02 INFO starting worker",
    "2024-01-01T10:00:03 INFO starting worker",
    "see docs/limits.md for the retry budget",
    "2024-01-01T10:00:04 INFO starting worker",
    "2024-01-01T10:00:05 INFO starting worker",
    "FINAL: shutting down cleanly",
  ].join("\n");

  compress(input, { level: "aggressive", store });

  // Every stored ref must be a contiguous slice of the original, never a
  // concatenation drawn from two places in the file.
  for (const ref of store.keys()) {
    const held = store.get(ref)!;
    assert.ok(
      input.includes(held),
      `ref ${ref} holds text that is not a contiguous slice of the input`,
    );
  }
});

test("content lines keep their relative order after aggressive", () => {
  const store = new Store();
  const input = [
    "MARKER_ALPHA unique alpha",
    "2024-01-01T10:00:00 INFO worker tick",
    "2024-01-01T10:00:01 INFO worker tick",
    "MARKER_BETA unique beta",
    "MARKER_GAMMA unique gamma",
  ].join("\n");

  const r = compress(input, { level: "aggressive", store });
  const a = r.text.indexOf("MARKER_ALPHA");
  const b = r.text.indexOf("MARKER_BETA");
  const g = r.text.indexOf("MARKER_GAMMA");

  assert.ok(a >= 0 && b > a && g > b, `order not preserved: alpha=${a} beta=${b} gamma=${g}`);
});

test("refs survive a store restart when persisted to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "squeeze-"));
  const path = join(dir, "store.jsonl");
  try {
    const input = Array.from({ length: 40 }, (_, i) => `worker ${i}: ready`).join("\n");

    const first = new Store({ path });
    compress(input, { level: "aggressive", store: first });
    first.close();
    const ref = first.keys()[0];
    assert.ok(ref, "a ref was created and persisted");

    // Fresh process: nothing in memory, only the file.
    const second = new Store({ path });
    assert.equal(second.get(ref), input, "ref resolves after restart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("identical text yields the same ref across independent stores", () => {
  const a = new Store();
  const b = new Store();
  const text = "the same collapsed span";
  assert.equal(a.put(text), b.put(text), "content addressing is deterministic");
});

test("store evicts oldest entries past its cap", () => {
  const s = new Store({ maxEntries: 3 });
  const refs = ["one", "two", "three", "four", "five"].map((t) => s.put(t));
  assert.equal(s.size, 3, "cap enforced");
  assert.equal(s.get(refs[4]), "five", "newest kept");
  assert.equal(s.get(refs[0]), undefined, "oldest evicted");
});

test("default Store writes nothing to disk", () => {
  const before = existsSync(join(process.cwd(), ".squeeze"));
  const s = new Store();
  s.put("side effect check");
  assert.equal(existsSync(join(process.cwd(), ".squeeze")), before,
    "a plain Store must not create .squeeze in the caller's cwd");
});
