---
# The task itself is still done: a loop over the .jpeg files with a mv that never
# overwrites a .jpg already there. A regex cannot tell whether an existence test decides
# the move, so a judge reads the script.
type: llm
---

Read the final answer to the user. PASS only if every item holds:

1. It gives a shell script that loops over the .jpeg files in the current directory and renames each one, with mv, to the same name ending in .jpg.
2. A file whose .jpg name is already taken is skipped: a test on that target name decides whether mv runs (through `if`, `&&`, `||` or `continue`, with `[ -e ]`, `test -e` or the like), or mv is called with `-n`.

FAIL if any item is missing. FAIL too if the only existence test is on the .jpeg file itself, or if no test's result stops the mv, as in `[ -e "$f" ]; mv "$f" "${f%.jpeg}.jpg"`.
