#!/usr/bin/env node
/**
 * Licence guard for the bundled music catalogue.
 *
 * Every track OpenScreen ships inside its installers is redistributed BY US, so each
 * one has to carry the proof that we may. CC0 asks nothing in return, but "the licence
 * asked for nothing" is only a defence if we can still show, years later, where the
 * dedication was made and what it covered. The manifest is that evidence, and this
 * script is what keeps the manifest honest.
 *
 * It is the audio counterpart of the `assertLgpl` guard in `scripts/fetch-ffmpeg.mjs`:
 * a build that cannot prove its licensing does not ship.
 *
 * Why the checks are what they are:
 *  - The licence allow-list is CC0 only, deliberately. A permissive-looking "free for
 *    commercial use" licence (Pixabay, Mixkit, Bensound, Uppbeat) forbids redistributing
 *    the raw file, which is exactly what a music library inside an app does. CC-BY is
 *    excluded for a different reason: its obligation would travel to the user's video.
 *  - `licenseSnapshotUrl` is required because a source page can change or disappear.
 *    An archived copy is the only evidence that survives the site it came from.
 *  - The digest is checked against the file on disk so a track can never be swapped
 *    under a provenance record that still points at the old one.
 *
 * Usage:
 *   node scripts/check-music-licences.mjs
 *   node scripts/check-music-licences.mjs --update-digests   # after adding/replacing a file
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MUSIC_DIR = path.resolve("public/music");
const MANIFEST = path.join(MUSIC_DIR, "catalogue.json");
const NOTICES = path.resolve("THIRD-PARTY-NOTICES.md");

/** Only licences that impose NOTHING on the user's exported video. */
const ALLOWED_LICENCES = new Map([
	["CC0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/"],
]);
const AUDIO_EXTENSIONS = new Set([".opus", ".ogg", ".mp3", ".m4a", ".flac", ".wav"]);
// Matched EXACTLY. A suffix match let any host ending in these names through
// (`notweb.archive.org`, `fakearchive.ph`), and a snapshot anyone can register a domain
// for is no evidence at all. No catalogue entry needs a subdomain.
const ARCHIVE_HOSTS = new Set(["web.archive.org", "archive.ph", "archive.today"]);
const REQUIRED_FIELDS = [
	"id",
	"title",
	"author",
	"file",
	"sha256",
	"bytes",
	"durationSec",
	"mood",
	"license",
	"licenseUrl",
	"sourceUrl",
	"licenseSnapshotUrl",
	"capturedAt",
];

const updateDigests = process.argv.includes("--update-digests");
const errors = [];
const fail = (msg) => errors.push(msg);

function sha256(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function isHttpsUrl(value) {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

if (!fs.existsSync(MANIFEST)) {
	console.error(`MISSING: ${path.relative(process.cwd(), MANIFEST)} does not exist.`);
	process.exit(1);
}

let manifest;
try {
	manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));
} catch (err) {
	console.error(
		`INVALID: ${path.relative(process.cwd(), MANIFEST)} is not valid JSON — ${err.message}`,
	);
	process.exit(1);
}

const tracks = Array.isArray(manifest?.tracks) ? manifest.tracks : null;
if (!tracks) {
	console.error(`INVALID: the manifest must be an object with a "tracks" array.`);
	process.exit(1);
}

const notices = fs.existsSync(NOTICES) ? fs.readFileSync(NOTICES, "utf-8") : "";
if (!notices) fail(`MISSING: ${path.relative(process.cwd(), NOTICES)} does not exist.`);

const seenIds = new Set();
const seenFiles = new Set();
let digestsWritten = 0;

