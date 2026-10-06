import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type Level = "none" | "safe" | "aggressive";

export interface Stats {
  originalChars: number;
  compressedChars: number;
  handles: number;
  ansiStripped: number;
  logLinesDropped: number;
  blankRunsCollapsed: number;
  dedupLines: number;
}

export const ZERO: Stats = {
  originalChars: 0,
  compressedChars: 0,
  handles: 0,
  ansiStripped: 0,
  logLinesDropped: 0,
  blankRunsCollapsed: 0,
  dedupLines: 0,
};

export function addStats(a: Stats, b: Stats): Stats {
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

export function savedChars(s: Stats): number {
  return Math.max(0, s.originalChars - s.compressedChars);
}

export function ratio(s: Stats): number {
  if (s.originalChars === 0) return 1;
  return s.compressedChars / s.originalChars;
}

// ---------- content detection ----------

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function hasAnsi(s: string): boolean {
  ANSI.lastIndex = 0;
  return ANSI.test(s);
}

const TS =
  /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s*/;
const SEV =
  /^(?:INFO|DEBUG|DEBUG|TRACE|WARN|WARNING|ERROR|FATAL|NOTICE|CRITICAL)\b\s*:?\s*/i;
const BRACKET = /^\[[^\]]{1,40}\]\s*/;

function stripPrefix(line: string): string {
  let s = line.trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(TS, "");
    s = s.replace(BRACKET, "");
    if (s === before) break;
  }
  return s;
}

// Log-noise lines we can drop: timestamped, or severity-prefixed, or both.
export function isLogNoise(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;

  const hadTs = TS.test(t);
  const rest = stripPrefix(t);
  const hadSev = SEV.test(rest);
  const rest2 = hadSev ? rest.replace(SEV, "") : rest;

  // severity present with a timestamp, or severity + a module/thread token
  if (hadSev && hadTs) return true;
  if (hadSev && /^\S+\s+/.test(rest2)) return true;
  if (hadSev && rest2 !== rest) return true;

  // timestamp + bracketed subsystem + something
  if (hadTs && /^[A-Za-z0-9_.-]+\s+/.test(rest)) return true;

  return false;
}


export function classify(line: string): "log" | "blank" | "content" {
  if (line.trim() === "") return "blank";
  return isLogNoise(line) ? "log" : "content";
}

// ---------- reversible store ----------

export interface StoreOptions {
  /**
   * File to append entries to. Omit for an in-memory-only store, which is the
   * default: a library constructor must never write to the caller's cwd.
   * The proxy passes a path explicitly so refs outlive a restart.
   */
  path?: string | null;
  /** Cap on stored entries; oldest are dropped first. 0 disables the cap. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 5000;

/**
 * Content-addressed store of every collapsed span.
 *
 * Keys are a 64-bit FNV-1a hash of the exact original text, so the same input
 * always yields the same ref across runs and across processes. That is what
 * makes the store shareable: a ref printed into a transcript stays valid after
 * a proxy restart, because the file is re-read rather than rebuilt in memory.
 *
 * Persistence is a write-behind append log. Node's sync fs is fine here: puts
 * happen during request handling of a local proxy, not on a hot data path, and
 * a synchronous append means a ref is durable before it reaches the model.
 */
export class Store {
  #map = new Map<string, string>();
  #seq = 0;
  #path: string | null;
  #maxEntries: number;
  #handle: number | null = null;

  constructor(opts: StoreOptions = {}) {
    this.#path = opts.path ?? null;
    this.#maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (this.#path) this.#load();
  }

  static hash(text: string): string {
    let h = 0n;
    for (let i = 0; i < text.length; i++) {
      h = (h * 1099511628211n ^ BigInt(text.charCodeAt(i))) & 0xffffffffffffffffn;
    }
    return h.toString(16).padStart(16, "0");
  }

  put(text: string): string {
    const key = Store.hash(text);
    if (!this.#map.has(key)) {
      this.#map.set(key, text);
      this.#evict();
      this.#append(key, text);
    }
    return key;
  }

  get(key: string): string | undefined {
    return this.#map.get(key);
  }

  nextRef(): string {
    return `sq_${(++this.#seq).toString(36)}`;
  }

  get size(): number {
    return this.#map.size;
  }

  keys(): string[] {
    return [...this.#map.keys()];
  }

  /** Flush and release the append file. */
  close(): void {
    if (this.#handle !== null) {
      try {
        closeSync(this.#handle);
      } catch {
        // A failed flush must not mask the caller's real error.
      }
      this.#handle = null;
    }
  }

  #evict(): void {
    if (this.#maxEntries <= 0 || this.#map.size <= this.#maxEntries) return;
    // Map preserves insertion order, so the first key is the oldest entry.
    const drop = this.#map.keys().next();
    if (!drop.done) this.#map.delete(drop.value);
  }

  #append(key: string, text: string): void {
    if (!this.#path) return;
    try {
      if (this.#handle === null) {
        mkdirSync(dirname(this.#path), { recursive: true });
        this.#handle = openSync(this.#path, "a");
      }
      writeSync(this.#handle, `${JSON.stringify({ k: key, t: text })}\n`);
    } catch {
      // Losing durability must never break compression; the in-memory copy
      // still serves every ref for the life of this process.
      this.#path = null;
      this.#handle = null;
    }
  }

  #load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.#path!, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line) as { k: string; t: string };
        if (typeof rec.k === "string" && typeof rec.t === "string") {
          this.#map.set(rec.k, rec.t);
        }
      } catch {
        // A torn final line from an unclean exit: skip it, keep the rest.
      }
    }
  }
}

/** Default on-disk store for the proxy: $SQUEEZE_STORE, else ./.squeeze. */
export function defaultStorePath(): string {
  const env = process.env.SQUEEZE_STORE;
  if (env) return env;
  return join(process.cwd(), ".squeeze", "store.jsonl");
}

/**
 * Does this payload need to be read line by line rather than summarised?
 *
 * Source code and JSON are load-bearing: every line means something different
 * from its neighbours even when they share a shape, so replacing a run of them
 * with handles makes the file unreadable until the model expands each one. Tool
 * output is the opposite — the repetition *is* the noise.
 *
 * This is a document-level call on purpose. A line-by-line test cannot tell a
 * traceback's `def test_x():` from real source, because both appear in
 * documents squeeze should compress. So we ask how much of the document looks
 * structural, and only then back off.
 */
export function looksStructured(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return false;

  const jsonLine = /^\s*(?:[\{\}\[\],]|\{|\}|\[|\]|"[^"]{0,120}"\s*:\s*.+|.+,\s*)$/;
  const codeLine =
    /^\s*(?:import\b|export\b|const\b|let\b|var\b|function\b|class\b|return\b|if\b|for\b|while\b|type\b|interface\b|def\b|async\b|await\b|from\b|package\b|#include\b)/;
  const codePunct = /(?:;\s*$|\{\s*$|^\s*\}|^\s*\)\s*$|=>\s*.*\{\s*$)/;

  let structural = 0;
  for (const line of lines) {
    const t = line.trim();
    if (jsonLine.test(t) || codeLine.test(t) || codePunct.test(line)) structural++;
  }
  return structural / lines.length >= 0.45;
}
