import { createServer } from "node:http";
import { Store, defaultStorePath } from "../core/stats.ts";
import { transformRequest } from "../core/transform.ts";

const LEVELS = new Set(["none", "safe", "aggressive"]);

function readLevel(): "none" | "safe" | "aggressive" {
  const v = process.env.SQUEEZE_LEVEL ?? "aggressive";
  return LEVELS.has(v) ? (v as "none" | "safe" | "aggressive") : "aggressive";
}

interface ProxyConfig {
  port: number;
  host: string;
}

function readConfig(): ProxyConfig {
  return {
    port: Number(process.env.SQUEEZE_PORT ?? 8899),
    host: process.env.SQUEEZE_HOST ?? "127.0.0.1",
  };
}

// Refs printed into a transcript must stay resolvable after a restart, so the
// proxy persists. One process-wide store keeps refs unique across requests.
const store = new Store({ path: defaultStorePath() });
const level = readLevel();

function json(res: import("node:http").ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(s),
  });
  res.end(s);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function pump(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  upstream: string,
  body: string,
) {
  const target = new URL(req.url ?? "/", upstream);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (k === "host" || k === "content-length") continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  headers["content-length"] = String(Buffer.byteLength(body));

  let up: Response;
  try {
    up = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
  } catch (err) {
    // An unreachable upstream must surface as a proxy error, never crash the
    // process: the agent on the other end would see a dropped socket.
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      json(res, 502, { error: "upstream_unreachable", upstream, message });
    } else {
      res.end();
    }
    return;
  }

  const ct = up.headers.get("content-type") ?? "";
  res.writeHead(up.status, {
    "content-type": ct,
    "cache-control": "no-store",
  });

  if (!ct.includes("event-stream")) {
    const buf = Buffer.from(await up.arrayBuffer());
    res.end(buf);
    return;
  }

  // Stream SSE through untouched.
  const reader = up.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

export function createProxy() {
  const cfg = readConfig();

  const server = (async (req, res) => {
    const url = req.url ?? "/";

    if (url === "/squeeze/health") {
      json(res, 200, { ok: true, level, entries: store.size });
      return;
    }

    if (url.startsWith("/squeeze/expand")) {
      const u = new URL(url, "http://x");
      const ref = u.searchParams.get("ref") ?? "";
      const val = store.get(ref);
      if (val === undefined) {
        json(res, 404, { error: "unknown ref", ref });
        return;
      }
      json(res, 200, { ref, text: val });
      return;
    }

    const anthropic =
      req.headers["x-squeeze-upstream"] === "anthropic" ||
      process.env.SQUEEZE_UPSTREAM === "anthropic";

    const upstream =
      process.env.SQUEEZE_UPSTREAM_URL ??
      (anthropic ? "https://api.anthropic.com" : "https://api.openai.com");

    const raw = await readBody(req);

    if (level === "none" || (req.method !== "POST" && req.method !== "PUT")) {
      await pump(req, res, upstream, raw);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await pump(req, res, upstream, raw);
      return;
    }

    const r = transformRequest(parsed, level, store);
    const saved = r.stats.originalChars - r.stats.compressedChars;
    if (saved > 0) {
      process.stderr.write(
        `squeeze: ${r.stats.originalChars} -> ${r.stats.compressedChars} chars (-${(100 * saved / r.stats.originalChars).toFixed(1)}%)\n`,
      );
    }

    await pump(req, res, upstream, JSON.stringify(r.payload));
  }) as unknown as import("node:http").RequestListener;

  return { server: createServer(server), cfg };
}

const isMain = process.argv[1]?.endsWith("squeeze.ts") ||
  process.argv[1]?.endsWith("squeeze.js");

if (isMain) {
  const { server, cfg } = createProxy();
  server.listen(cfg.port, cfg.host, () => {
    process.stderr.write(
      `squeeze proxy listening on http://${cfg.host}:${cfg.port} (level=${level})\n`,
    );
  });
}
