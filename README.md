# squeeze

**Cut 49.7% of your coding agent's prompt tokens. Losslessly.**

A drop-in proxy that sits between your agent and the LLM API, compresses tool
output before it hits the context window, and keeps every original byte
retrievable — by the model itself, over MCP. No code changes. No dependencies.
One environment variable.

```
20,068 tokens  ->  10,102 tokens      saves ~9,966 tokens per request
```

---

## Why

Your context window is not full of your code. It is full of 200 identical
`TS2322` errors, 400 identical test-pass lines, and heartbeat logs that arrived
at 09:00:11. The model reads all of it, every turn, and you pay for all of it.

Existing token compressors delete. If the model later needs the deleted lines,
it cannot get them back — and you find out when it hallucinates a fix.

squeeze never deletes. It clusters, counts, and hands back a short ref:

```
src/mod0.ts(0,7): error TS2322: type mismatch  ⟨×119 more, ref=83a63083475a87f0⟩
```

That single line replaces 120. When the model decides it needs the real list, it
calls `squeeze_fetch` and gets every original line back:

```
  83a63083475a87f0 ->  120 lines, 6,412 chars
```

Refs are content-addressed and persisted to disk, so they survive a proxy
restart. A ref printed into a transcript last week still resolves today.

```bash
curl "http://127.0.0.1:8899/squeeze/expand?ref=83a63083475a87f0"
```

---

## Install

Requires Node 22.18+. No build step, no dependencies — Node runs the TypeScript
directly.

```bash
git clone https://github.com/arcnosixta/squeeze
cd squeeze
node src/cli/main.ts doctor
```

Or as a package, which puts `squeeze` and `squeeze-mcp` on your PATH:

```bash
npm install -g squeeze
squeeze doctor
```

## Use

**As a proxy** (works with Claude Code, Codex, Cursor, anything speaking the
OpenAI or Anthropic API):

```bash
node src/cli/main.ts serve

export ANTHROPIC_BASE_URL=http://127.0.0.1:8899
export OPENAI_BASE_URL=http://127.0.0.1:8899
```

**On a file:**

```bash
node src/cli/main.ts compress build.log --aggressive > small.log
node src/cli/main.ts inspect build.log --aggressive
```

## Benchmark

```bash
node src/cli/main.ts bench aggressive
```

| fixture | original | after | saved |
| --- | ---: | ---: | ---: |
| `npm-install-verbose` | 18,156 | 16,426 | 9.5% |
| `tsc-errors` | 11,387 | 125 | 98.9% |
| `json-dump` | 13,609 | 13,609 | 0.0% |
| `test-run` | 15,275 | 67 | 99.6% |
| `heartbeat-logs` | 4,759 | 85 | 98.2% |
| `source-file` | 4,820 | 4,818 | 0.0% |
| `blank-heavy` | 1,299 | 1,181 | 9.1% |
| `dup-blocks` | 2,939 | 55 | 98.1% |
| **total** | **72,244** | **36,366** | **49.7%** |

Reproduce it yourself:

```bash
node src/cli/main.ts selftest    # 9,779 -> 80 chars
```

The 0.0% rows are the point: `json-dump` and `source-file` are irreducible, and
squeeze leaves them alone rather than pretending otherwise. It compresses noise,
never meaning.

## MCP

Give the model a way to undo the compression on its own terms. This is the part
that makes losslessness real: without it, a ref is a promise nobody can keep.

```bash
node src/cli/main.ts mcp
```

```json
{
  "mcpServers": {
    "squeeze": {
      "command": "node",
      "args": ["/path/to/squeeze/src/mcp/server.ts"]
    }
  }
}
```

Two tools:

| tool | purpose |
| --- | --- |
| `squeeze_fetch` | expand one ref back to its exact original text |
| `squeeze_compress` | compress noisy text before it enters context |

`squeeze_fetch` is the one that matters. The model reads
`⟨×119 more, ref=83a6…⟩`, decides the collapsed lines matter, and pulls them.

## Levels

| level | behaviour | reversible |
| --- | --- | --- |
| `none` | passthrough, byte-identical | n/a |
| `safe` | strips ANSI colour codes, collapses blank-line runs | no, see below |
| `aggressive` | safe + clusters repeated lines into counted refs | clusters yes |

