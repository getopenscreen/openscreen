"""What the screen showed: cursor and screen-frame pacing in a ddagrab capture of the light preview.

The light project's screen video has a white bar that moves 16 source px per frame (60 fps) in its
top band, and a cursor that sweeps horizontally at constant speed (0.7 width per 2 s). In each
captured desktop frame we locate both. A preview update = either moved. Reports update intervals,
screen frames advanced per update (1 = clean, 0 = repeat, 2+ = skipped), and the cursor's deviation
from a straight line on each constant-speed leg (the "fidget").

usage: python -I analyze_capture.py <cap.mkv> [analyse_seconds]
"""
import json
import subprocess
import sys

import numpy as np

path = sys.argv[1]
span = float(sys.argv[2]) if len(sys.argv) > 2 else 18.0

info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path]))
W, H = info["streams"][0]["width"], info["streams"][0]["height"]
pts = np.array([float(x) for x in subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", path], text=True).split()])
# Geometry, not detection: the bar lives in the top quarter of the screen, the cursor at 62% height.
bar_rows = (int(H * 0.03), int(H * 0.25))
cur_rows = (int(H * 0.45), int(H * 0.85))
cols_idx = np.arange(W)


def xpos(frame, rr):
	sub = frame[rr[0] : rr[1], 4 : W - 4] > 190
	col = sub.sum(axis=0)
	cnt = col.sum()
	return (col * cols_idx[4 : W - 4]).sum() / cnt if cnt > 3 else np.nan


# Streamed one frame at a time: 30 s at 280 fps would be gigabytes held at once.
proc = subprocess.Popen(["ffmpeg", "-v", "fatal", "-i", path, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "-"], stdout=subprocess.PIPE)
bar, cur = [], []
size = W * H
while True:
	buf = proc.stdout.read(size)
	if len(buf) < size:
		break
	f = np.frombuffer(buf, dtype=np.uint8).reshape(H, W)
	bar.append(xpos(f, bar_rows))
	cur.append(xpos(f, cur_rows))
proc.wait()
assert len(bar) == len(pts), (len(bar), len(pts))
n = len(bar)
bar, cur = np.array(bar), np.array(cur)

# Playback starts at the first frame where the cursor moves.
moved = np.where(np.abs(np.diff(cur)) > 0.5)[0]
t_start = pts[moved[0] + 1] if len(moved) else pts[0]
sel = (pts >= t_start) & (pts <= t_start + span)
t, bar, cur = pts[sel] - t_start, bar[sel], cur[sel]

# Bar travel across the screen width gives the capture-px per source-px scale.
bar_range = np.nanmax(bar) - np.nanmin(bar)
scale = bar_range / (1920 - 8)
step = 16 * scale

upd_bar = np.abs(np.diff(bar)) > 0.5
upd_cur = np.abs(np.diff(cur)) > 0.5
upd = np.where(upd_bar | upd_cur)[0] + 1
ut = t[upd]
intervals = np.diff(ut) * 1000

adv = np.diff(bar[np.r_[0, upd]])
adv = np.where(adv < -bar_range / 2, adv + bar_range + 8 * scale, adv)
adv = adv[~np.isnan(adv)]
adv_frames = np.rint(adv / step).astype(int)

# Cursor legs: constant speed between turnarounds every 2 s of programme time. Fit a line per leg
# on the cursor's own updates, leaving 250 ms at each end for the smoothed turn.
cu = np.where(upd_cur)[0] + 1
ct, cx = t[cu], cur[cu]
resid, backward, legs = [], 0, 0
for k in range(int(span // 2) + 1):
	m = (ct > k * 2 + 0.25) & (ct < k * 2 + 1.75)
	if m.sum() < 20:
		continue
	legs += 1
	p = np.polyfit(ct[m], cx[m], 1)
	resid.extend((cx[m] - np.polyval(p, ct[m])) / scale)
	d = np.diff(cx[m])
	backward += int(np.sum(np.sign(d) == -np.sign(p[0])))
resid = np.abs(np.array(resid))


def q(a, p):
	return float(np.percentile(a, p)) if len(a) else None


out = {
	"file": path,
	"frames": int(n),
	"spanSec": span,
	"scaleCapturePxPerSourcePx": float(scale),
	"updates": int(len(upd)),
	"updateHz": float(len(upd) / (ut[-1] - ut[0])) if len(ut) > 1 else None,
	"updateIntervalMs": {"p50": q(intervals, 50), "p95": q(intervals, 95), "p99": q(intervals, 99), "max": float(intervals.max()) if len(intervals) else None, "over25ms": int((intervals > 25).sum()), "over34ms": int((intervals > 34).sum())},
	"screenFramesPerUpdate": {str(k): int(v) for k, v in zip(*np.unique(np.clip(adv_frames, -1, 4), return_counts=True))},
	"cursorUpdates": int(len(cu)),
	"cursorResidualSourcePx": {"rms": float(np.sqrt(np.mean(resid**2))) if len(resid) else None, "p95": q(resid, 95), "p99": q(resid, 99), "max": float(resid.max()) if len(resid) else None},
	"cursorBackwardSteps": backward,
	"legs": legs,
}
print(json.dumps(out))
