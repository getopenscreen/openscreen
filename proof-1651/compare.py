"""Compare two proof runs: hashes.txt per frame, and diff bounding boxes of saved PNGs."""
import sys
from pathlib import Path

from PIL import Image, ImageChops


def hashes(d):
    return dict(l.split() for l in (Path(d) / "hashes.txt").read_text().splitlines())


def bbox(a, b, idx):
    pa, pb = Path(a) / f"f{int(idx):04d}.png", Path(b) / f"f{int(idx):04d}.png"
    if not (pa.exists() and pb.exists()):
        return "no png"
    diff = ImageChops.difference(Image.open(pa).convert("RGB"), Image.open(pb).convert("RGB"))
    box = diff.getbbox()
    if not box:
        return "identical"
    n = sum(1 for p in diff.getdata() if p != (0, 0, 0))
    return f"bbox={box} px={n}"


a, b = sys.argv[1], sys.argv[2]
ha, hb = hashes(a), hashes(b)
print(f"frames: {len(ha)} vs {len(hb)}")
diff = sorted((int(k) for k in ha if ha[k] != hb.get(k)))
print(f"differing frames: {len(diff)}")
for k in diff:
    print(k, bbox(a, b, k))
