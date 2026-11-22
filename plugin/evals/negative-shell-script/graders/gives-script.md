---
# The task itself is still done: a loop over the .jpeg files with a mv that never touches a
# .jpg name already taken, whatever takes it. The prompt asks for a POSIX script, so a test
# must do it, not mv's options: [ -e ] is false on a dangling symbolic link, and mv then
# replaces the link; mv -n moves the file into a directory of that name, and -T, which
# stops that, is GNU mv only (macOS and BSD mv refuse it). A regex cannot tell whether an
# existence test decides the move, so a judge reads the script.
type: llm
---

Read the final answer to the user. PASS only if every item holds:

1. It gives a shell script that loops over the .jpeg files in the current directory and renames each one, with mv, to the same name ending in .jpg.
2. A file whose .jpg name is already taken is skipped, whatever takes the name: a file, a directory or a dangling symbolic link. A test on that target name decides whether mv runs (through `if`, `&&`, `||` or `continue`), and it uses `-e` together with `-L` or `-h`, such as `[ -e "$t" ] || [ -L "$t" ]`.

FAIL if any item is missing. FAIL too if the only existence test is on the .jpeg file itself, or if no test's result stops the mv, as in `[ -e "$f" ]; mv "$f" "${f%.jpeg}.jpg"`. FAIL as well if:

- the target test lacks `-L` and `-h`: a dangling symbolic link fails `-e`, and the mv replaces the link;
- the target test lacks `-e`, such as `-f` with `-L`: a directory fails `-f`, and the mv puts the file inside it;
- the script leaves the skip to mv's options instead of such a test: `mv -n` puts the file inside a directory of the target's name, and `mv -n -T`, which does not, is GNU mv only and not POSIX.
