import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Integration test for the two tools the MCP server exposes. It talks to the
// real server over stdio instead of importing internals, so it exercises the
// same JSON-RPC surface a host sees — and names squeeze_compress/squeeze_fetch
// explicitly so tool coverage is visible.

const SERVER = fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url));

interface RpcMessage {
  id?: unknown;
  result?: { tools?: ToolShape[]; content?: { type: string; text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

interface ToolShape {
  name: string;
  annotations?: Record<string, unknown>;
}

function call(name: string, args: Record<string, unknown>, id: number) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/** Spawn the server, feed it these requests, and return every reply line. */
function run(requests: object[], env: Record<string, string> = {}): Promise<RpcMessage[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("close", () => {
      resolve(
        out
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as RpcMessage),
      );
    });
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
    child.stdin.end();
  });
}

function byId(msgs: RpcMessage[], id: number): RpcMessage {
  const m = msgs.find((x) => x.id === id);
  assert.ok(m, `no reply for id ${id}`);
  return m;
}

test("tools/list exposes squeeze_compress and squeeze_fetch with all four hints", async () => {
  const msgs = await run([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
  const tools = byId(msgs, 1).result?.tools ?? [];
  const found = new Map(tools.map((t) => [t.name, t]));

  for (const name of ["squeeze_compress", "squeeze_fetch"]) {
    const tool = found.get(name);
    assert.ok(tool, `${name} is advertised`);
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.equal(
        typeof tool!.annotations?.[hint],
        "boolean",
        `${name}.annotations.${hint} must be an explicit boolean`,
      );
    }
  }

  assert.equal(found.get("squeeze_fetch")!.annotations!.readOnlyHint, true);
  assert.equal(found.get("squeeze_compress")!.annotations!.readOnlyHint, false);
});

test("squeeze_compress then squeeze_fetch round-trips through the stdio server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squeeze-mcp-"));
  const env = { SQUEEZE_STORE: join(dir, "store.jsonl") };
  try {
    const noisy = Array.from(
      { length: 60 },
      (_, i) => `src/mod${i}.ts(${i},4): error TS2322: type mismatch`,
    ).join("\n");

    const compressed = byId(
      await run([call("squeeze_compress", { text: noisy, level: "aggressive" }, 2)], env),
      2,
    );
    const text = compressed.result!.content![0].text;
    assert.ok(text.length < noisy.length / 10, "compress shrank the payload");

    const ref = text.match(/ref=([a-z0-9]+)/)?.[1];
    assert.ok(ref, "compress emitted a ref");

    // New process, fresh store read from disk — the ref must still resolve.
    const fetched = byId(await run([call("squeeze_fetch", { ref: `ref=${ref}` }, 3)], env), 3);
    assert.equal(fetched.result!.content![0].text, noisy, "fetch restored the exact original");

    const missing = byId(
      await run([call("squeeze_fetch", { ref: "ffffffffffffffff" }, 4)], env),
      4,
    );
    assert.equal(missing.result!.isError, true, "unknown ref is reported as an error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
