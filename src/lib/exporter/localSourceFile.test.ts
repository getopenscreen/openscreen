import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeLocalSourceFile, releaseLocalSourceFile } from "./localSourceFile";

function stubElectronAPI(api: Record<string, unknown>) {
	vi.stubGlobal("window", { ...globalThis.window, electronAPI: api } as unknown);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("materializeLocalSourceFile (small file path)", () => {
	it("reads a small file in one shot and returns a File with its bytes", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		stubElectronAPI({
			getReadableFileInfo: vi.fn().mockResolvedValue({
				success: true,
				size: bytes.byteLength,
				mtimeMs: 1,
				path: "/tmp/small.mp4",
			}),
			readBinaryFile: vi.fn().mockResolvedValue({
				success: true,
				data: bytes.buffer,
				path: "/tmp/small.mp4",
			}),
		});

		const file = await materializeLocalSourceFile("/tmp/small.mp4", "small.mp4");

		expect(file).toBeInstanceOf(File);
		expect(file.size).toBe(bytes.byteLength);
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
	});

	it("does not stream a small file through readFileChunk", async () => {
		const readFileChunk = vi.fn();
		stubElectronAPI({
			getReadableFileInfo: vi
				.fn()
				.mockResolvedValue({ success: true, size: 10, mtimeMs: 1, path: "/tmp/s.mp4" }),
			readBinaryFile: vi
				.fn()
				.mockResolvedValue({ success: true, data: new Uint8Array(10).buffer, path: "/tmp/s.mp4" }),
			readFileChunk,
		});

		await materializeLocalSourceFile("/tmp/s.mp4", "s.mp4");

		expect(readFileChunk).not.toHaveBeenCalled();
	});

	it("throws when the file cannot be stat-ed", async () => {
		stubElectronAPI({
			getReadableFileInfo: vi
				.fn()
				.mockResolvedValue({ success: false, message: "File path is not approved" }),
			readBinaryFile: vi.fn(),
		});

		await expect(materializeLocalSourceFile("/tmp/missing.mp4", "x.mp4")).rejects.toThrow(
			/not approved/,
		);
	});

	it("throws when the single-shot read fails", async () => {
		stubElectronAPI({
			getReadableFileInfo: vi
				.fn()
				.mockResolvedValue({ success: true, size: 10, mtimeMs: 1, path: "/tmp/s.mp4" }),
			readBinaryFile: vi
				.fn()
				.mockResolvedValue({ success: false, message: "Failed to read binary file" }),
		});

		await expect(materializeLocalSourceFile("/tmp/s.mp4", "s.mp4")).rejects.toThrow(
			/Failed to read binary file/,
		);
	});
});

// ---- Minimal in-memory OPFS fake for the large-file streaming path ----

class FakeWritable {
	private parts: Uint8Array[] = [];
	constructor(private readonly onClose: (bytes: Uint8Array) => void) {}
	async write(data: ArrayBuffer | Uint8Array) {
		this.parts.push(data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data));
	}
	async close() {
		const total = this.parts.reduce((n, p) => n + p.byteLength, 0);
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const p of this.parts) {
			merged.set(p, offset);
			offset += p.byteLength;
		}
		this.onClose(merged);
	}
	async abort() {
		this.parts = [];
	}
}

class FakeFileHandle {
	bytes = new Uint8Array(0);
	constructor(readonly name: string) {}
	async getFile() {
		return new File([this.bytes], this.name);
	}
	async createWritable() {
		return new FakeWritable((b) => {
			this.bytes = b;
		});
	}
}

class FakeDir {
	files = new Map<string, FakeFileHandle>();
	subdirs = new Map<string, FakeDir>();
	async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
		let dir = this.subdirs.get(name);
		if (!dir && opts?.create) {
			dir = new FakeDir();
			this.subdirs.set(name, dir);
		}
		if (!dir) throw new DOMException("NotFound", "NotFoundError");
		return dir as unknown as FileSystemDirectoryHandle;
	}
	async getFileHandle(name: string, opts?: { create?: boolean }) {
		let file = this.files.get(name);
		if (!file && opts?.create) {
			file = new FakeFileHandle(name);
			this.files.set(name, file);
		}
		if (!file) throw new DOMException("NotFound", "NotFoundError");
		return file as unknown as FileSystemFileHandle;
	}
	async *keys() {
		yield* this.files.keys();
	}
	async removeEntry(name: string) {
		this.files.delete(name);
	}
}

