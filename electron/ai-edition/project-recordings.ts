import fs from "node:fs/promises";
import path from "node:path";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";

const RECORDING_STEM = /^recording-\d+/;

/** One take: the screen video and every file recorded beside it (cursor, session, camera). */
export interface RecordingSet {
	dir: string;
	stem: string;
	files: string[];
	sizeBytes: number;
	/** The oldest modification time among its files, in ms. */
	recordedAt: number;
}

export interface ProjectRecordings {
	owned: RecordingSet[];
	/** Titles of the other projects that use some of this project's recordings. */
	keptFor: string[];
	/**
	 * Project files that did not parse. Any of them may use these recordings, so while there
	 * are some the project owns none: its recordings are all kept.
	 */
	unreadable: number;
}

export type RecordingsDisposal = "keep" | "trash" | "permanent";

function documentMediaPaths(doc: AxcutDocument): string[] {
	return doc.assets.flatMap((asset) =>
		[asset.originalPath, asset.proxyPath, asset.waveformPath, asset.cameraTrack?.sourcePath].filter(
			(p): p is string => typeof p === "string" && p.length > 0,
		),
	);
}

// `path.relative` compares case-insensitively on Windows, which a string compare would not.
function sameDir(a: string, b: string): boolean {
	return path.relative(path.resolve(a), path.resolve(b)) === "";
}

function recordingKey(filePath: string, recordingsDirs: readonly string[]): string | null {
	const dir = path.dirname(path.resolve(filePath));
	const managedDir = recordingsDirs.find((candidate) => sameDir(candidate, dir));
	if (!managedDir) return null;
	const stem = RECORDING_STEM.exec(path.basename(filePath))?.[0];
	return stem ? path.join(path.resolve(managedDir), stem) : null;
}

function documentRecordingKeys(doc: AxcutDocument, recordingsDirs: readonly string[]): Set<string> {
	const keys = new Set<string>();
	for (const mediaPath of documentMediaPaths(doc)) {
		const key = recordingKey(mediaPath, recordingsDirs);
		if (key) keys.add(key);
	}
	return keys;
}

async function readRecordingSet(key: string): Promise<RecordingSet | null> {
	const dir = path.dirname(key);
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return null;
	}
	return collectRecordingSet(dir, path.basename(key), names);
}

async function collectRecordingSet(
	dir: string,
	stem: string,
	names: readonly string[],
): Promise<RecordingSet | null> {
	const files: string[] = [];
	let sizeBytes = 0;
	let recordedAt = Number.POSITIVE_INFINITY;
	for (const name of names) {
		// `recording-12` must not pick up `recording-123`.
		if (name !== stem && !name.startsWith(`${stem}.`) && !name.startsWith(`${stem}-`)) continue;
		const filePath = path.join(dir, name);
		try {
			const stat = await fs.stat(filePath);
			if (!stat.isFile()) continue;
			files.push(filePath);
			sizeBytes += stat.size;
			recordedAt = Math.min(recordedAt, stat.mtimeMs);
		} catch {
			// Gone between the listing and the stat: nothing left to delete.
		}
	}
	return files.length > 0 ? { dir, stem, files, sizeBytes, recordedAt } : null;
}

/**
 * The recordings `projectId` owns: takes in one of OpenScreen's recordings folders that no
 * other project uses. A video imported from anywhere else is never the project's to delete.
 */
