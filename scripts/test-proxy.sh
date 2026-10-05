#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

PROXY_PORT="${SQUEEZE_TEST_PORT:-8971}"
UP_PORT="${SQUEEZE_TEST_UPSTREAM:-8972}"
LEVEL="${SQUEEZE_TEST_LEVEL:-aggressive}"

node scripts/mock-upstream.ts "$UP_PORT" >/tmp/squeeze-upstream.log 2>&1 &
UP_PID=$!

SQUEEZE_PORT="$PROXY_PORT" \
SQUEEZE_LEVEL="$LEVEL" \
SQUEEZE_UPSTREAM_URL="http://127.0.0.1:$UP_PORT" \
  node src/cli/main.ts serve >/tmp/squeeze-proxy-test.log 2>&1 &
PROXY_PID=$!

cleanup() { kill $PROXY_PID $UP_PID 2>/dev/null; }
trap cleanup EXIT

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PROXY_PORT/squeeze/health" >/dev/null 2>&1 && break
  sleep 0.25
done

fail=0
check() {
  if [ "$2" = "ok" ]; then echo "  ok    $1"; else echo "  FAIL  $1 ($2)"; fail=1; fi
}

echo ""
echo "proxy integration (level=$LEVEL)"

h=$(curl -s "http://127.0.0.1:$PROXY_PORT/squeeze/health")
echo "$h" | grep -q '"ok":true' && check "health reports ok" ok || check "health reports ok" "$h"
echo "$h" | grep -q '"level"' && check "health reports level" ok || check "health reports level" "$h"

code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PROXY_PORT/squeeze/expand?ref=deadbeefdeadbeef")
[ "$code" = "404" ] && check "unknown ref returns 404" ok || check "unknown ref returns 404" "got $code"

# Build a noisy Anthropic-shaped request with nested tool_result text.
node -e '
const lines = Array.from({length: 120},
  (_, i) => `src/mod${i}.ts(${i},7): error TS2322: type mismatch`).join("\n");
const payload = {
  model: "claude-sonnet-5",
  system: "you are careful",
  messages: [
    { role: "user", content: [{ type: "text", text: "run tsc" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1",
      content: [{ type: "text", text: lines }] }] },
  ],
};
process.stdout.write(JSON.stringify(payload));
' > /tmp/squeeze-req.json

before=$(wc -c < /tmp/squeeze-req.json)

resp=$(curl -s -X POST \
  -H 'content-type: application/json' \
  --data-binary @/tmp/squeeze-req.json \
  "http://127.0.0.1:$PROXY_PORT/v1/messages")

echo "$resp" | grep -q '"echoed"' \
  && check "request forwarded upstream" ok \
  || check "request forwarded upstream" "$(echo "$resp" | head -c 120)"

# Upstream received fewer bytes than we sent => compression happened in flight.
after=$(echo "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).receivedBytes)}catch{console.log(-1)}})')

if [ "$LEVEL" = "none" ]; then
  # none must be a perfect passthrough: identical bytes, no compression at all.
  [ "$after" = "$before" ] \
    && check "none is byte-identical passthrough" ok \
    || check "none is byte-identical passthrough" "before=$before after=$after"
elif [ "$LEVEL" = "safe" ]; then
  # safe only strips ANSI and blank runs, so growth is a failure but a
  # pure-noise fixture may legitimately stay identical.
  if [ "$after" -le "$before" ]; then
    check "safe never grows payload ($before -> $after bytes)" ok
  else
    check "safe never grows payload" "before=$before after=$after"
  fi
elif [ "$after" -ge 0 ] && [ "$after" -lt "$before" ]; then
  check "payload shrank in flight ($before -> $after bytes)" ok
else
  check "payload shrank in flight" "before=$before after=$after"
fi

# Untouched fields must survive the rewrite.
echo "$resp" | grep -q '"model":"claude-sonnet-5"' \
  && check "model preserved" ok || check "model preserved" "missing"
echo "$resp" | grep -q 'you are careful' \
  && check "system prompt preserved" ok || check "system prompt preserved" "missing"
echo "$resp" | grep -q 'run tsc' \
  && check "user text preserved" ok || check "user text preserved" "missing"
echo "$resp" | grep -q '"tool_use_id":"t1"' \
  && check "tool_use_id preserved" ok || check "tool_use_id preserved" "missing"

# The forwarded text must be clustered, and carry a ref we can expand.
ref=$(echo "$resp" | grep -o 'ref=[a-z0-9]*' | head -1 | cut -d= -f2)
if [ -n "$ref" ]; then
  check "forwarded text carries a ref" ok
  orig=$(curl -s "http://127.0.0.1:$PROXY_PORT/squeeze/expand?ref=$ref")
  # The response is JSON-escaped on one line, so count matches not lines.
  n=$(printf '%s' "$orig" | grep -o 'error TS2322' | wc -l | tr -d ' ')
  if [ "$n" -ge 120 ]; then
    check "expand restores all 120 original lines" ok
  else
    check "expand restores all 120 original lines" "got $n"
  fi
elif [ "$LEVEL" = "safe" ]; then
  # safe is lossless: identical bytes and no ref is the correct outcome.
  check "safe emitted no lossy ref" ok
elif [ "$LEVEL" = "none" ]; then
  check "none emitted no ref" ok
else
  check "forwarded text carries a ref" "no ref in response"
fi

echo ""
if [ $fail -eq 0 ]; then echo "all proxy checks passed"; else echo "proxy checks FAILED"; fi
exit $fail