function stubOpfs(root: FakeDir) {
	vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } } as unknown);
}

function cacheDir(root: FakeDir): FakeDir | undefined {
	return root.subdirs.get("openscreen-source-cache");
}

/** electronAPI whose readFileChunk serves slices of `source`. */
function largeSourceApi(url: string, source: Uint8Array, mtimeMs = 1) {
	return {
		getReadableFileInfo: vi
			.fn()
			.mockResolvedValue({ success: true, size: source.byteLength, mtimeMs, path: url }),
		readBinaryFile: vi.fn(),
		readFileChunk: vi.fn(async (_url: string, offset: number, length: number) => ({
			success: true,
			data: source.slice(offset, offset + length).buffer,
			bytesRead: Math.min(length, source.byteLength - offset),
		})),
	};
}

describe("materializeLocalSourceFile (large file OPFS path)", () => {
	const OPTS = { thresholdBytes: 4, chunkBytes: 3 };

	it("streams a large file into OPFS in chunks and returns the exact bytes", async () => {
		const source = new Uint8Array([10, 20, 30, 40, 50, 60, 70]);
		const api = largeSourceApi("/rec/a.mp4", source);
		stubElectronAPI(api);
		stubOpfs(new FakeDir());

		const file = await materializeLocalSourceFile("/rec/a.mp4", "a.mp4", OPTS);

		expect(file.size).toBe(source.byteLength);
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(source);
		// 7 bytes / 3-byte chunks => 3 reads.
		expect(api.readFileChunk).toHaveBeenCalledTimes(3);
		expect(api.readBinaryFile).not.toHaveBeenCalled();

		releaseLocalSourceFile("/rec/a.mp4");
	});

	it("reuses the cached copy on a second call without re-streaming", async () => {
		const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
		const api = largeSourceApi("/rec/b.mp4", source);
		stubElectronAPI(api);
		stubOpfs(new FakeDir());

		await materializeLocalSourceFile("/rec/b.mp4", "b.mp4", OPTS);
		const firstReads = api.readFileChunk.mock.calls.length;
		await materializeLocalSourceFile("/rec/b.mp4", "b.mp4", OPTS);

		expect(api.readFileChunk.mock.calls.length).toBe(firstReads); // no new reads

		releaseLocalSourceFile("/rec/b.mp4");
		releaseLocalSourceFile("/rec/b.mp4");
	});

	it("keeps a cache entry that is still referenced by another active source", async () => {
		const root = new FakeDir();
		stubOpfs(root);

		stubElectronAPI(largeSourceApi("/rec/a.mp4", new Uint8Array([1, 2, 3, 4, 5])));
		await materializeLocalSourceFile("/rec/a.mp4", "a.mp4", OPTS); // A retained

		stubElectronAPI(largeSourceApi("/rec/b.mp4", new Uint8Array([6, 7, 8, 9, 10])));
		await materializeLocalSourceFile("/rec/b.mp4", "b.mp4", OPTS); // prunes, but A is active

		// A must NOT have been pruned while still in use.
		expect(cacheDir(root)?.files.size).toBe(2);

		releaseLocalSourceFile("/rec/a.mp4");
		releaseLocalSourceFile("/rec/b.mp4");
	});

	it("prunes a cache entry once it has been released", async () => {
		const root = new FakeDir();
		stubOpfs(root);

		stubElectronAPI(largeSourceApi("/rec/a.mp4", new Uint8Array([1, 2, 3, 4, 5])));
		await materializeLocalSourceFile("/rec/a.mp4", "a.mp4", OPTS); // A retained

		stubElectronAPI(largeSourceApi("/rec/b.mp4", new Uint8Array([6, 7, 8, 9, 10])));
		await materializeLocalSourceFile("/rec/b.mp4", "b.mp4", OPTS); // B retained

		releaseLocalSourceFile("/rec/a.mp4"); // A no longer in use

		stubElectronAPI(largeSourceApi("/rec/c.mp4", new Uint8Array([11, 12, 13, 14, 15])));
		await materializeLocalSourceFile("/rec/c.mp4", "c.mp4", OPTS); // prunes A, keeps B, adds C

		// A pruned; B (still active) and C remain.
		expect(cacheDir(root)?.files.size).toBe(2);

		releaseLocalSourceFile("/rec/b.mp4");
		releaseLocalSourceFile("/rec/c.mp4");
	});
});