export async function findProjectRecordings(
	projectId: string,
	projects: { documents: readonly AxcutDocument[]; unreadable: readonly string[] },
	recordingsDirs: readonly string[],
): Promise<ProjectRecordings> {
	const { documents } = projects;
	const target = documents.find((doc) => doc.project.id === projectId);
	if (!target) return { owned: [], keptFor: [], unreadable: 0 };

	const keys = documentRecordingKeys(target, recordingsDirs);
	if (keys.size > 0 && projects.unreadable.length > 0) {
		return { owned: [], keptFor: [], unreadable: projects.unreadable.length };
	}
	const keptFor = new Set<string>();
	for (const doc of documents) {
		if (doc.project.id === projectId) continue;
		const otherKeys = documentRecordingKeys(doc, recordingsDirs);
		for (const key of keys) {
			if (otherKeys.has(key)) {
				keys.delete(key);
				keptFor.add(doc.project.title);
			}
		}
	}

	const owned: RecordingSet[] = [];
	for (const key of keys) {
		const set = await readRecordingSet(key);
		if (set) owned.push(set);
	}
	return { owned, keptFor: [...keptFor], unreadable: 0 };
}

/** Throws on the first file that cannot be removed, so a failed trash can be retried permanently. */
export async function removeRecordingSets(
	sets: readonly RecordingSet[],
	disposal: Exclude<RecordingsDisposal, "keep">,
	trashItem: (filePath: string) => Promise<void>,
): Promise<void> {
	for (const set of sets) {
		for (const filePath of set.files) {
			if (disposal === "trash") {
				await trashItem(filePath);
			} else {
				await fs.rm(filePath, { force: true });
			}
		}
	}
}

/** A take in the recordings folders, and the projects that use it. */
export interface RecordingTake extends RecordingSet {
	/** `dir` joined with `stem`: what a delete names the take by. */
	id: string;
	usedBy: string[];
}

export interface RecordingsListing {
	takes: RecordingTake[];
	/** Project files that did not parse: any take may be in use by one of them. */
	unreadable: number;
}

function uniqueDirs(recordingsDirs: readonly string[]): string[] {
	const dirs: string[] = [];
	for (const dir of recordingsDirs) {
		if (!dirs.some((seen) => sameDir(seen, dir))) dirs.push(path.resolve(dir));
	}
	return dirs;
}

/** Every take in OpenScreen's recordings folders, newest first. */
export async function listRecordings(
	projects: { documents: readonly AxcutDocument[]; unreadable: readonly string[] },
	recordingsDirs: readonly string[],
): Promise<RecordingsListing> {
	const usedBy = new Map<string, string[]>();
	for (const doc of projects.documents) {
		for (const key of documentRecordingKeys(doc, recordingsDirs)) {
			usedBy.set(key, [...(usedBy.get(key) ?? []), doc.project.title]);
		}
	}

	const takes: RecordingTake[] = [];
	for (const dir of uniqueDirs(recordingsDirs)) {
		let names: string[];
		try {
			names = await fs.readdir(dir);
		} catch {
			// A folder that is gone (an unplugged drive) has nothing to list.
			continue;
		}
		const stems = new Set(
			names.map((name) => RECORDING_STEM.exec(name)?.[0]).filter((s): s is string => !!s),
		);
		for (const stem of stems) {
			const set = await collectRecordingSet(dir, stem, names);
			if (!set) continue;
			const id = path.join(dir, stem);
			takes.push({ ...set, id, usedBy: usedBy.get(id) ?? [] });
		}
	}
	takes.sort((a, b) => b.recordedAt - a.recordedAt);
	return { takes, unreadable: projects.unreadable.length };
}

/**
 * The takes `ids` name, each checked to be a take in a recordings folder: the ids come from
 * the renderer, and a delete must never reach a file outside those folders.
 */
export async function resolveRecordingIds(
	ids: readonly string[],
	recordingsDirs: readonly string[],
): Promise<RecordingSet[]> {
	const sets: RecordingSet[] = [];
	for (const id of ids) {
		const stem = path.basename(id);
		if (RECORDING_STEM.exec(stem)?.[0] !== stem) throw new Error(`Not a recording: ${id}`);
		if (recordingKey(id, recordingsDirs) === null) throw new Error(`Not a recording: ${id}`);
		const set = await readRecordingSet(path.resolve(id));
		if (set) sets.push(set);
	}
	return sets;
}
