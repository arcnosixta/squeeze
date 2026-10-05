import { compress } from "./compress.ts";
import { Store, type Level, type Stats } from "./stats.ts";

export interface Block {
  type?: string;
  text?: string;
  content?: unknown;
  [k: string]: unknown;
}

export function emptyStats(): Stats {
  return {
    originalChars: 0,
    compressedChars: 0,
    handles: 0,
    ansiStripped: 0,
    logLinesDropped: 0,
    blankRunsCollapsed: 0,
    dedupLines: 0,
  };
}

export function merge(a: Stats, b: Stats): Stats {
  return {
    originalChars: a.originalChars + b.originalChars,
    compressedChars: a.compressedChars + b.compressedChars,
    handles: a.handles + b.handles,
    ansiStripped: a.ansiStripped + b.ansiStripped,
    logLinesDropped: a.logLinesDropped + b.logLinesDropped,
    blankRunsCollapsed: a.blankRunsCollapsed + b.blankRunsCollapsed,
    dedupLines: a.dedupLines + b.dedupLines,
  };
}

// A block is compressible when it carries agent-visible text. Extended
// thinking is excluded: rewriting it changes reasoning semantics.
function isTextBlock(b: unknown): b is Block & { text: string } {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Block;
  if (o.type === "thinking" || o.type === "redacted_thinking") return false;
  return typeof o.text === "string";
}

// Walk any nested content shape and compress every text block found.
// Anthropic nests tool_result text at content[].content[].text, OpenAI keeps
// tool output as a flat string, and both appear inside the same transcript
// shape across turns, so this has to recurse rather than assume one level.
function walk(node: unknown, level: Level, store: Store, acc: Stats): unknown {
  if (Array.isArray(node)) {
    let total = acc;
    const out = node.map((n) => {
      const r = walk(n, level, store, total);
      total = r.stats;
      return r.value;
    });
    return { value: out, stats: total };
  }

  if (isTextBlock(node)) {
    const r = compress(node.text, { level, store });
    return {
      value: r.text === node.text ? node : { ...node, text: r.text },
      stats: merge(acc, r.stats),
    };
  }

  if (typeof node === "object" && node !== null) {
    const o = node as Block;
    if (Array.isArray(o.content)) {
      const r = walk(o.content, level, store, acc);
      return { value: { ...o, content: r.value }, stats: r.stats };
    }
    if (typeof o.content === "string") {
      const r = compress(o.content, { level, store });
      return {
        value: r.text === o.content ? o : { ...o, content: r.text },
        stats: merge(acc, r.stats),
      };
    }
  }

  return { value: node, stats: acc };
}

export interface TransformResult<T> {
  payload: T;
  stats: Stats;
  store: Store;
}

export function transformRequest<T>(
  payload: T,
  level: Level,
  store: Store,
): TransformResult<T> {
  const body = payload as unknown;
  if (typeof body !== "object" || body === null) {
    return { payload, stats: emptyStats(), store };
  }
  if (level === "none") {
    return { payload, stats: emptyStats(), store };
  }

  const record = body as Record<string, unknown>;
  const messages = record.messages;
  if (!Array.isArray(messages)) {
    return { payload, stats: emptyStats(), store };
  }

  let acc = emptyStats();
  const outMessages = messages.map((m) => {
    const r = walk(m, level, store, acc);
    acc = r.stats;
    return r.value;
  });

  return {
    payload: { ...record, messages: outMessages } as unknown as T,
    stats: acc,
    store,
  };
}
