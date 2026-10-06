import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { previousStableTag } from "./previous-stable-tag.mjs";

// Real tags of this repository, in the order `git tag -l` prints them: by name, so v1.9.x
// comes after v1.13.0 and picking by position or as text gets it wrong. The v0.0.0-* tags
// host release assets; `git describe` once picked one of them for v2.0.0-rc.1's notes.
const TAGS = [
	"v0.0.0",
	"v0.0.0-onnxruntime-1.27.1",
	"v1.0.1",
	"v1.10.0",
	"v1.12.0",
	"v1.12.1",
	"v1.12.1-rc.1",
	"v1.12.2",
	"v1.12.2-rc.1",
	"v1.13.0",
	"v1.13.0-rc.6",
	"v1.9.2",
	"v1.9.3-rc.1",
	"v1.9.6",
	"v2.0.0",
	"v2.0.0-rc.15",
];

describe("previousStableTag", () => {
	it("compares a major against the last stable of the line before", () => {
		// The arithmetic guessed v1.0.0, which does not exist, and the fallback found
		// v2.0.0-rc.15: v2.0.0 shipped with an empty changelog (#1002).
		expect(previousStableTag("2.0.0", TAGS)).toBe("v1.13.0");
	});

	it("compares a minor against the last patch, not the .0", () => {
		// Against v1.12.0, 1.13.0's notes repeated every PR of v1.12.1 and v1.12.2.
		expect(previousStableTag("1.13.0", TAGS)).toBe("v1.12.2");
	});

	it("compares a patch against the patch before it", () => {
		expect(previousStableTag("1.12.2", TAGS)).toBe("v1.12.1");
	});

	it("is empty when no stable tag sorts below", () => {
		// A first release: its RCs exist, nothing before them does.
		expect(previousStableTag("1.0.0", ["v1.0.0", "v1.0.0-rc.1", "v1.0.0-rc.2"])).toBe("");
	});

	it("ignores pre-release tags", () => {
		// 1.9.3 shipped only as rc.1, so the last release before 1.9.4 is v1.9.2.
		expect(previousStableTag("1.9.4", TAGS)).toBe("v1.9.2");
	});

	it("rejects a version that is not X.Y.Z", () => {
		expect(() => previousStableTag("2.0.0-rc.1", TAGS)).toThrow(/invalid version/);
	});

	// The direct-invocation guard makes the script print nothing at all if it ever stops
	// matching, and the workflow would read that as "no previous release". So this runs it
	// exactly as build.yml does: relative path from the repo root, the tags on stdin.
	it("runs the way build.yml invokes it", () => {
		const repoRoot = join(import.meta.dirname, "../..");
		const workflow = readFileSync(join(repoRoot, ".github/workflows/build.yml"), "utf8");
		expect(workflow).toContain(
			`git tag -l 'v*' | node .github/scripts/previous-stable-tag.mjs "$STABLE_VERSION"`,
		);

		const run = (version) =>
			execFileSync("node", [".github/scripts/previous-stable-tag.mjs", version], {
				cwd: repoRoot,
				input: `${TAGS.join("\n")}\n`,
				encoding: "utf8",
			});
		expect(run("2.0.0")).toBe("v1.13.0\n");
		expect(run("0.0.0")).toBe("\n");
	});
});
