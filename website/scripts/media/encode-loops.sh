#!/bin/zsh
# Web encodes of the demo loops, for scripts/media/publish-loops.mjs.
#
#   scripts/media/encode-loops.sh <masters dir> <out dir>
#
# For every <slug>.mp4 master (1920x1080, 60 fps, silent): HEVC (tagged hvc1, so
# Safari plays it) and H.264, each at 1080p60 and 720p60, no audio track
# (WebKit only autoplays without a gesture when there is none), faststart, and a
# WebP poster of frame 0, which is the frame the loop starts on.
#
# Settings measured with VMAF against the masters: x265 crf 25 slow lands
# around 94-98, 23% lighter than x264 at equal quality. Needs an ffmpeg built
# with libx264, libx265 and libwebp (FFMPEG=..., e.g. `npm i ffmpeg-static`);
# the LGPL build under crates/thirdparty has neither encoder.
# Each output is written to a temporary name and renamed only once its encode
# succeeded, so an interrupted run leaves no plausible-looking partial file; a
# master is skipped only when all five of its outputs are there.
set -e
F=${FFMPEG:-ffmpeg}
S=${1:?masters dir}; O=${2:?out dir}; mkdir -p $O
for src in $S/*.mp4; do
  slug=${src:t:r}
  outs=($O/$slug-1080-hevc.mp4 $O/$slug-1080-h264.mp4 $O/$slug-720-hevc.mp4 $O/$slug-720-h264.mp4 $O/$slug-poster.webp)
  all=1; for f in $outs; do [[ -f $f ]] || all=0; done
  (( all )) && continue
  for h in 1080 720; do
    vf="scale=-2:${h}:flags=lanczos"
    $F -v error -y -i $src -an -vf $vf -c:v libx265 -crf 25 -preset slow -tag:v hvc1 \
      -x265-params log-level=error:keyint=120:min-keyint=120 -pix_fmt yuv420p -movflags +faststart -f mp4 $O/.part-$slug-$h-hevc.mp4
    mv $O/.part-$slug-$h-hevc.mp4 $O/$slug-$h-hevc.mp4
    $F -v error -y -i $src -an -vf $vf -c:v libx264 -crf 23 -preset veryslow -g 120 -profile:v high -level 4.2 \
      -pix_fmt yuv420p -movflags +faststart -f mp4 $O/.part-$slug-$h-h264.mp4
    mv $O/.part-$slug-$h-h264.mp4 $O/$slug-$h-h264.mp4
  done
  $F -v error -y -i $src -frames:v 1 -vf "scale=1280:-2:flags=lanczos" -c:v libwebp -quality 80 -f webp $O/.part-$slug-poster.webp
  mv $O/.part-$slug-poster.webp $O/$slug-poster.webp
  echo "$slug done"
done
