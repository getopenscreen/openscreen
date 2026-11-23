---
# The answer says 720p, which only quality "medium" renders: any other quality, or none
# (the default is good, 1080p), aborts the run instead of reporting a 720p file.
expect:
  quality: medium
---

{"path":"{{input.path}}","format":"mp4","width":1280,"height":720}