```bash
SQUEEZE_LEVEL=aggressive node src/cli/main.ts serve
```

Being straight about this: `safe` is not byte-reversible. It discards ANSI codes
and extra blank lines, and keeps no ref. Those bytes carry no information a model
needs, but calling that "lossless" would be wrong. Only the clustering in
`aggressive` is reversible, and that is where the savings actually come from —
every fixture that matters compresses through clustering, not through whitespace.

## Limits

`squeeze` compresses the *text payload* of tool results. It does not:

- Compress OpenAI's Responses API shape (`input` instead of `messages`)
- Touch images, audio, or binary tool results
- Scope the store per project — refs from two projects share one store, which is
  fine for expansion (keys are content hashes) but means no per-project eviction
- Guarantee savings on source code or JSON. Those are irreducible, and the
  benchmark reports 0.0% for them on purpose

If your workload is mostly `cat`-ing source files, this will not help you. If it
is mostly test runs, compiler errors, and build logs, it will.

## What it does not touch

- Your system prompt, instructions, or `max_tokens`
- Extended thinking blocks (`type: "thinking"`) — rewriting these changes
  reasoning semantics, so they pass through byte-identical
- `tool_use_id` and every structural field
- Your input object is cloned, never mutated

## CLI

```
squeeze bench [safe|aggressive|none]   run the benchmark
squeeze serve                        start the proxy
squeeze compress <file|--level>      compress a file or stdin
squeeze inspect <file|--level>       preview changes, write nothing
squeeze doctor                       check environment and store
squeeze selftest                     verify compression and ref durability
squeeze mcp                          run the MCP server on stdio
```

`--level` accepts `none`, `safe`, `aggressive`, or the alias `--aggressive`.
`SQUEEZE_LEVEL` sets the default when the flag is absent.

## Env

| variable | default | meaning |
| --- | --- | --- |
| `SQUEEZE_LEVEL` | `safe` | `none`, `safe`, `aggressive` |
| `SQUEEZE_PORT` | `8899` | proxy port |
| `SQUEEZE_HOST` | `127.0.0.1` | bind address |
| `SQUEEZE_UPSTREAM_URL` | `https://api.openai.com` | forward target |
| `SQUEEZE_UPSTREAM` | `openai` | `openai` or `anthropic` |
| `SQUEEZE_STORE` | `./.squeeze/store.jsonl` | where refs are persisted |

Endpoints: `/squeeze/health`, `/squeeze/expand?ref=…`

## How it works

Four passes over each text block:

1. **ANSI strip** — colour codes carry no meaning to a model.
2. **Template clustering** — digit runs collapse to `#` regardless of
   neighbouring word characters, so `suite1`, `module12` and `(3,14)` all match
   their siblings. Timestamps normalize for free, so log lines group too. This
   is the highest-yield pass on compiler output.
3. **Block dedup** — runs of 8+ identical lines collapse to a range reference.
4. **Blank-run collapse** — trailing newlines are preserved exactly, since tools
   diff on them.

Every collapse writes its original text into the store and emits a ref. Nothing
is unrecoverable.

Clustering happens in place. Hoisting log lines out of the transcript to group
them better would squeeze a few percent more, but it would silently reorder the
document — the model would read a reshuffled version of the user's history whose
original sequence no longer exists anywhere. That is not lossless, so the tests
enforce order preservation:

```
test/aggressive preserves document order when interleaving logs and content
```

A ref only ever holds a contiguous slice of the real input. That property is
asserted, not assumed.

## Tests

```bash
npm test                      # 21 unit tests
npm run test:proxy            # end-to-end proxy, real HTTP, all 3 levels
npm run test:mcp              # MCP over a real stdio JSON-RPC session
npm run test:persistence      # ref survives a full proxy restart
```

The proxy test asserts the full round trip: compress a nested Anthropic
`tool_result`, confirm the forwarded payload shrank, confirm the untouched fields
survived, then expand the ref and count all 120 original lines back.

The persistence test is the important one. It kills the proxy outright, starts a
fresh one, and expands a ref created before the kill. That is the failure mode
that would silently corrupt a long-running agent session.

## Status

Working and tested: proxy, CLI, MCP server, persistent store.

Not yet: OpenAI Responses API shape (`input` instead of `messages`), per-project
store scoping, and a benchmark measured on real transcripts rather than
fixtures.

## License

MIT
