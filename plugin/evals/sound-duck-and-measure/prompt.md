---
# Protects the sound skill's two rules: music under a voice is ducked 6 to 12 dB, and the
# mix is measured with getAudioReport after it is placed, with the measured numbers quoted
# back (-14.6 LUFS, -1.3 dBTP in this case's mock) rather than a claim that it sounds fine.
description: The sound skill imports a music bed, ducks it under the narration and quotes the measured loudness.
tags: [sound]
max_turns: 20
allowed_tools: [Read, Glob, Grep, Skill]
---

My OpenScreen project p_demo already has a narration. Put the music file /home/me/music/calm-bed.mp3 under it for the whole film.
