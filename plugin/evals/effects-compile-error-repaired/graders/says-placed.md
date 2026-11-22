---
# The answer gives the effect as placed, not as failed.
type: regex
pattern: 'could not (add|place|compile)|failed to (add|place)|unable to (add|place)'
flags: i
match: not_contains
target: last_message
---
