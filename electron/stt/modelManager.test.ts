import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	areModelsPresent,
	downloadModel,
	ensureModels,
	expectedSha256For,
	modelPaths,
	STT_MODELS,
} from "./modelManager";

describe("modelManager", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "stt-models-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("exposes the whisper model", () => {
		expect(STT_MODELS.whisper.file).toBe("ggml-small-q5_1.bin");
		expect(STT_MODELS.whisper.expectedSha256).not.toBeNull();
		expect(STT_MODELS.whisper.approximateBytes).toBeGreaterThan(0);
	});

	it("modelPaths places the whisper file under its cache directory", () => {
		const paths = modelPaths(dir);
		expect(paths.whisper).toBe(path.join(dir, "whisper", "ggml-small-q5_1.bin"));
	});

	it("expectedSha256For reports the whisper model as pinned", () => {
		expect(expectedSha256For("whisper")).not.toBeNull();
	});

	it("areModelsPresent returns false when nothing has been downloaded", async () => {
		expect(await areModelsPresent(dir)).toBe(false);
	});

	it("areModelsPresent returns true once the whisper file exists", async () => {
		const paths = modelPaths(dir);
		await mkdir(path.dirname(paths.whisper), { recursive: true });
		expect(await areModelsPresent(dir)).toBe(false);
		await writeFile(paths.whisper, "placeholder contents");
		expect(await areModelsPresent(dir)).toBe(true);
	});

	it("downloadModel skips re-download when target file is non-empty", async () => {
		const dest = path.join(dir, "out.bin");
		await mkdir(path.dirname(dest), { recursive: true });
		await writeFile(dest, "already here");
		let fetcherCalled = 0;
		const fetcher: typeof fetch = async () => {
			fetcherCalled++;
			return new Response("should not be read", { status: 200 });
		};
		let progressCalls = 0;
		await downloadModel(STT_MODELS.whisper, dest, {
			fetcher,
			onProgress: () => progressCalls++,
		});
		expect(fetcherCalled).toBe(0);
		expect(progressCalls).toBeGreaterThan(0);
		const s = await stat(dest);
		expect(s.size).toBe("already here".length);
	});

	it("downloadModel streams to disk via fetch and reports progress", async () => {
		const dest = path.join(dir, "streamed.bin");
		const body = Readable.from(["hello", " ", "world"]);
		const fakeResponse = new Response(body as unknown as BodyInit, { status: 200 });
		const fetcher: typeof fetch = async () => fakeResponse;
		const bytes: number[] = [];
		// expectedSha256: null — this test is about streaming/progress mechanics,
		// not hash verification, and the fake payload won't match the real model's hash.
		await downloadModel({ ...STT_MODELS.whisper, expectedSha256: null }, dest, {
			fetcher,
			onProgress: (b) => bytes.push(b),
		});
		const s = await stat(dest);
		expect(s.size).toBe("hello world".length);
		// Cumulative progress: must end at total file size.
		expect(bytes.at(-1)).toBe("hello world".length);
		// Strictly non-decreasing — the spec assumes monotonic bytes.
		for (let i = 1; i < bytes.length; i++) {
			expect(bytes[i]).toBeGreaterThanOrEqual(bytes[i - 1] ?? 0);
		}
	});

	it("ensureModels only invokes ensure per model and reuses existing files", async () => {
		const paths = modelPaths(dir);
		await mkdir(path.dirname(paths.whisper), { recursive: true });
		await writeFile(paths.whisper, "already");
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			return new Response(Readable.from(["x"]) as unknown as BodyInit, { status: 200 });
		};
		await ensureModels({
			baseDir: dir,
			only: ["whisper"],
			fetcher,
			onProgress: () => undefined,
		});
		// Whisper cache hit: no fetch fires for it.
		expect(fetches).toBe(0);
	});

	it("downloadModel surfaces 4xx errors immediately instead of retrying", async () => {
		const dest = path.join(dir, "locked.bin");
		await mkdir(path.dirname(dest), { recursive: true });
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			// 401 — auth-gated; retrying won't help. Spec behavior: fail fast.
			return new Response("auth required", { status: 401, statusText: "Unauthorized" });
		};
		await expect(downloadModel(STT_MODELS.whisper, dest, { fetcher })).rejects.toThrow(
			/HTTP 401 Unauthorized/,
		);
		expect(fetches).toBe(1); // single attempt, no 60s backoff loop
	});

	it("downloadModel retries transient 5xx + network errors with bounded backoff", async () => {
		const dest = path.join(dir, "flaky.bin");
		await mkdir(path.dirname(dest), { recursive: true });
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			if (fetches < 2)
				return new Response("busy", { status: 503, statusText: "Service Unavailable" });
			return new Response(Readable.from(["payload"]) as unknown as BodyInit, { status: 200 });
		};
		// expectedSha256: null — this test is about retry/backoff mechanics,
		// not hash verification, and the fake payload won't match the real model's hash.
		await downloadModel({ ...STT_MODELS.whisper, expectedSha256: null }, dest, { fetcher });
		expect(fetches).toBe(2); // one retry, then success
	});
});
