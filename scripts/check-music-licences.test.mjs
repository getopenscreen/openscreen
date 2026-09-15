// The guard exists because the failure it prevents is silent: a track whose licence
// nobody can check ships, plays, and looks exactly like one whose licence is airtight.
// So the assertions that matter are the REJECTIONS — a version of this script that
// checked nothing would still print a green line on the committed tree.
//
// Run as a subprocess, like check-docs.test.mjs, because the script exits on failure.
// It resolves its paths from the working directory, so a fixture tree is all it takes
// to drive it — no refactor, no injection point.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-music-licences.mjs");

/** @returns {{code: number, out: string}} */
function run(cwd = ROOT) {
	try {
		return { code: 0, out: execFileSync(process.execPath, [SCRIPT], { encoding: "utf8", cwd }) };
	} catch (e) {
		return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
}

const AUDIO = Buffer.from("OggS-not-really-audio-but-the-guard-only-hashes-it");
// sha256 of AUDIO, so the happy-path fixture is self-consistent.
const DIGEST = "76b180aad3d33495c81b808d7f6c9b6edd15a05f9cbe3057bbe48fc6e670c207";

function track(overrides = {}) {
	return {
		id: "fixture-track",
		title: "Fixture Track",
		author: "somebody",
		file: "fixture-track.ogg",
		sha256: DIGEST,
		bytes: AUDIO.length,
		durationSec: 60,
		mood: ["calm"],
		license: "CC0-1.0",
		licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
		sourceUrl: "https://example.org/fixture",
		licenseSnapshotUrl: "https://web.archive.org/web/2026/https://example.org/fixture",
		capturedAt: "2026-09-15",
		...overrides,
	};
}

let tmp = null;

/** A minimal tree the script can be pointed at: manifest, one audio file, notices. */
function fixture({ tracks = [track()], notices, extraFiles = {} } = {}) {
	tmp = mkdtempSync(path.join(os.tmpdir(), "openscreen-music-"));
	mkdirSync(path.join(tmp, "public", "music"), { recursive: true });
	writeFileSync(path.join(tmp, "public", "music", "catalogue.json"), JSON.stringify({ tracks }));
	writeFileSync(path.join(tmp, "public", "music", "fixture-track.ogg"), AUDIO);
	for (const [name, contents] of Object.entries(extraFiles)) {
		writeFileSync(path.join(tmp, "public", "music", name), contents);
	}
	writeFileSync(
		path.join(tmp, "THIRD-PARTY-NOTICES.md"),
		notices ?? tracks.map((t) => `- \`${t.id}\``).join("\n"),
	);
	return tmp;
}

afterEach(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = null;
});

describe("check-music-licences", () => {
	it("passes on the catalogue as committed", () => {
		const { code, out } = run();
		expect(out).toContain("PASSED");
		expect(code).toBe(0);
	});

	it("passes on a well-formed fixture", () => {
		const { code, out } = run(fixture());
		expect(out).toContain("PASSED");
		expect(code).toBe(0);
	});

	// The whole point of the allow-list. A "free for commercial use" licence permits
	// USE but forbids redistributing the raw file, which is what bundling does.
	it("rejects a licence that is not CC0", () => {
		const { code, out } = run(fixture({ tracks: [track({ license: "CC-BY-4.0" })] }));
		expect(out).toContain("is not allowed");
		expect(code).toBe(1);
	});

	it("rejects a CC0 claim that links somewhere other than the deed", () => {
		const { code, out } = run(
			fixture({ tracks: [track({ licenseUrl: "https://example.org/trust-me" })] }),
		);
		expect(out).toContain("licenseUrl must be exactly");
		expect(code).toBe(1);
	});

	// A source page can change or disappear; the archived copy is the only evidence
	// that outlives it.
	it("rejects provenance with no web archive capture", () => {
		const { code, out } = run(
			fixture({ tracks: [track({ licenseSnapshotUrl: "https://example.org/live-page" })] }),
		);
		expect(out).toContain("must point at a web archive");
		expect(code).toBe(1);
	});

	it("rejects a missing required field", () => {
		const { code, out } = run(fixture({ tracks: [track({ sourceUrl: "" })] }));
		expect(out).toContain('missing required field "sourceUrl"');
		expect(code).toBe(1);
	});

	// Swapping the audio under a provenance record that still points at the old one
	// is the failure the digest exists to catch.
	it("rejects a digest that does not match the file on disk", () => {
		const { code, out } = run(fixture({ tracks: [track({ sha256: "0".repeat(64) })] }));
		expect(out).toContain("sha256 does not match");
		expect(code).toBe(1);
	});

	// An audio file with no manifest entry would ship with no licence record at all.
	it("rejects a stray audio file with no manifest entry", () => {
		const { code, out } = run(fixture({ extraFiles: { "orphan.ogg": AUDIO } }));
		expect(out).toContain("stray file");
		expect(code).toBe(1);
	});

	// THIRD-PARTY-NOTICES.md is the only provenance document that reaches the user:
	// electron-builder's `"!*.md"` filter strips every README from the package.
	it("rejects a track missing from THIRD-PARTY-NOTICES.md", () => {
		const { code, out } = run(fixture({ notices: "nothing about the catalogue here" }));
		expect(out).toContain("no entry in THIRD-PARTY-NOTICES.md");
		expect(code).toBe(1);
	});
});
