import json
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[4]
src = Image.open(root / "src/assets/gajae-icon.png").convert("RGBA")
box = (118, 120, 912, 892)
crop = src.crop(box)
w, h = crop.size


def grid(cols):
    cell = w / cols
    rows = int(round(h / cell))
    out = []
    for r in range(rows):
        for c in range(cols):
            x0, y0 = int(c * cell), int(r * cell)
            x1, y1 = int((c + 1) * cell), int((r + 1) * cell)
            px = list(crop.crop((x0, y0, x1, y1)).getdata())
            opaque = [p for p in px if p[3] > 128]
            if len(opaque) < len(px) * 0.5:
                continue
            n = len(opaque)
            rr = sum(p[0] for p in opaque) // n
            gg = sum(p[1] for p in opaque) // n
            bb = sum(p[2] for p in opaque) // n
            out.append([c, r, "%02x%02x%02x" % (rr, gg, bb)])
    return {"cols": cols, "rows": rows, "cells": out}


data = {"dots": grid(54), "pixels": grid(30)}
blob = json.dumps(data, separators=(",", ":"))
html = Path(__file__).with_name("promo.html")
text = html.read_text()
a = text.index("/*MASCOT:BEGIN*/") + len("/*MASCOT:BEGIN*/")
b = text.index("/*MASCOT:END*/")
html.write_text(text[:a] + "const MASCOT=" + blob + ";" + text[b:])
print(len(blob), data["dots"]["rows"], len(data["dots"]["cells"]))
