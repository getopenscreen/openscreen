# Demo loops

The silent loops on the homepage and the feature pages are served from
Cloudflare R2 at `media.getopenscreen.com/loops/<cut>/`, not from git:
`static/` is committed for good, and a cut of eighteen loops in two codecs and
two sizes is about 75 MB. This folder holds the record of them instead.

`loops.json` lists every published file with its size and SHA-256, and each
loop's duration. CI (`npm run check:loops -- --live`) holds the code and the
CDN to it.

## Publishing a new cut

1. **Masters.** One 1920x1080, 60 fps, silent `<slug>.mp4` per loop, named after
   `LOOP_NAMES` in `src/lib/demo-loop.ts`. They are built, and archived to R2
   under `masters/` (off the public domain), by the openscreen-demo-production
   repository: `v2-launch/README.md`.
2. **Encode.** `FFMPEG=<ffmpeg with x264/x265/libwebp> scripts/media/encode-loops.sh <masters> <out>`
3. **Publish, under a new folder name.** `node scripts/media/publish-loops.mjs --cut <yyyy-mm><letter> --dir <out>`
   uploads, rewrites `loops.json` and the generated block in `demo-loop.ts`
   (base URL, durations, publication date). Never reuse a folder: the edge
   caches each file for a year.
4. `npx biome format --write src/lib/demo-loop.ts && npm run check:loops -- --live`, then commit both records.

Upload before anything (a page, a preview) requests the new folder: the zone
caches a 404 for an hour. If it happens, purge those URLs with
`cf cache purge -z <zone> --body '{"files":[...]}' --force`.

## On the Cloudflare side

Bucket `openscreen-media`, Standard storage class (the free tier's), `r2.dev`
off. On the `getopenscreen.com` zone: a cache rule keeping the loops at the
edge for a year with query strings out of the cache key, a WAF rule that serves
only GET/HEAD under `/loops/` with no query string, a 120 requests / 10 s per-IP
rate limit, and billing alerts at any spend and at half of the free tier.

## Responsive backgrounds

The live homepage uses original wallpapers from `public/wallpapers/`, cropped
to 16:9 and encoded offline in AVIF (quality 80, 4:4:4, 10-bit) and WebP
(quality 90), at 960, 1920 and 2560 pixels wide. `<picture>` selects one format
and size; the driver retains two image layers and decodes the next background
before fading it in. Small picker thumbnails and the emergency JPEG fallbacks
remain local. CDN transforms are unnecessary.

1. `node scripts/media/encode-backgrounds.mjs --dir <out>`
2. `node scripts/media/publish-backgrounds.mjs --cut <yyyy-mm><letter> --dir <out>`
3. `npm run check:backgrounds -- --live`, then commit `backgrounds.json` and
   `src/lib/background-media.ts`. The manifest records source hashes, encoder
   settings, dimensions, byte sizes and output hashes. Each file is capped at
   120 KB. Never rewrite a published cut or request it before uploading.

Backgrounds live under `/loops/backgrounds/<cut>/`, reusing the custom domain's
existing WAF and year-long cache rules for GET/HEAD under `/loops/` without
query strings. The bucket, rate limit and billing alerts are shared; no new
Cloudflare product or cache/WAF rule is required. `masters/` remains private.
