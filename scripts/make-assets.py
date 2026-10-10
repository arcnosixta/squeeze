#!/usr/bin/env python3
"""Regenerate the README images from real CLI output.

    python3 scripts/make-assets.py

Writes docs/demo.png (a terminal window) and docs/architecture.png (a flow
diagram). The terminal image is not a mock-up: it runs `squeeze selftest`,
`squeeze bench real aggressive` and `squeeze inspect` and renders their actual
stdout, so the numbers match what the tool prints on this machine. Re-run it
after a change that moves the benchmark and the README keeps telling the truth.

Needs Pillow and a DejaVu font directory (present on essentially every Linux
box). No network, no Node dependencies beyond the repo itself.
"""
from __future__ import annotations

import math
import subprocess
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs"
CLI = ["node", "src/cli/main.ts"]

# ---- palette (GitHub dark, so it reads well on light and dark README themes) --
BG = "#0d1117"
BAR = "#161b22"
BORDER = "#30363d"
TXT = "#c9d1d9"
DIM = "#8b949e"
GREEN = "#3fb950"
BLUE = "#79c0ff"
PROMPT = "#7ee787"

RED = "#ff5f56"
AMBER = "#ffbd2e"
LIME = "#27c93f"

FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    name = "DejaVuSansMono-Bold.ttf" if bold else "DejaVuSansMono.ttf"
    for base in (FONT_DIR, Path("/usr/share/fonts/truetype/noto"), Path("/usr/share/fonts")):
        p = base / name
        if p.exists():
            return ImageFont.truetype(str(p), size)
    sys.exit(f"no monospace font found (looked for {name})")


def run(args: list[str]) -> str:
    try:
        r = subprocess.run(CLI + args, cwd=ROOT, capture_output=True, text=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        sys.exit(f"failed to run squeeze {args[0]}: {e}")
    return r.stdout


# ---- terminal renderer -------------------------------------------------------
# A line is a list of (text, color, bold) segments; monospace keeps columns
# aligned across a regular and a bold run because the advance width is equal.

Seg = tuple[str, str, bool]


def render_terminal(lines: list[list[Seg]], path: Path) -> None:
    px, pad, margin, bar_h, radius, dot = 30, 40, 30, 58, 16, 8
    lh = int(px * 1.55)
    f = font(px)
    fb = font(px, bold=True)
    adv = f.getlength("M")

    cols = max(sum(len(t) for t, _, _ in ln) for ln in lines)
    w = int(cols * adv) + pad * 2 + margin * 2
    h = bar_h + pad + len(lines) * lh + pad + margin * 2

    img = Image.new("RGB", (w, h), "#ffffff")
    d = ImageDraw.Draw(img)

    x0, y0, x1, y1 = margin, margin, w - margin, h - margin
    d.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=BG, outline=BORDER, width=2)

    # title bar with a squared bottom edge so the divider meets the border
    d.rounded_rectangle([x0, y0, x1, y0 + bar_h], radius=radius, fill=BAR)
    d.rectangle([x0, y0 + bar_h - radius, x1, y0 + bar_h], fill=BAR)
    d.line([x0, y0 + bar_h, x1, y0 + bar_h], fill=BORDER, width=2)

    cy = y0 + bar_h // 2
    for i, col in enumerate((RED, AMBER, LIME)):
        cx = x0 + 28 + i * (dot * 3)
        d.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=col)

    title = "squeeze  —  token compression for coding agents"
    tf = font(22)
    tw = d.textlength(title, font=tf)
    d.text((x0 + (x1 - x0 - tw) / 2, cy - tf.size / 2 - 2), title, font=tf, fill=DIM)

    y = y0 + bar_h + pad
    for ln in lines:
        x = x0 + pad
        for text, color, bold in ln:
            if text:
                d.text((x, y), text, font=(fb if bold else f), fill=color)
                x += d.textlength(text, font=f)
        y += lh

    img.save(path)
    print(f"  {path.relative_to(ROOT)}  {w}x{h}")


def terminal_lines() -> list[list[Seg]]:
    selftest = [l for l in run(["selftest"]).splitlines() if l.startswith("self-test:")][0]

    bench_out = run(["bench", "real", "aggressive"]).splitlines()
    start = next(i for i, l in enumerate(bench_out) if l.startswith("real tool output"))
    bench = [l for l in bench_out[start + 1:] if l.strip()]

    insp = run(["inspect", "fixtures/real/tsc-errors.txt", "--aggressive"]).splitlines()
    summary = {l.split()[0]: l for l in insp if l.split() and l.split()[0] in ("original", "compressed", "reduction", "refs")}

    def cmd(c: str) -> list[Seg]:
        return [("$ ", PROMPT, True), (c, BLUE, False)]

    def green_last(line: str, word: str) -> list[Seg]:
        i = line.rfind(word)
        return [(line[:i], DIM, False), (line[i:], GREEN, True)]

    lines: list[list[Seg]] = []
    lines.append(cmd("squeeze selftest"))
    lines.append(green_last(selftest, "PASS"))
    lines.append([])
    lines.append(cmd("squeeze bench real aggressive"))
    for l in bench:
        bold = l.strip().startswith("total")
        lines.append([(l, TXT if bold else DIM, bold)])
    lines.append([])
    lines.append(cmd("squeeze inspect fixtures/real/tsc-errors.txt --aggressive"))
    lines.append([(summary["original"], DIM, False)])
    lines.append([(summary["compressed"], DIM, False)])
    lines.append([(summary["reduction"], GREEN, True)])
    lines.append([(summary["refs"], DIM, False)])
    return lines


