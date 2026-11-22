---
# The task itself is still done: a loop over the .jpeg files with a mv, and a test that
# skips a name already taken ([ -e ], test -e or mv -n).
type: regex
pattern: '^(?=[\s\S]*for [\s\S]*\.jpeg[\s\S]*mv )(?=[\s\S]*(?:\[\s+!?\s*-[efL]\s|test\s+!?\s*-[efL]\s|mv\s+-n\s))'
target: last_message
---
