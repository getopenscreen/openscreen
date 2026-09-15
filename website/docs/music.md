---
id: music
title: Background music
sidebar_position: 10
description: "The CC0 music library bundled with OpenScreen: what you may do with the tracks, why every one of them is public domain, and where to find more."
keywords:
  - background music
  - royalty free music
  - CC0 music
  - public domain music
  - video soundtrack
---

# Background music

OpenScreen ships a small library of background music. It lives in the **Audio** tab of the
right-hand inspector, under the output gain; the **audio** button in the timeline toolbar
has a **Music library** entry that opens the same place.

Press play on a track to audition it, then **Add**: it lands on the music lane at the
playhead, quiet by default, eased in and out, and looped if it is shorter than what is left
of your recording. Volume, fades, loop and placement are all editable afterwards on the
track itself.

## What you may do with these tracks

All of it. Every bundled track is released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), a public-domain dedication:
the authors gave up their rights rather than licensing them to you.

- **No credit is required.** Not in the video, not in the description, not anywhere.
- **Commercial use is fine**, including monetized videos, client work and paid products.
- **No registration, no per-video licence, no expiry.**
- You do not need permission from us or from the authors, and there is nothing to renew.

The credits in
[THIRD-PARTY-NOTICES.md](https://github.com/getopenscreen/openscreen/blob/main/THIRD-PARTY-NOTICES.md)
are courtesy, not obligation. Every track there carries its source and an archived copy of
the licence statement as it stood when we bundled it, so the claim above stays checkable.

## One caveat, if you publish to YouTube

**Content ID matches audio fingerprints, not licences.** A public-domain track can still
draw an automated copyright claim if somebody else registered a recording of it, and that
happens to public-domain music more often than it should.

It is disputable, and you have solid ground to dispute it on: the track is in the public
domain, and YouTube's own rules say public-domain material is not eligible as Content ID
reference material. Open the claim in YouTube Studio, dispute it, and point at the source
and licence links in our notices file.

This is not a reason to avoid the library. It is a reason to know what to do if it happens.

## Finding more music

The library is deliberately small. **More music** at the bottom of the panel opens
OpenGameArt's search pre-filtered to Art Type "Music" and licence "CC0" — the exact query
these tracks were sourced from. The results list does not print the licence, so open an
item's own page to confirm it before you commit to a track.

Other sources worth knowing, all of which host several licences side by side, so **check
every single track**:

- [Free Music Archive](https://freemusicarchive.org/) — filter for CC0 or Public Domain
- [Openverse](https://openverse.org/) — filter audio by CC0
- [Wikimedia Commons](https://commons.wikimedia.org/) and
  [Musopen](https://musopen.org/) — public-domain recordings, classical in Musopen's case
- [Freesound](https://freesound.org/) — filter for CC0

Then use **Import audio file** in the same audio menu to bring the file in.

### Two traps worth naming

**"Free for commercial use" is not the same as CC0.** Sites like Pixabay, Mixkit, Bensound
and Uppbeat let you *use* their music, but their terms forbid redistributing the file
itself. That is fine for a video you publish, and it is why we cannot bundle their tracks
in the app.

**CC-BY requires credit in your video.** It is a perfectly good licence, and a lot of the
best free music uses it — including most of what you will find searching "royalty free". It
simply means an obligation that follows your video wherever it goes. Read what each track
asks for before you commit to it.

## Why the bundled library is CC0 only

Because anything else would hand you an obligation you did not ask for. A licence requiring
attribution would travel from our installer into your video and out to your viewers, and a
licence forbidding redistribution could not be bundled at all. CC0 is the only family that
leaves both us and you with nothing owed.

The rule is enforced, not merely stated: `npm run music:check` fails the build if a track
is missing its provenance, if its digest does not match the file, or if its licence is
anything other than CC0.
