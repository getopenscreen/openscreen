// Prints the release-branch commits that main does not have, version bumps aside.
// Reads `git cherry -v origin/main origin/release/vX.Y.Z` on stdin; prints nothing
// when main already holds every fix.
//
// promote.yml syncs only the version into main: every fix on a release branch is a
// cherry-pick of a commit already on main, so the bumps are all main lacks. A fix
// committed straight to the release branch breaks that contract, and this is what
// names it instead of leaving it behind. A cherry-pick resolved differently from its
// original also shows up here: `git cherry` matches on the patch, not the subject.

import { readFileSync } from "node:fs";
import { argv } from "node:process";

const VERSION_BUMP = /^chore\(release\): bump to /;

/**
 * @param {string} cherry Output of `git cherry -v <main> <release>`.
 * @returns {string[]} "<sha> <subject>" for each commit missing from main.
 */
export function unsyncedFixes(cherry) {
	return cherry
		.split("\n")
		.filter((line) => line.startsWith("+ "))
		.map((line) => line.slice(2))
		.filter((commit) => !VERSION_BUMP.test(commit.slice(commit.indexOf(" ") + 1)));
}

// Only run when invoked directly, so the test can import the function.
if (import.meta.filename === argv[1]) {
	for (const commit of unsyncedFixes(readFileSync(0, "utf8"))) console.log(commit);
}
