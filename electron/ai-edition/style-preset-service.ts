// StylePresetService — main-process owner of the user's style presets.
// One `<name>.openscreenpreset` JSON per preset, in a folder the user can see (Documents/
// OpenScreen Presets in production), so presets can be shared by copying files. The folder
// is read on every `list`, which is what makes a file dropped into it show up.
//
// The directory is injected, like DocumentService's, so this module stays free of any
// `electron` import. Format and validation live in src/lib/ai-edition/stylePresets.ts.

import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
	compareStylePresets,
	FACTORY_STYLE_PRESET_ID,
	parseStylePresetFile,
	STYLE_PRESET_FILE_EXTENSION,
	type StylePreset,
	type StylePresetAppearance,
	sanitizeStylePresetName,
	serializeStylePresetFile,
	stylePresetFileBaseName,
} from "../../src/lib/ai-edition/stylePresets";

export type StylePresetErrorCode = "NAME_TAKEN" | "NOT_FOUND" | "INVALID_ID";

export class StylePresetError extends Error {
	constructor(
		public readonly code: StylePresetErrorCode,
		message: string,
	) {
		super(message);
		this.name = "StylePresetError";
	}
}

export interface StylePresetRevealTarget {
	/** `file` when the preset exists; otherwise the (created) presets folder. */
	kind: "file" | "folder";
	path: string;
}

