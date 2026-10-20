// Exits 0 when the first version is at or past the second, 1 when it is behind.
// promote.yml asks it whether main already has the stable version: syncing on
// inequality alone would set main back to 2.0.1 if 2.0.1 were promoted after
// 2.1.0. A prerelease sits below the release of the same core: 2.1.0-rc.1 < 2.1.0.

import { argv, exit } from "node:process";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/;

const parse = (version) => {
	const match = VERSION.exec(version);
	if (!match) throw new Error(`invalid version ${JSON.stringify(version)}`);
	return { core: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) };
};

/**
 * @param {string} version e.g. main's package.json version.
 * @param {string} target e.g. the stable version just released.
 */
export function versionAtLeast(version, target) {
	const a = parse(version);
	const b = parse(target);
	const order = a.core[0] - b.core[0] || a.core[1] - b.core[1] || a.core[2] - b.core[2];
	return order > 0 || (order === 0 && (!a.prerelease || b.prerelease));
}

// Only run when invoked directly, so the test can import the function.
if (import.meta.filename === argv[1]) {
	exit(versionAtLeast(argv[2], argv[3]) ? 0 : 1);
}
