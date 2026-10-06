// Prints the tag a release's notes start from: the highest stable tag (vX.Y.Z,
// no suffix) below the given version, by SemVer, or an empty line when there is
// none. The tags come on stdin as `git tag -l 'v*'` lists them: every tag,
// whether or not it is reachable from the release commit.
//
// build.yml used to guess that tag's name by arithmetic and fall back to
// `git describe` when the guess did not exist (#1002). 2.0.0 guessed v1.0.0,
// which never existed, and `git describe` on release/v2.0.0 found the release's
// own last RC: v2.0.0 shipped with an empty changelog. A guess that did exist
// could still be wrong: 1.13.0 compared against v1.12.0 and repeated the PRs of
// v1.12.1 and v1.12.2. Only a tag that exists can come out of here, which also
// keeps the RC notes' `git log <tag>..` from dying on `unknown revision`, as
// v1.9.4-rc.1's did when the guess named a 1.9.3 that never shipped.

import { readFileSync } from "node:fs";
import { argv } from "node:process";

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

const parse = (tag) => tag.match(STABLE_TAG)?.slice(1).map(Number);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * @param {string} version Stable version being released, e.g. "2.0.0".
 * @param {string[]} tags Tag names; anything but vX.Y.Z is ignored.
 * @returns {string} The highest vX.Y.Z below `version`, or "" when there is none.
 */
export function previousStableTag(version, tags) {
	const current = parse(`v${version}`);
	if (!current) throw new Error(`invalid version ${JSON.stringify(version)}; expected X.Y.Z`);
	const below = tags
		.map((tag) => [tag, parse(tag)])
		.filter(([, parts]) => parts && compare(parts, current) < 0);
	below.sort(([, a], [, b]) => compare(b, a));
	return below[0]?.[0] ?? "";
}

// Only run when invoked directly, so the test can import the function.
if (import.meta.filename === argv[1]) {
	console.log(previousStableTag(argv[2], readFileSync(0, "utf8").split(/\s+/)));
}
