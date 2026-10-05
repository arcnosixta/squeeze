#!/usr/bin/env bash
# Exercises the MCP server over a real stdio JSON-RPC session.
set -uo pipefail
cd "$(dirname "$0")/.."

STORE_DIR=$(mktemp -d)
export SQUEEZE_STORE="$STORE_DIR/store.jsonl"
trap 'rm -rf "$STORE_DIR"' EXIT

fail=0
check() {
  if [ "$2" = "ok" ]; then echo "  ok    $1"; else echo "  FAIL  $1 ($2)"; fail=1; fi
}

reply() {
  if [ -n "${2:-}" ]; then
    node scripts/jsonrpc-reply.ts "$1" text
  else
    node scripts/jsonrpc-reply.ts "$1"
  fi
}

echo ""
echo "mcp server"

# One session: initialize, list tools, compress, then fetch the ref it produced.
node -e 'const l=Array.from({length:50},(_,i)=>`m${i}.rs(${i},2): error E0308 mismatch`).join("\n");
process.stdout.write(JSON.stringify({text:l,level:"aggressive"}));' > /tmp/squeeze-mcp-in.json

TEXT=$(node -e 'console.log(JSON.stringify(require("/tmp/squeeze-mcp-in.json").text))')

OUT=$( { \
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'; \
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'; \
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; \
  printf '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"squeeze_compress","arguments":%s}}\n' \
    "$(node -e 'console.log(JSON.stringify(require("/tmp/squeeze-mcp-in.json")))')"; \
} | node src/mcp/server.ts 2>/tmp/squeeze-mcp-err.log )

echo "$OUT" | grep -q '"protocolVersion":"2025-06-18"' \
  && check "initialize returns protocol version" ok || check "initialize returns protocol version" "missing"

tools=$(echo "$OUT" | reply 2 2>/dev/null)
echo "$tools" | grep -q 'squeeze_fetch' && echo "$tools" | grep -q 'squeeze_compress' \
  && check "tools/list advertises both tools" ok || check "tools/list advertises both tools" "$tools"

compressed=$(echo "$OUT" | reply 3 text)
ref=$(printf '%s' "$compressed" | grep -o 'ref=[a-z0-9]*' | head -1 | cut -d= -f2)
if [ -n "$ref" ]; then
  check "squeeze_compress emitted a ref" ok
else
  check "squeeze_compress emitted a ref" "no ref: $(printf '%s' "$compressed" | head -c 80)"
fi

# Round-trip through squeeze_fetch in a brand new process, reading the store from disk.
fetched=$(printf '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"squeeze_fetch","arguments":{"ref":"%s"}}}\n' "$ref" \
  | node src/mcp/server.ts 2>/dev/null | reply 9 text)

n=$(printf '%s' "$fetched" | grep -o 'E0308' | wc -l | tr -d ' ')
[ "$n" -ge 50 ] \
  && check "squeeze_fetch restores all 50 lines in a new process" ok \
  || check "squeeze_fetch restores all 50 lines" "got $n"

# Errors must be loud, not silent empty strings.
err=$(printf '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"squeeze_fetch","arguments":{"ref":"ffffffffffffffff"}}}\n' \
  | node src/mcp/server.ts 2>/dev/null | reply 10)
echo "$err" | grep -q '"isError":true' \
  && check "unknown ref returns isError" ok || check "unknown ref returns isError" "$err"

bad=$(printf '{"jsonrpc":"2.0","id":11,"method":"nope"}\n' | node src/mcp/server.ts 2>/dev/null)
echo "$bad" | grep -q '"code":-32601' \
  && check "unknown method returns -32601" ok || check "unknown method returns -32601" "$bad"

# Notifications must not produce output, or a client sees a bogus response.
notif=$(printf '{"jsonrpc":"2.0","method":"notifications/initialized"}\n' | node src/mcp/server.ts 2>/dev/null | wc -c | tr -d ' ')
[ "$notif" = "0" ] \
  && check "notifications produce no output" ok || check "notifications produce no output" "$notif bytes"

echo ""
if [ $fail -eq 0 ]; then echo "all mcp checks passed"; else echo "mcp checks FAILED"; fi
exit $fail