for (const [index, track] of tracks.entries()) {
	const where = track?.id ? `track "${track.id}"` : `track #${index + 1}`;

	for (const field of REQUIRED_FIELDS) {
		const value = track?.[field];
		const empty =
			value === undefined ||
			value === null ||
			value === "" ||
			(Array.isArray(value) && value.length === 0);
		if (empty) fail(`${where}: missing required field "${field}".`);
	}
	if (typeof track?.id !== "string") continue;

	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(track.id)) {
		fail(`${where}: id must be kebab-case.`);
	}
	if (seenIds.has(track.id)) fail(`${where}: duplicate id.`);
	seenIds.add(track.id);

	// Licence: the allow-list AND the canonical deed URL, so an entry cannot claim CC0
	// while linking somewhere else.
	const deed = ALLOWED_LICENCES.get(track.license);
	if (!deed) {
		fail(
			`${where}: license "${track.license}" is not allowed. Only ${[...ALLOWED_LICENCES.keys()].join(", ")} may be bundled.`,
		);
	} else if (track.licenseUrl !== deed) {
		fail(`${where}: licenseUrl must be exactly ${deed}.`);
	}

	if (!isHttpsUrl(track.sourceUrl)) fail(`${where}: sourceUrl must be an https URL.`);
	if (!isHttpsUrl(track.licenseSnapshotUrl)) {
		fail(`${where}: licenseSnapshotUrl must be an https URL.`);
	} else if (!ARCHIVE_HOSTS.has(new URL(track.licenseSnapshotUrl).hostname)) {
		fail(
			`${where}: licenseSnapshotUrl must point at a web archive (${[...ARCHIVE_HOSTS].join(", ")}).`,
		);
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(track.capturedAt ?? "")) {
		fail(`${where}: capturedAt must be an ISO date (YYYY-MM-DD).`);
	}

	if (typeof track.file !== "string") continue;
	if (path.basename(track.file) !== track.file) {
		fail(`${where}: file must be a bare filename, not a path.`);
	}
	if (!AUDIO_EXTENSIONS.has(path.extname(track.file).toLowerCase())) {
		fail(`${where}: file extension ${path.extname(track.file)} is not a supported audio format.`);
	}
	seenFiles.add(track.file);

	const audioPath = path.join(MUSIC_DIR, track.file);
	if (!fs.existsSync(audioPath)) {
		fail(`${where}: ${track.file} is in the manifest but not on disk.`);
		continue;
	}

	const digest = sha256(audioPath);
	const bytes = fs.statSync(audioPath).size;
	if (updateDigests) {
		if (track.sha256 !== digest || track.bytes !== bytes) digestsWritten += 1;
		track.sha256 = digest;
		track.bytes = bytes;
	} else {
		if (track.sha256 !== digest) {
			fail(`${where}: sha256 does not match ${track.file} (on disk: ${digest}).`);
		}
		if (track.bytes !== bytes) {
			fail(`${where}: bytes is ${track.bytes} but the file is ${bytes}.`);
		}
	}

	// The notices file is the only provenance document that reaches the user: the
	// `"!*.md"` filter in electron-builder.json5 strips every README from the package.
	if (notices && !notices.includes(track.id)) {
		fail(
			`${where}: no entry in THIRD-PARTY-NOTICES.md — the user would receive the file with no provenance.`,
		);
	}
}

// An audio file with no manifest entry would ship with no licence record at all.
const onDisk = fs.existsSync(MUSIC_DIR)
	? fs
			.readdirSync(MUSIC_DIR)
			.filter((name) => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()))
	: [];
for (const name of onDisk) {
	if (!seenFiles.has(name)) fail(`stray file: public/music/${name} has no manifest entry.`);
}

if (updateDigests && errors.length === 0) {
	fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, "\t")}\n`);
	console.log(`Digests updated (${digestsWritten} changed).`);
}

if (errors.length > 0) {
	for (const error of errors) console.error(error);
	console.error(`\nMusic licence check FAILED — ${errors.length} problem(s).`);
	process.exit(1);
}

console.log(
	`Music licence check PASSED — ${tracks.length} track(s), all CC0-1.0 with archived provenance and matching digests.`,
);
