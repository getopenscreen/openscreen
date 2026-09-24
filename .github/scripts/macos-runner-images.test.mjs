import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Read as text, like scripts/ffmpeg-linked-libraries.test.mjs: a YAML parser would mean a new
// dependency for one assertion, and `runs-on:` is a single line either way.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowsDir = path.join(repoRoot, ".github/workflows");

const workflows = fs
	.readdirSync(workflowsDir)
	.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
	.map((name) => ({ name, text: fs.readFileSync(path.join(workflowsDir, name), "utf8") }));

/** Every macOS runner label a workflow names, wherever it appears — `runs-on:` directly, or a
 *  matrix `os:` that feeds one. Both spellings are in use here.
 *
 *  Every label ON the line, not the first: build.yml picks its image with a ternary inside the
 *  `runs-on:` expression, so a rule that read only the first match would never see the arm64
 *  half of `matrix.arch == 'x64' && 'macos-15-intel' || 'macos-latest'` — the exact place a
 *  pin could hide from this file. */
function macRunnerLabels({ text }) {
	return text
		.split("\n")
		.filter((line) => /^\s*(?:runs-on|-? *os):/.test(line))
		.flatMap((line) => line.match(/macos[\w.-]*/g) ?? []);
}

describe("macOS runner images", () => {
	it("pins no arm64 macOS image", () => {
		// The one that bit us: `macos-14` kept working until Homebrew stopped building bottles
		// for it, at which point `brew install ffmpeg` fell back to compiling x265 from source
		// and every pull request went red — including ones touching only `website/`. Homebrew
		// builds bottles for the versions it supports, and `macos-latest` is always one of
		// them, so a pinned arm64 image is a dated bomb with nothing to defuse it.
		//
		// Intel is the exception below, not an oversight: there is no floating Intel label.
		const pinned = workflows.flatMap((w) =>
			macRunnerLabels(w)
				.filter((label) => /^macos-\d+(\.\d+)?(-arm64)?$/.test(label))
				.map((label) => `${w.name}: ${label}`),
		);
		expect(pinned).toEqual([]);
	});

	it("allows a pinned Intel image, because no floating one exists", () => {
		// `macos-15-intel` is deliberate: the x64 legs need an Intel runner and GitHub publishes
		// no `macos-latest-intel`. When Homebrew drops macOS 15 this WILL break the same way,
		// and the fix is to move to whatever Intel image exists then — not to reach for a
		// floating label that does not.
		const intel = workflows.flatMap((w) =>
			macRunnerLabels(w).filter((label) => label.endsWith("-intel")),
		);
		expect(intel.length).toBeGreaterThan(0);
		for (const label of intel) expect(label).toMatch(/^macos-\d+-intel$/);
	});

	it("keeps the compositor job on a floating arm64 runner", () => {
		// Named explicitly: this job is the reason the rule exists, and it is the one with a
		// hard arm64 requirement — a real Metal device, /opt/homebrew paths and the aarch64
		// toolchain — so a future "just use macos-latest-intel" would break it differently.
		const ci = workflows.find((w) => w.name === "ci.yml");
		expect(ci).toBeDefined();
		const job = ci.text.slice(ci.text.indexOf("rust-macos-compositor-check:"));
		expect(job.slice(0, job.indexOf("steps:"))).toContain("runs-on: macos-latest");
	});
});
