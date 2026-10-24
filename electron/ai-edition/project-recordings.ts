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
	const stem = path.basename(key);
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return null;
	}
	const files: string[] = [];
	let sizeBytes = 0;
	for (const name of names) {
		// `recording-12` must not pick up `recording-123`.
		if (name !== stem && !name.startsWith(`${stem}.`) && !name.startsWith(`${stem}-`)) continue;
		const filePath = path.join(dir, name);
		try {
			const stat = await fs.stat(filePath);
			if (!stat.isFile()) continue;
			files.push(filePath);
			sizeBytes += stat.size;
		} catch {
			// Gone between the listing and the stat: nothing left to delete.
		}
	}
	return files.length > 0 ? { dir, stem, files, sizeBytes } : null;
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