# ---- architecture diagram ----------------------------------------------------
def box(d, xy, fill, outline=BORDER, radius=14):
    d.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=3)


def centered(d, xy, text, f, fill, sub=None, subf=None, subfill=None):
    x0, y0, x1, y1 = xy
    lines = text.split("\n")
    sublines = sub.split("\n") if sub else []
    total = len(lines) * (f.size + 8) + len(sublines) * (subf.size + 6 if subf else 0)
    y = y0 + (y1 - y0 - total) / 2
    for l in lines:
        w = d.textlength(l, font=f)
        d.text((x0 + (x1 - x0 - w) / 2, y), l, font=f, fill=fill)
        y += f.size + 8
    for l in sublines:
        w = d.textlength(l, font=subf)
        d.text((x0 + (x1 - x0 - w) / 2, y), l, font=subf, fill=subfill)
        y += subf.size + 6


def arrow(d, p0, p1, color, width=4, head=16):
    d.line([p0, p1], fill=color, width=width)
    ang = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
    for da in (0.5, -0.5):
        d.line(
            [p1, (p1[0] - head * math.cos(ang - da), p1[1] - head * math.sin(ang - da))],
            fill=color, width=width,
        )


def label(d, xy, text, f, fill, anchor="mm"):
    d.text(xy, text, font=f, fill=fill, anchor=anchor)


def render_arch(path: Path) -> None:
    W, H = 1500, 970
    img = Image.new("RGB", (W, H), "#ffffff")
    d = ImageDraw.Draw(img)

    f_title = font(38, bold=True)
    f_box = font(26, bold=True)
    f_sub = font(19)
    f_lab = font(20)
    f_small = font(17)

    d.text((60, 48), "How squeeze fits in", font=f_title, fill="#0d1117")
    d.text((60, 100), "one env var, no code changes", font=f_sub, fill="#57606a")

    card = "#f6f8fa"
    box_d = "#1f6feb"
    box_l = "#8250df"
    box_s = "#1a7f37"

    # node boxes
    agent = (70, 250, 430, 430)
    proxy = (610, 230, 980, 450)
    llm = (1130, 250, 1490, 430)
    store = (610, 640, 980, 830)

    box(d, agent, card, outline="#d0d7de")
    centered(d, agent, "Coding agent", f_box, "#0d1117", "Claude Code, Codex,\nCursor, your own loop", f_sub, "#57606a")

    box(d, proxy, "#ddf4ff", outline=box_d)
    centered(d, proxy, "squeeze proxy", f_box, "#0a3069", "127.0.0.1:8899", f_sub, "#0a3069")

    box(d, llm, card, outline="#d0d7de")
    centered(d, llm, "LLM API", f_box, "#0d1117", "OpenAI / Anthropic", f_sub, "#57606a")

    box(d, store, "#dafbe1", outline=box_s)
    centered(d, store, "ref store", f_box, "#0a3622", "content-addressed, on disk\n./.squeeze/store.jsonl", f_sub, "#0a3622")

    # agent -> proxy
    arrow(d, (430, 320), (610, 320), box_d)
    label(d, (520, 290), "request +\nnoisy tool output", f_lab, "#57606a")

    # proxy -> llm
    arrow(d, (980, 320), (1130, 320), box_d)
    label(d, (1055, 285), "compressed\nprompt + refs", f_lab, "#57606a")

    # proxy -> store (store)
    arrow(d, (795, 450), (795, 640), box_s)
    label(d, (815, 545), "writes every\ncollapsed span", f_lab, "#0a3622", anchor="lm")

    # store -> agent (MCP fetch), routed on the left
    arrow(d, (610, 735), (250, 735), box_s)
    arrow(d, (250, 735), (250, 430), box_s)
    label(d, (430, 705), "squeeze_fetch(ref)  —  exact original bytes over MCP", f_lab, "#0a3622", anchor="mm")

    # footnote
    d.text((70, 870), "Lossless: every ref holds a contiguous slice of the real input; expand() rebuilds the document byte-for-byte.",
           font=f_small, fill="#57606a")
    d.text((70, 900), "ANSI codes and blank-line runs are the only bytes discarded, and they keep no ref.",
           font=f_small, fill="#8c959f")

    img.save(path)
    print(f"  {path.relative_to(ROOT)}  {W}x{H}")


def main() -> None:
    OUT.mkdir(exist_ok=True)
    print("rendering docs:")
    render_terminal(terminal_lines(), OUT / "demo.png")
    render_arch(OUT / "architecture.png")


if __name__ == "__main__":
    main()
