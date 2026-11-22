---
# The task itself is still done: a loop over the .jpeg files with a mv that never touches a
# .jpg name already taken, whatever takes it. [ -e ] is false on a dangling symbolic link,
# and mv then replaces the link; mv -n without -T moves the file into a directory of that
# name. -T (--no-target-directory) is GNU mv only: macOS and BSD mv refuse it. A regex
# cannot tell whether an existence test decides the move, so a judge reads the script.
type: llm
---

Read the final answer to the user. PASS only if every item holds:

1. It gives a shell script that loops over the .jpeg files in the current directory and renames each one, with mv, to the same name ending in .jpg.
2. A file whose .jpg name is already taken is skipped, whatever takes the name: a file, a directory or a dangling symbolic link. Either a test on that target name decides whether mv runs (through `if`, `&&`, `||` or `continue`) and uses `-e` together with `-L` or `-h`, such as `[ -e "$t" ] || [ -L "$t" ]`; or mv is called with both `-n` and `-T` (`--no-target-directory`).

FAIL if any item is missing. FAIL too if the only existence test is on the .jpeg file itself, or if no test's result stops the mv, as in `[ -e "$f" ]; mv "$f" "${f%.jpeg}.jpg"`. FAIL as well if:

- the target test lacks `-L` and `-h`: a dangling symbolic link fails `-e`, and the mv replaces the link;
- the target test lacks `-e`, such as `-f` with `-L`: a directory fails `-f`, and the mv puts the file inside it;
- mv relies on `-n` without `-T`: a directory with the target's name takes the file inside it.
