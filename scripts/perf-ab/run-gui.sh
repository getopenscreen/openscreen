#!/bin/bash
# usage: run-gui.sh <scratch> <outdir> <hz> light|heavy...
# <scratch> holds app-v200/, app-main/ (extracted builds), projects/ and receives profiles/ and out/.
HERE=$(dirname "$0")
S="$1"; OUT="$2"; HZ="$3"; shift 3
W=$(cygpath -m "$S")
LIGHT=$(cygpath -m "$(ls -S "$S"/projects/*.openscreen | tail -1)")
HEAVY=$(cygpath -m "$(ls -S "$S"/projects/*.openscreen | head -1)")
for sc in "$@"; do
  for run in 1 2 3; do
    if [ $((run % 2)) = 1 ]; then order="v200 main"; else order="main v200"; fi
    for v in $order; do
      if [ "$sc" = light ]; then extra="--capture --play 30"; proj="$LIGHT"; else extra="--play 30 --total 120"; proj="$HEAVY"; fi
      node "$HERE/gui-bench.mjs" --ver $v --app "$W/app-$v" --profile "$W/profiles/gui-$sc-$v" --project "$proj" --scenario $sc --out "$W/out/$OUT" --run $run --hz $HZ $extra
      sleep 3
    done
  done
done
