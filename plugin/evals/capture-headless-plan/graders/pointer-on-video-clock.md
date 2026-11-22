---
# createProject with the take, then setPointerTrack. The video clock (recordingStartedAt 0)
# travels inside the script's take.mp4.pointer.json, which the skill passes as it is, so
# the answer need not spell the 0 out; the judged grader checks that the clock is right.
type: regex
pattern: 'createProject[\s\S]*setPointerTrack'
target: last_message
---
