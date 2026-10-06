#!/usr/bin/env node
/**
 * Minimal MCP stdio server exposing squeeze as a tool.
 *
 * The point is to close the loop: the model sees `⟨×119 more, ref=83a6…⟩` in
 * its context and can pull the real text back on demand, instead of guessing.
 * Compression stays lossless in the way that actually matters — reversible by
 * the only party that needs it.
 *
 * Deliberately dependency-free: MCP over stdio is newline-delimited JSON-RPC,
 * which is small enough to implement directly rather than pull a client SDK for
 * two tools.
 */
import { createInterface } from "node:readline";
import { compress } from "../core/compress.ts";
import { Store, defaultStorePath, type Level } from "../core/stats.ts";

const PROTOCOL = "2025-06-18";
const LEVELS: Level[] = ["none", "safe", "aggressive"];

function level(): Level {
  const v = process.env.SQUEEZE_LEVEL ?? "aggressive";
  return (LEVELS as string[]).includes(v) ? (v as Level) : "aggressive";
}

const store = new Store({ path: defaultStorePath() });

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "squeeze_fetch",
    description:
      "Expand a squeeze ref back to the original text it stands for. Use this " +
      "whenever a compressed span in your context looks like it holds the detail " +
      "you need. Refs appear inline as ⟨×N more, ref=...⟩. Returns the exact " +
      "original bytes, never a summary.",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "The ref value, e.g. 83a63083475a87f0 (ref= prefix optional).",
        },
      },
      required: ["ref"],
    },
  },
  {
    name: "squeeze_compress",
    description:
      "Compress noisy text before it enters your context: compiler errors, test " +
      "output, logs, repeated tool results. Output stays fully reversible; pass " +
      "level 'aggressive' for the largest reduction.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to compress." },
        level: {
          type: "string",
          enum: LEVELS,
          description: "Compression level. Default: aggressive.",
        },
      },
      required: ["text"],
    },
  },
];

function callTool(args: Record<string, unknown>): Record<string, unknown> {
  const name = String(args.name ?? "");
  const params = (args.arguments ?? {}) as Record<string, unknown>;

  if (name === "squeeze_fetch") {
    const raw = String(params.ref ?? "").trim().replace(/^ref=/, "");
    if (!raw) {
      return { content: [{ type: "text", text: "ref is required" }], isError: true };
    }
    const val = store.get(raw);
    if (val === undefined) {
      return {
        content: [
          {
            type: "text",
            text:
              `unknown ref ${raw}. It was probably produced by a different store ` +
              `than the one this server loaded; check SQUEEZE_STORE matches.`,
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: val }] };
  }

  if (name === "squeeze_compress") {
    const text = String(params.text ?? "");
    const lvl = (LEVELS as string[]).includes(String(params.level))
      ? (params.level as Level)
      : "aggressive";
    const r = compress(text, { level: lvl, store });
    const pct =
      text.length === 0 ? 0 : (100 * (text.length - r.text.length)) / text.length;
    const meta = `\n[squeeze:${lvl}] ${text.length} -> ${r.text.length} chars (-${pct.toFixed(1)}%)`;
    return { content: [{ type: "text", text: r.text + meta }] };
  }

  return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
}

function result(id: unknown, payload: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: payload };
}

function error(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stdout.write(JSON.stringify(error(null, -32700, "parse error")) + "\n");
    return;
  }

  const { id, method, params } = msg;

  // Notifications carry no id and expect no response.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      process.stdout.write(
        JSON.stringify(
          result(id, {
            protocolVersion: PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "squeeze", version: "0.1.0" },
          }),
        ) + "\n",
      );
      return;

    case "notifications/initialized":
    case "initialized":
      return;

    case "tools/list":
      process.stdout.write(JSON.stringify(result(id, { tools: TOOLS })) + "\n");
      return;

    case "tools/call":
      try {
        process.stdout.write(
          JSON.stringify(result(id, callTool(params ?? {}))) + "\n",
        );
      } catch (err) {
        process.stdout.write(
          JSON.stringify(
            error(id, -32603, err instanceof Error ? err.message : String(err)),
          ) + "\n",
        );
      }
      return;

    case "ping":
      if (!isNotification) process.stdout.write(JSON.stringify(result(id, {})) + "\n");
      return;

    default:
      if (!isNotification) {
        process.stdout.write(
          JSON.stringify(error(id, -32601, `unknown method ${method}`)) + "\n",
        );
      }
  }
});

rl.on("close", () => {
  store.close();
  process.exit(0);
});