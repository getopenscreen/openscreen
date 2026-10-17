import { describe, expect, it } from "vitest";
import { unsyncedFixes } from "./release-unsynced-fixes.mjs";

// `git cherry -v origin/main origin/release/v2.1.0-sync` at the v2.1.0 promotion: the
// fixes were cherry-picks already on main ("-"), only the version bumps were not ("+").
const V2_1_0 = [
	"- 421802f3f fix(export): no Full Camera trail at a cut whose chunk start rounds up",
	"+ 216aed223 chore(release): bump to 2.1.0-rc.1 [skip ci]",
	"- 57686f501 fix(preview): restart the playback clock at the requested time on a held frame",
	"+ 36b3814f0 chore(release): bump to 2.1.0-rc.6 [skip ci]",
	"+ 514105057 chore(release): bump to 2.1.0 [skip ci]",
	"",
].join("\n");

describe("unsyncedFixes", () => {
	it("finds nothing when main has every fix and lacks only the bumps", () => {
		expect(unsyncedFixes(V2_1_0)).toEqual([]);
	});

	it("names a fix committed to the release branch alone", () => {
		const cherry = `${V2_1_0}+ 0a1b2c3d4 fix(export): patch made on the release branch only\n`;
		expect(unsyncedFixes(cherry)).toEqual([
			"0a1b2c3d4 fix(export): patch made on the release branch only",
		]);
	});

	it("keeps a commit that only mentions a bump further in its subject", () => {
		const cherry = "+ 0a1b2c3d4 fix(ci): do not chore(release): bump to twice\n";
		expect(unsyncedFixes(cherry)).toEqual([
			"0a1b2c3d4 fix(ci): do not chore(release): bump to twice",
		]);
	});

	it("finds nothing in empty input", () => {
		expect(unsyncedFixes("")).toEqual([]);
	});
});
