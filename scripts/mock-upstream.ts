#!/usr/bin/env node
// Mock upstream that echoes the request body back as JSON.
// Lets the proxy test observe exactly what squeeze forwarded upstream.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8972);

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { raw };
    }
    const out = JSON.stringify({ echoed: body, receivedBytes: raw.length });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(out),
    });
    res.end(out);
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`mock upstream on http://127.0.0.1:${port}\n`);
});
