import {
  type Level,
  type Stats,
  type Store,
  ZERO,
  addStats,
  classify,
  hasAnsi,
  looksStructured,
} from "./stats.ts";

export interface CompressResult {
  text: string;
  stats: Stats;
}

const ANSI_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  if (!hasAnsi(s)) return s;
  return s.replace(ANSI_RE, "");
}

// Collapse 3+ blank lines into exactly one blank line.
// Collapse runs of 2+ blank lines into one, preserving trailing newlines exactly.
function collapseBlankRuns(lines: string[]): { lines: string[]; n: number } {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  const tailCount = lines.length - end;

  const out: string[] = [];
  let n = 0;
  let blank = 0;
  for (let i = 0; i < end; i++) {
    if (lines[i].trim() === "") {
      blank++;
      if (blank > 1) {
        n++;
        continue;
      }
    } else {
      blank = 0;
    }
    out.push(lines[i]);
  }

  for (let i = 0; i < tailCount; i++) out.push("");
  return { lines: out, n };
}

// Normalize a line into a template key so structurally identical lines collide.
// Digit runs are replaced regardless of neighbouring word chars, because real
// identifiers embed numbers: `suite1`, `module12`, `(3,14)`, `1ms`.
function templateKey(line: string): string {
  return line
    .replace(/0x[0-9a-fA-F]+/g, "@")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

// Replace repeated line blocks with a handle the agent can expand later.
function dedupeBlocks(
  lines: string[],
  store: Store,
  minBlock: number,
): { lines: string[]; n: number } {
  if (lines.length < minBlock * 2) return { lines, n: 0 };
  const out: string[] = [];
  let n = 0;
  const block = minBlock;
  let i = 0;
  const seen = new Map<string, number>();

  while (i < lines.length) {
    const window = lines.slice(i, i + block).join("\n");
    if (window.trim() !== "" && lines.length - i >= block) {
      const prev = seen.get(window);
      if (prev !== undefined) {
        const ref = store.put(window);
        out.push(`⟨repeat of lines ${prev + 1}-${prev + block}; ref=${ref}⟩`);
        n += block;
        i += block;
        continue;
      }
      seen.set(window, i);
    }
    out.push(lines[i]);
    i++;
  }
  return { lines: out, n };
}

// Collapse runs of structurally identical lines into one line + count.
// This is the highest-yield transform on real logs and compiler output.
function clusterSimilar(
  lines: string[],
  store: Store,
  minRepeat: number,
): { lines: string[]; n: number } {
  const out: string[] = [];
  let n = 0;
  let i = 0;

  while (i < lines.length) {
    if (lines[i].trim() === "") {
      out.push(lines[i]);
      i++;
      continue;
    }
    const key = templateKey(lines[i]);
    if (key === "") {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && templateKey(lines[j]) === key) j++;
    const count = j - i;
    if (count >= minRepeat) {
      const ref = store.put(lines.slice(i, j).join("\n"));
      const marker = `  ⟨×${count - 1} more, ref=${ref}⟩`;
      // Never let the marker cost more than the lines it replaces.
      const groupChars = lines.slice(i, j).join("\n").length;
      if (lines[i].length + marker.length < groupChars) {
        out.push(lines[i] + marker);
        n += count - 1;
      } else {
        for (let k = i; k < j; k++) out.push(lines[k]);
      }
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return { lines: out, n };
}


// Replace a line with a handle whenever an earlier line shared its shape.
//
// The ordering here is the whole point. Real tool output almost never repeats
// *adjacent* lines — an error list names a different file and line number on
// every row, a test run reports a different case, a registry fetch names a
// different package. Clustering only runs of neighbours therefore leaves the
// repetition on the table. This pass keys on the whole document instead, but
// every line keeps its own slot: the original is swapped for a handle in
// place, never hoisted or dropped. Sequence is intact, and because the handle
// stores that specific line's bytes, expansion is byte-exact.
function dedupeRepeats(
  lines: string[],
  store: Store,
): { lines: string[]; n: number } {
  const seen = new Set<string>();
  const out: string[] = [];
  let n = 0;

  for (const line of lines) {
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    const key = templateKey(line);
    if (key === "") {
      out.push(line);
      continue;
    }
    if (seen.has(key)) {
      const ref = store.put(line);
      const marker = `⟨ref=${ref}⟩`;
      // Never let a handle cost more than the line it replaces.
      if (marker.length < line.length) {
        out.push(marker);
        n++;
        continue;
      }
      out.push(line);
      continue;
    }
    seen.add(key);
    out.push(line);
  }
  return { lines: out, n };
}


export interface CompressOptions {
  level: Level;
  store: Store;
  /** Minimum repeated-line-block size before block-dedup kicks in. */
  dedupBlock?: number;
  /** Minimum identical-template runs before clustering kicks in. */
  minRepeat?: number;
}

export function compress(input: string, opts: CompressOptions): CompressResult {
  const { level, store } = opts;
  if (level === "none" || input.length === 0) {
    return { text: input, stats: { ...ZERO, originalChars: input.length, compressedChars: input.length } };
  }

  let s = input;
  let ansiStripped = 0;
  if (hasAnsi(s)) {
    ansiStripped = s.length - stripAnsi(s).length;
    s = stripAnsi(s);
  }

  let lines = s.split("\n");

  // Log noise is never deleted: it is clustered into a counted summary line
  // whose full text stays retrievable through the store. Deleting outright
  // would make aggressive lossy with no recovery path.
  const logLinesBefore = lines.filter((l) => classify(l) === "log").length;
  let logLinesClustered = 0;

  let dedupLines = 0;
  if (level === "aggressive") {
    // Cluster in place. Partitioning log lines away from content lines would
    // cluster harder, but it silently reorders the document: the model would
    // read a reshuffled transcript whose original sequence no longer exists
    // anywhere, so the output could not be called lossless.
    //
    // templateKey already normalizes timestamps to `#`, so adjacent log lines
    // group without any pre-pass.
    const clustered = clusterSimilar(lines, store, opts.minRepeat ?? 3);
    lines = clustered.lines;
    dedupLines += clustered.n;

    const d = dedupeBlocks(lines, store, opts.dedupBlock ?? 8);
    lines = d.lines;
    dedupLines += d.n;

    // The document-wide pass runs last so the neighbour clustering above keeps
    // its richer `×N more` summary for runs that really are contiguous. It is
    // skipped for JSON and source code, where every line means something the
    // model has to read: handles there would cost more than they save.
    if (!looksStructured(s)) {
      const g = dedupeRepeats(lines, store);
      lines = g.lines;
      dedupLines += g.n;
    }

    // Only report log folding when clustering actually consumed log lines.
    logLinesClustered =
      dedupLines > 0 && logLinesBefore > 0
        ? Math.min(logLinesBefore, dedupLines)
        : 0;
  }

  const cb = collapseBlankRuns(lines);
  const blankRunsCollapsed = cb.n;

  const text = cb.lines.join("\n");

  return {
    text,
    stats: addStats(ZERO, {
      originalChars: input.length,
      compressedChars: text.length,
      handles: 0,
      ansiStripped,
      logLinesDropped: logLinesClustered,
      blankRunsCollapsed,
      dedupLines,
    }),
  };
}

const HANDLE_RE = /⟨[^⟩]*ref=([0-9a-f]+)[^⟩]*⟩/;

/**
 * Restore a compressed document by resolving every handle against the store.
 *
 * Every marker squeeze emits — `⟨ref=…⟩`, `⟨×N more, ref=…⟩` and
 * `⟨repeat of lines …; ref=…⟩` — references the exact bytes it replaced, so
 * each one can be swapped back in place and the sequence is untouched. Lines
 * whose sequence is unknown are left as-is rather than erroring: a ref that
 * fell off the store end cannot be fabricated, and a silent gap would be worse
 * than a visible one.
 *
 * Blank-run collapsing and ANSI stripping are not reversible and carry no ref,
 * so those differences survive round-tripping — same as `safe`, whose whole
 * point is that it trades those bytes for brevity.
 */
export function expand(input: string, store: Store): string {
  return input
    .split("\n")
    .map((line) => {
      const m = line.match(HANDLE_RE);
      if (!m) return line;
      const held = store.get(m[1]);
      return held ?? line;
    })
    .join("\n");
}
