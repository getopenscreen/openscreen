"""Dropped and duplicated frames in a take recorded over the 120 fps bar pattern.

Screen: the bar advances 16 px per pattern frame, so each 60 fps recorded frame should advance it
by 2 pattern frames. 0 = duplicated frame, >= 4 = at least one recorded frame lost.
Webcam: timestamp gaps, and byte-identical consecutive decoded frames (a live camera never
repeats a frame exactly, so an identical one is a duplicate the pipeline inserted).

usage: python analyze_recording.py <screen.mp4> [webcam.mp4]
"""
import json
import subprocess
import sys

import numpy as np


def probe(path):
	j = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,r_frame_rate,avg_frame_rate,bit_rate:format=duration", "-of", "json", path]))
	pts = np.array(sorted(float(x) for x in subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", path], text=True).split() if x not in ("", "N/A")))
	s = j["streams"][0]
	d = np.diff(pts) * 1000
	nominal = 1000 / eval(s["r_frame_rate"]) if s["r_frame_rate"] != "0/0" else float(np.median(d))
	return {
		"codec": s["codec_name"], "width": s["width"], "height": s["height"], "rFrameRate": s["r_frame_rate"], "avgFrameRate": s["avg_frame_rate"],
		"bitRate": int(s.get("bit_rate", 0) or 0), "duration": float(j["format"]["duration"]), "frames": int(len(pts)),
		"fps": float((len(pts) - 1) / (pts[-1] - pts[0])) if len(pts) > 1 else None,
		"gapsOver1_5x": int((d > 1.5 * nominal).sum()), "maxGapMs": float(d.max()) if len(d) else None,
	}, s


def screen(path):
	info, s = probe(path)
	W, H = s["width"], s["height"]
	w, h = 960, int(960 * H / W) // 2 * 2
	raw = subprocess.check_output(["ffmpeg", "-v", "fatal", "-i", path, "-fps_mode", "passthrough", "-vf", f"scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "gray", "-"])
	f = np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w)[:, int(h * 0.3) : int(h * 0.7), :]
	b = f > 190
	c = b.sum(axis=(1, 2))
	x = np.where(c > 10, (b.sum(axis=1) * np.arange(w)).sum(axis=1) / np.maximum(c, 1), np.nan)
	step = 16 * w / 1920
	rng = 1904 * w / 1920
	d = np.diff(x)
	d = np.where(d < -rng / 2, d + rng, d)
	adv = np.rint(d / step)
	adv = adv[~np.isnan(adv)].astype(int)
	vals, cnt = np.unique(np.clip(adv, -1, 8), return_counts=True)
	info["patternFramesPerFrame"] = {str(k): int(v) for k, v in zip(vals, cnt)}
	info["duplicated"] = int((adv == 0).sum())
	info["droppedAtLeast"] = int(np.clip(adv - 3, 0, None).sum())
	return info


def webcam(path):
	info, s = probe(path)
	md5 = subprocess.check_output(["ffmpeg", "-v", "fatal", "-i", path, "-fps_mode", "passthrough", "-vf", "scale=320:-2", "-f", "framemd5", "-"], text=True).splitlines()
	hashes = [l.rsplit(",", 1)[-1].strip() for l in md5 if l and not l.startswith("#")]
	info["identicalConsecutive"] = int(sum(1 for i in range(1, len(hashes)) if hashes[i] == hashes[i - 1]))
	return info


out = {"screen": screen(sys.argv[1])}
if len(sys.argv) > 2:
	out["webcam"] = webcam(sys.argv[2])
print(json.dumps(out))
