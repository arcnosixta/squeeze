import { test } from "node:test";
import assert from "node:assert/strict";
import { transformRequest } from "../src/core/transform.ts";
import { Store, savedChars } from "../src/core/stats.ts";

test("anthropic tool_result blocks get compressed in place", () => {
  const store = new Store();
  const noisy = Array.from(
    { length: 80 },
    (_, i) => `src/f${i}.ts(${i},2): error TS2322: type mismatch`,
  ).join("\n");

  const payload = {
    model: "claude-sonnet-5",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "run tsc" },
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: noisy }] },
        ],
      },
    ],
  };

  const r = transformRequest(payload, "aggressive", store);

  assert.ok(savedChars(r.stats) > 0, "should save tokens");
  assert.equal(r.payload.max_tokens, 1024, "unrelated fields untouched");
  assert.equal(r.payload.messages[0].content[0].text, "run tsc", "user text untouched");
  assert.ok(
    r.payload.messages[0].content[1].content[0].text.length < noisy.length / 10,
    "tool result compressed",
  );
  assert.ok(store.size >= 1, "original retained in store");
});

test("openai tool-role string content is compressed", () => {
  const store = new Store();
  const noisy = Array.from({ length: 120 }, (_, i) => `2026-10-04T09:00:00Z INFO  worker tick ${i}`).join("\n");

  const payload = {
    model: "gpt-5",
    messages: [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "check logs" },
      { role: "tool", content: noisy },
    ],
  };

  const r = transformRequest(payload, "aggressive", store);
  assert.ok(savedChars(r.stats) > 0);
  assert.equal(r.payload.messages[0].content, "you are helpful", "system prompt untouched");
  assert.equal(r.payload.messages[1].content, "check logs", "user prompt untouched");
  assert.ok(r.payload.messages[2].content.length < noisy.length / 5);
});

test("original request object is not mutated", () => {
  const store = new Store();
  const noisy = Array.from({ length: 60 }, (_, i) => `err line ${i}`).join("\n");
  const payload = { messages: [{ role: "user", content: noisy }] };
  const before = payload.messages[0].content;

  transformRequest(payload, "aggressive", store);
  assert.equal(payload.messages[0].content, before, "input left intact");
});

test("non-object payloads pass through safely", () => {
  const store = new Store();
  for (const p of [null, "string", 42]) {
    const r = transformRequest(p as never, "aggressive", store);
    assert.equal(r.payload, p);
    assert.equal(r.stats.originalChars, 0);
  }
});

test("extended thinking blocks are never rewritten", () => {
  const store = new Store();
  const thinking = Array.from(
    { length: 60 },
    (_, i) => `reasoning step ${i} about the architecture`,
  ).join("\n");

  const payload = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking, signature: "sig-abc" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  };

  const r = transformRequest(payload, "aggressive", store);
  assert.equal(
    r.payload.messages[0].content[0].thinking,
    thinking,
    "thinking preserved verbatim",
  );
  assert.equal(r.payload.messages[0].content[0].signature, "sig-abc");
});

test("compresses multi-turn transcripts across both formats at once", () => {
  const store = new Store();
  const a = Array.from({ length: 50 }, (_, i) => `2026-10-04T09:00:00Z DEBUG tick ${i}`).join("\n");
  const b = Array.from({ length: 50 }, (_, i) => `warn deprecated dep-${i}@1.0.0: use 2.x`).join("\n");

  const payload = {
    model: "claude-sonnet-5",
    system: "you are a careful engineer",
    messages: [
      { role: "user", content: [{ type: "text", text: "run the build" }] },
      { role: "assistant", content: [{ type: "text", text: "running now" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: a }] }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: b }] }] },
      { role: "assistant", content: [{ type: "text", text: "found it" }] },
    ],
  };

  const r = transformRequest(payload, "aggressive", store);

  assert.ok(savedChars(r.stats) > 0);
  assert.equal(r.payload.system, "you are a careful engineer", "system prompt untouched");
  assert.equal(r.payload.model, "claude-sonnet-5");
  assert.equal(r.payload.messages[0].content[0].text, "run the build");
  assert.equal(r.payload.messages[4].content[0].text, "found it");
  assert.equal(r.payload.messages[2].content[0].tool_use_id, "a", "tool_use_id preserved");
  assert.equal(r.payload.messages[3].content[0].tool_use_id, "b");
});

test("none level leaves payload byte-identical", () => {
  const store = new Store();
  const payload = { messages: [{ role: "tool", content: "x".repeat(500) }] };
  const r = transformRequest(payload, "none", store);
  assert.equal(r.payload.messages[0].content, "x".repeat(500));
});