/**
 * Local copy of document-service's `renameWithRetry`: Windows fails a rename onto a file an
 * indexer, antivirus or backup agent holds open for a few milliseconds. Copied rather than
 * imported because importing document-service drags the whole project schema along.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
	const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code ?? "";
			if (attempt >= 5 || !RETRYABLE.has(code)) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
		}
	}
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export class StylePresetService {
	private readonly directory: string;
	/**
	 * Every mutation runs through this one chain. Per instance, not per preset: a rename
	 * touches two files and a create has to see every name already taken, so two concurrent
	 * mutations of DIFFERENT presets can still collide. There is one shared instance in the
	 * main process for the same reason DocumentService has one.
	 */
	private writeTail: Promise<void> = Promise.resolve();

	constructor(directory: string) {
		this.directory = path.resolve(directory);
	}

	get directoryPath(): string {
		return this.directory;
	}

	async ensureDirectory(): Promise<void> {
		await fs.mkdir(this.directory, { recursive: true });
	}

	/**
	 * The file behind a preset id. The id arrives from the renderer, so it has to be a plain
	 * base name — no separators, no `.`/`..`, no control characters, no `:` (a drive or an
	 * NTFS stream on Windows) — and the path it resolves to must still be in the folder.
	 */
	pathFor(id: string): string {
		if (
			typeof id !== "string" ||
			id === "" ||
			id === "." ||
			id === ".." ||
			/[/\\:\p{Cc}]/u.test(id)
		) {
			throw new StylePresetError("INVALID_ID", `Invalid style preset id: ${String(id)}`);
		}
		const filePath = path.resolve(this.directory, `${id}${STYLE_PRESET_FILE_EXTENSION}`);
		if (path.dirname(filePath) !== this.directory) {
			throw new StylePresetError("INVALID_ID", `Invalid style preset id: ${id}`);
		}
		return filePath;
	}

	async list(): Promise<StylePreset[]> {
		await this.ensureDirectory();
		return (await this.readEntries()).presets;
	}

	create(name: string, appearance: StylePresetAppearance): Promise<StylePreset> {
		return this.serialise(async () => {
			const cleanName = sanitizeStylePresetName(name);
			// Validates before anything touches the disk.
			const json = serializeStylePresetFile({ name: cleanName, appearance });
			const id = stylePresetFileBaseName(cleanName);
			this.assertNotFactoryId(id, cleanName);
			await this.ensureDirectory();
			this.assertNameFree(await this.readEntries(), id, cleanName);
			await this.writeAtomic(this.pathFor(id), json);
			return this.read(id);
		});
	}

	rename(id: string, name: string): Promise<StylePreset> {
		return this.serialise(async () => {
			const current = await this.read(id);
			const cleanName = sanitizeStylePresetName(name);
			const nextId = stylePresetFileBaseName(cleanName);
			this.assertNotFactoryId(nextId, cleanName);
			this.assertNameFree(await this.readEntries(), nextId, cleanName, id);
			const json = serializeStylePresetFile({ name: cleanName, appearance: current.appearance });
			const from = this.pathFor(id);
			const to = this.pathFor(nextId);
			if (nextId === id) {
				await this.writeAtomic(from, json);
			} else if (nextId.toLowerCase() === id.toLowerCase()) {
				// A case-only rename. On a case-insensitive disk (macOS, Windows by default) both
				// names are the SAME file, so "write the new one, delete the old one" would delete
				// the preset. Rewrite in place, then let rename change the case.
				await this.writeAtomic(from, json);
				await renameWithRetry(from, to);
			} else {
				await this.writeAtomic(to, json);
				try {
					await fs.unlink(from);
				} catch (error) {
					if (!isMissing(error)) await fs.unlink(to).catch(() => undefined);
					if (!isMissing(error)) throw error;
				}
			}
			return this.read(nextId);
		});
	}

	update(id: string, appearance: StylePresetAppearance): Promise<StylePreset> {
		return this.serialise(async () => {
			const current = await this.read(id);
			await this.writeAtomic(
				this.pathFor(id),
				serializeStylePresetFile({ name: current.name, appearance }),
			);
			return this.read(id);
		});
	}

	delete(id: string): Promise<void> {
		return this.serialise(async () => {
			await fs.unlink(this.pathFor(id)).catch((error) => {
				if (!isMissing(error)) throw error;
			});
		});
	}

	/** What "Show in folder" should open. A preset deleted behind the list's back still
	 *  opens its folder rather than nothing — `showItemInFolder` is silent on a missing file. */
	async revealTarget(id: string): Promise<StylePresetRevealTarget> {
		const filePath = this.pathFor(id);
		try {
			await fs.access(filePath);
			return { kind: "file", path: filePath };
		} catch {
			await this.ensureDirectory();
			return { kind: "folder", path: this.directory };
		}
	}

	private async read(id: string): Promise<StylePreset> {
		const filePath = this.pathFor(id);
		let raw: string;
		let mtime: Date;
		try {
			[raw, { mtime }] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
		} catch (error) {
			if (isMissing(error)) {
				throw new StylePresetError("NOT_FOUND", `Style preset not found: ${id}`);
			}
			throw error;
		}
		const file = parseStylePresetFile(JSON.parse(raw));
		return { id, name: file.name, updatedAt: mtime.toISOString(), appearance: file.appearance };
	}

	/** Every preset file's id (valid or not — it still occupies its name on disk) and every
	 *  preset that parsed. A file that does not is skipped with a warning, never fatal. */
	private async readEntries(): Promise<{ ids: string[]; presets: StylePreset[] }> {
		let names: string[];
		try {
			names = await fs.readdir(this.directory);
		} catch (error) {
			if (isMissing(error)) return { ids: [], presets: [] };
			throw error;
		}
		const ids: string[] = [];
		const presets: StylePreset[] = [];
		for (const name of names) {
			// The temp files of an interrupted write end in `.tmp-…`, so they never match.
			if (!name.endsWith(STYLE_PRESET_FILE_EXTENSION)) continue;
			const id = name.slice(0, -STYLE_PRESET_FILE_EXTENSION.length);
			ids.push(id);
			try {
				presets.push(await this.read(id));
			} catch (error) {
				console.warn(`[style-presets] skipping ${name}:`, error);
			}
		}
		presets.sort(compareStylePresets);
		return { ids, presets };
	}

	/** Taken when the file name is (ignoring case, as macOS and Windows do), or when another
	 *  preset already carries the name — a shared file may sit under a different file name. */
	private assertNameFree(
		entries: { ids: string[]; presets: StylePreset[] },
		id: string,
		name: string,
		exceptId?: string,
	): void {
		const idKey = id.toLowerCase();
		const nameKey = name.toLowerCase();
		const taken =
			entries.ids.some((other) => other !== exceptId && other.toLowerCase() === idKey) ||
			entries.presets.some(
				(preset) => preset.id !== exceptId && preset.name.toLowerCase() === nameKey,
			);
		if (taken) {
			throw new StylePresetError("NAME_TAKEN", `A style preset named "${name}" already exists.`);
		}
	}

	private assertNotFactoryId(id: string, name: string): void {
		if (id.toLowerCase() === FACTORY_STYLE_PRESET_ID) {
			throw new StylePresetError("NAME_TAKEN", `A style preset named "${name}" already exists.`);
		}
	}

	private serialise<T>(work: () => Promise<T>): Promise<T> {
		// Chained on both settlements: one failed mutation must not cancel the next.
		const run = this.writeTail.then(work, work);
		this.writeTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Temp file + flush + rename, as DocumentService writes projects: a crash or a full disk
	 *  mid-write leaves the previous preset intact rather than a truncated one. */
	private async writeAtomic(filePath: string, contents: string): Promise<void> {
		const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
		let handle: FileHandle | undefined;
		try {
			handle = await fs.open(tempPath, "w");
			await handle.writeFile(contents, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await renameWithRetry(tempPath, filePath);
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await fs.unlink(tempPath).catch(() => undefined);
			throw error;
		}
	}
}
