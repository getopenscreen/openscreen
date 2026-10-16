#!/bin/bash
# usage: run-record.sh <scratch> <outdir> <runs...>
# Each take is analysed right after it ends, then deleted: it holds the webcam picture.
HERE=$(dirname "$0")
S="$1"; OUT="$2"; shift 2
W=$(cygpath -m "$S")
mkdir -p "$S/out/$OUT"
for run in "$@"; do
  if [ $((run % 2)) = 1 ]; then order="v200 main"; else order="main v200"; fi
  for v in $order; do
    node "$HERE/record-bench.mjs" --ver $v --app "$W/app-$v" --profile "$W/profiles/rec-$v" --out "$W/out/$OUT" --run $run
    rec="$S/profiles/rec-$v/recordings"
    scr=$(ls "$rec"/recording-* 2>/dev/null | grep -E ".(mp4|webm|mkv)$" | grep -v -- -webcam | head -1)
    cam=$(ls "$rec"/recording-*-webcam.* 2>/dev/null | grep -E ".(mp4|webm|mkv)$" | head -1)
    if [ -n "$scr" ]; then
      python "$HERE/analyze_recording.py" "$(cygpath -m "$scr")" ${cam:+"$(cygpath -m "$cam")"} > "$S/out/$OUT/record-$v-r$run.analysis.json"
      cat "$S/out/$OUT/record-$v-r$run.analysis.json"; echo
    fi
    rm -rf "$rec"
    sleep 3
  done
done
