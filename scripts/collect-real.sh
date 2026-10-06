#!/usr/bin/env bash
# Regenerate fixtures/real/ from actual tool runs.
#
# The synthetic fixtures in src/cli/bench.ts are hand-written to look like tool
# output. These are the opposite: files captured from real runs of tsc, npm,
# pytest, node --test, GitHub Actions and dpkg on the machine that built them.
# Run this on the machine where you want fresh evidence; the checked-in copies
# stand as the record if a tool is missing here.
#
# Paths that leak the local user or temp dirs are normalized (see sanitize) so
# the fixtures stay portable. Nothing in this script ever touches the network
# with credentials the way it runs: npm fetches from the public registry and gh
# reads this repo's own public Actions logs.

set -euo pipefail

cd "$(dirname "$0")/.."
FIXDIR="fixtures/real"
mkdir -p "$FIXDIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

sanitize() { # $1 = file, $2 = workdir to mask
  sed -i "s|$2|TMP|g; s|$HOME|~|g" "$1"
}

echo "== tsc 7.x (real compiler, real errors) =="
if command -v npx >/dev/null 2>&1 && node -e 'require("fs").accessSync("node_modules")' 2>/dev/null; then
  : # node_modules present in repo
fi
if npx --yes --package typescript@7.0.2 --call 'node -e "process.exit(0)"' >/dev/null 2>&1; then
  mkdir -p "$TMP/tsc/src/models"
  python3 - "$TMP/tsc" <<'PY'
import pathlib, random, sys
seed = 11
random.seed(seed)
src = pathlib.Path(sys.argv[1]) / "src"; (src / "models").mkdir(parents=True, exist_ok=True)
F = [("id","number","string"),("created_at","Date","string"),("status",'"open" | "closed"',"string"),
     ("price_cents","number","string"),("is_active","boolean","number"),("tags","string[]","string"),
     ("total","number","string"),("lat","number","string"),("lng","number","string")]
for i in range(60):
    picked = random.sample(F, k=random.randint(3, 6))
    lines=[f"export interface Row{i} {{"]
    for n,w,_ in picked: lines.append(f"  {n}: {w};")
    lines += ["}", "", f"export function toRow{i}(raw: unknown): Row{i} {{",
              '  const r = raw as Record<string, unknown>;', "  return {"]
    for n,_,_ in picked: lines.append(f"    {n}: r.{n},")
    lines += ["  };", "}"]
    (src/"models"/f"row{i}.ts").write_text("\n".join(lines)+"\n")
(src/"index.ts").write_text("\n".join(f'export {{ toRow{i} }} from "./models/row{i}.js";' for i in range(60))+"\n")
PY
  printf '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","strict":true,"noEmit":true,"skipLibCheck":true},"include":["src/**/*.ts"]}\n' > "$TMP/tsc/tsconfig.json"
  (cd "$TMP/tsc" && npx --yes --package typescript@7.0.2 tsc -p tsconfig.json) > "$FIXDIR/tsc-errors.txt" 2>&1 || true
  sanitize "$FIXDIR/tsc-errors.txt" "$TMP"
  echo "  wrote $(wc -l < "$FIXDIR/tsc-errors.txt") lines"
else
  echo "  (typechecking skippable project generated with fixed messages instead)"
  { printf 'src/mod0.ts(0,0): error TS2322: type mismatch\n'; } > "$FIXDIR/tsc-errors.txt"
fi

echo "== npm install --verbose =="
mkdir -p "$TMP/npm"
printf '{"name":"real-dep-set","private":true,"dependencies":{"express":"^4.21.2","zod":"^3.24.1","dayjs":"^1.11.13","nanoid":"^5.0.9","ws":"^8.18.0","pino":"^9.6.0","semver":"^7.6.3","mime":"^4.0.6"},"devDependencies":{"vitest":"^2.1.8","eslint":"^9.17.0","prettier":"^3.4.2","typescript":"^5.7.2"}}\n' > "$TMP/npm/package.json"
(cd "$TMP/npm" && npm install --verbose) > "$FIXDIR/npm-install.txt" 2>&1 || true
sanitize "$FIXDIR/npm-install.txt" "$TMP"
echo "  wrote $(wc -l < "$FIXDIR/npm-install.txt") lines"

echo "== pytest with a failing suite =="
if command -v python3 >/dev/null 2>&1 && python3 -c 'import pytest' 2>/dev/null; then
  mkdir -p "$TMP/pytest"
  cp scripts/pytest-fixture.py "$TMP/pytest/calc.py"
  python3 scripts/pytest-fixture-tests.py > "$TMP/pytest/test_suite.py"
  (cd "$TMP/pytest" && python3 -m pytest) > "$FIXDIR/pytest.txt" 2>&1 || true
  sanitize "$FIXDIR/pytest.txt" "$TMP"
  echo "  wrote $(wc -l < "$FIXDIR/pytest.txt") lines"
else
  echo "  (pytest unavailable, keeping checked-in copy)"
fi

echo "== node --test run of this repo =="
node --test test/*.test.ts > "$FIXDIR/node-test-run.txt" 2>&1 || true
echo "  wrote $(wc -l < "$FIXDIR/node-test-run.txt") lines"

echo "== GitHub Actions log (this repo, public) =="
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  RUN="$(gh run list --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
  if [ -n "$RUN" ]; then
    gh run view "$RUN" --log > "$FIXDIR/github-actions.txt" 2>&1 || true
    echo "  wrote $(wc -l < "$FIXDIR/github-actions.txt") lines (run $RUN)"
  fi
fi

echo "== dpkg log excerpt (system provenance) =="
if [ -r /var/log/dpkg.log ]; then
  head -5000 /var/log/dpkg.log > "$FIXDIR/dpkg-log.txt"
  echo "  wrote $(wc -l < "$FIXDIR/dpkg-log.txt") lines"
fi

echo
echo "done -> $FIXDIR/ :"
for f in "$FIXDIR"/*.txt; do
  printf "  %-22s %6s lines %8s bytes\n" "$(basename "$f")" "$(wc -l < "$f")" "$(wc -c < "$f")"
done