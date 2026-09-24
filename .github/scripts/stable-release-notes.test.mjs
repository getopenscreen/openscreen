import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Asserted against the workflow text, the way scripts/ffmpeg-linked-libraries.test.mjs already
// checks workflow facts: there is no unit to import here, the behaviour IS the `gh` invocation,
// and the only other way to learn this is to cut a release and read the result.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const buildWorkflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/build.yml"), "utf8");

/** The RC and stable paths are the two arms of one `if [[ -n "$PRERELEASE_FLAG" ]]`, so slicing
 *  on the `else` keeps a change to one arm from silently satisfying an assertion about the
 *  other — which is the whole failure this file exists to catch. */
function releaseNotesArms() {
	const start = buildWorkflow.indexOf('if [[ -n "$PRERELEASE_FLAG" ]]; then');
	const create = buildWorkflow.indexOf('gh release create "$TAG"', start);
	expect(start).toBeGreaterThan(-1);
	expect(create).toBeGreaterThan(start);
	const block = buildWorkflow.slice(start, create);
	const split = block.indexOf("\n            else\n");
	expect(split).toBeGreaterThan(-1);
	// The invocation comes back too: everything the arms decide is dead weight if the command
	// stops expanding it, and that deletion would leave every assertion about NOTES_ARGS green.
	// Ends at the `fi` that closes the prerelease branch, at its own indentation.
	const end = buildWorkflow.indexOf("          fi", create);
	expect(end).toBeGreaterThan(create);
	const invocation = buildWorkflow.slice(create, end);
	return { rc: block.slice(0, split), stable: block.slice(split), invocation };
}

describe("stable release notes", () => {
	it("prepends the star line to every stable release", () => {
		const { stable } = releaseNotesArms();
		expect(stable).toContain(
			'STAR_LINE="If OpenScreen saves you time, a star on the repo helps others find it."',
		);
		// Both branches of the notes-start-tag choice, not just the one that happens to come
		// first: a release cut with no previous tag is exactly when nobody is watching.
		for (const args of stable.match(/NOTES_ARGS=\([^)]*\)/g) ?? []) {
			expect(args).toContain("--generate-notes");
			expect(args).toContain('--notes "$STAR_LINE"');
		}
		expect(stable.match(/NOTES_ARGS=\([^)]*\)/g)).toHaveLength(2);
	});

	it("leaves release candidates alone", () => {
		const { rc } = releaseNotesArms();
		// An RC body is built from git log into a file. A --notes there would not prepend, it
		// would be a second, conflicting source for the same body.
		expect(rc).not.toContain("STAR_LINE");
		// Asserted on the arguments, never on the arm's text: the RC branch carries a comment
		// that says "not --generate-notes", and a substring check happily matches the prose.
		const args = rc.match(/NOTES_ARGS=\([^)]*\)/g) ?? [];
		expect(args).toHaveLength(1);
		expect(args[0]).toContain("--notes-file");
		expect(args[0]).not.toContain("--generate-notes");
		expect(args[0]).not.toContain("--notes ");
	});

	it("passes the chosen arguments to gh", () => {
		// Without this, deleting "${NOTES_ARGS[@]}" from the command would publish every release
		// with neither the star line nor the generated notes, and every other test in this file
		// would still pass: they only ever look at how the array is built.
		const { invocation } = releaseNotesArms();
		expect(invocation).toContain('"${NOTES_ARGS[@]}"');
	});

	it("keeps the generated notes rather than replacing them", () => {
		// `--notes` alongside `--generate-notes` is documented as a PREPEND, so the PR links and
		// the New Contributors section survive. Drop `--generate-notes` and the star line becomes
		// the entire release body — a silent, total loss of the notes nobody would notice until
		// after the release is public.
		const { stable } = releaseNotesArms();
		expect(stable).not.toMatch(/NOTES_ARGS=\((?![^)]*--generate-notes)[^)]*\)/);
	});
});
