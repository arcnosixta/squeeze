#!/usr/bin/env bash
# Proves a ref survives a full proxy restart, which is what makes squeeze safe
# to run long-lived: a transcript can hold a ref from a previous session.
set -uo pipefail
cd "$(dirname "$0")/.."

STORE_DIR=$(mktemp -d)
export SQUEEZE_STORE="$STORE_DIR/store.jsonl"
P1=8991
P2=8992
UP=8993

cleanup() {
  kill $PROXY1 $PROXY2 $UP_PID 2>/dev/null
  rm -rf "$STORE_DIR"
}
trap cleanup EXIT

node scripts/mock-upstream.ts "$UP" >/dev/null 2>&1 &
UP_PID=$!

SQUEEZE_PORT=$P1 SQUEEZE_LEVEL=aggressive SQUEEZE_UPSTREAM_URL="http://127.0.0.1:$UP" \
  node src/cli/main.ts serve >/tmp/squeeze-restart-1.log 2>&1 &
PROXY1=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$P1/squeeze/health" >/dev/null 2>&1 && break; sleep 0.25; done

node -e '
const lines = Array.from({length: 80}, (_, i) => `pkg${i}/file.ts(${i},9): error TS2322: exact type`).join("\n");
process.stdout.write(JSON.stringify({
  model: "claude-sonnet-5",
  messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1",
    content: [{ type: "text", text: lines }] }] }],
}));' > /tmp/squeeze-restart-req.json

curl -s -X POST -H 'content-type: application/json' \
  --data-binary @/tmp/squeeze-restart-req.json \
  "http://127.0.0.1:$P1/v1/messages" >/dev/null

REF=$(node -e '
const fs = require("fs");
try {
  const line = fs.readFileSync(process.env.SQUEEZE_STORE, "utf8").trim().split("\n")[0];
  console.log(JSON.parse(line).k);
} catch { console.log(""); }')

fail=0
check() {
  if [ "$2" = "ok" ]; then echo "  ok    $1"; else echo "  FAIL  $1 ($2)"; fail=1; fi
}

echo ""
echo "ref durability across restart"

[ -n "$REF" ] && check "ref written to disk" ok || check "ref written to disk" "store file empty"

# Kill the first proxy entirely. Nothing survives in its memory now.
kill $PROXY1 2>/dev/null
wait $PROXY1 2>/dev/null

SQUEEZE_PORT=$P2 SQUEEZE_LEVEL=aggressive SQUEEZE_UPSTREAM_URL="http://127.0.0.1:$UP" \
  node src/cli/main.ts serve >/tmp/squeeze-restart-2.log 2>&1 &
PROXY2=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$P2/squeeze/health" >/dev/null 2>&1 && break; sleep 0.25; done

resp=$(curl -s "http://127.0.0.1:$P2/squeeze/expand?ref=$REF")
n=$(printf '%s' "$resp" | grep -o 'error TS2322' | wc -l | tr -d ' ')
if [ "$n" -ge 80 ]; then
  check "expand after restart restores all 80 lines" ok
else
  check "expand after restart restores all 80 lines" "got $n"
fi

# A ref that was never stored must still fail loudly.
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$P2/squeeze/expand?ref=0000000000000000")
[ "$code" = "404" ] && check "unknown ref still 404 after restart" ok || check "unknown ref still 404 after restart" "got $code"

echo ""
if [ $fail -eq 0 ]; then echo "restart durability checks passed"; else echo "restart checks FAILED"; fi
exit $fail