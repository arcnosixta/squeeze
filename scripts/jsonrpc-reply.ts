#!/usr/bin/env node
// Pull one JSON-RPC reply out of an MCP transcript.
//
// usage: jsonrpc-reply <id> [text]
//   no second arg  -> print the whole `result` as JSON
//   "text"         -> print result.content[0].text, which is what assertions read
let buf = "";
process.stdin.on("data", (c) => (buf += c)).on("end", () => {
  const want = Number(process.argv[2]);
  const asText = process.argv[3] === "text";

  let match = null;
  for (const line of buf.split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === want) match = msg;
  }

  if (!match) {
    process.stdout.write("");
    process.exit(1);
  }

  const payload = match.result ?? match.error ?? {};
  if (asText) {
    process.stdout.write(payload?.content?.[0]?.text ?? "");
  } else {
    process.stdout.write(JSON.stringify(payload));
  }
});