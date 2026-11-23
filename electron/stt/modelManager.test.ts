import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	alignerPath,
	areModelsPresent,
	CTC_ALIGNERS,
	cachedAligner,
	ensureAligner,
	ensureModels,
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

	it("exposes the whisper model descriptor with a single GGML file", () => {
		expect(STT_MODELS.whisper.cacheDir).toBe("whisper-ggml");
		expect(STT_MODELS.whisper.repoId).toBe("ggerganov/whisper.cpp");
		expect(STT_MODELS.whisper.files.length).toBe(1);
		expect(STT_MODELS.whisper.files[0].name).toBe("ggml-small-q8_0.bin");
		expect(STT_MODELS.whisper.files[0].expectedSha256).not.toBeNull();
		for (const f of STT_MODELS.whisper.files) {
			expect(f.approximateBytes).toBeGreaterThan(0);
			expect(f.url).toContain("huggingface.co");
			// Pinned to an immutable commit: resolving through `main` would let a
			// re-upload invalidate every cached model in the field at once.
			expect(f.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
		}
	});

	it("exposes the silero-vad model descriptor with a single GGML file", () => {
		expect(STT_MODELS["silero-vad"].cacheDir).toBe("whisper-ggml");
		expect(STT_MODELS["silero-vad"].repoId).toBe("ggml-org/whisper-vad");
		expect(STT_MODELS["silero-vad"].files.length).toBe(1);
		expect(STT_MODELS["silero-vad"].files[0].name).toBe("ggml-silero-v6.2.0.bin");
		expect(STT_MODELS["silero-vad"].files[0].expectedSha256).toBe(
			"2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
		);
		for (const f of STT_MODELS["silero-vad"].files) {
			expect(f.approximateBytes).toBeGreaterThan(0);
			expect(f.url).toContain("huggingface.co");
			expect(f.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
		}
	});

	it("modelPaths places the GGML file under the cache directory", () => {
		const paths = modelPaths(dir);
		expect(paths.whisper).toBe(path.join(dir, "whisper-ggml", "ggml-small-q8_0.bin"));
		expect(paths["silero-vad"]).toBe(path.join(dir, "whisper-ggml", "ggml-silero-v6.2.0.bin"));
	});

	it("areModelsPresent returns false when the model file is missing", async () => {
		expect(await areModelsPresent(dir)).toBe(false);
	});

	it("areModelsPresent returns true once the GGML files are present", async () => {
		const paths = modelPaths(dir);
		await mkdir(path.dirname(paths.whisper), { recursive: true });
		expect(await areModelsPresent(dir)).toBe(false);
		await writeFile(paths.whisper, "dummy-ggml");
		expect(await areModelsPresent(dir, ["whisper"])).toBe(true);
		expect(await areModelsPresent(dir)).toBe(false);
		await writeFile(paths["silero-vad"], "dummy-vad");
		expect(await areModelsPresent(dir)).toBe(true);
	});

	it("ensureModels gives up on a server that never answers instead of waiting forever", async () => {
		// A filtered route that drops packets: no response, no error, ever (#1636).
		const silent: typeof fetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
					once: true,
				});
			});
		const paths = modelPaths(dir);
		await expect(
			ensureModels({ baseDir: dir, only: ["whisper"], fetcher: silent, stallMs: 50 }),
		).rejects.toThrow(/stalled/);
		expect(existsSync(`${paths.whisper}.partial`)).toBe(false);
	});

	it("ensureModels succeeds when the file is already present (cache hit)", async () => {
		const paths = modelPaths(dir);
		await mkdir(path.dirname(paths.whisper), { recursive: true });
		const cached = Buffer.from("dummy-ggml");
		await writeFile(paths.whisper, cached);
		const originalSha = STT_MODELS.whisper.files[0].expectedSha256;
		STT_MODELS.whisper.files[0].expectedSha256 = createHash("sha256").update(cached).digest("hex");
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			return new Response("should not be reached", { status: 200 });
		};
		try {
			await ensureModels({
				baseDir: dir,
				only: ["whisper"],
				fetcher,
				onProgress: () => undefined,
			});
			expect(fetches).toBe(0);
		} finally {
			STT_MODELS.whisper.files[0].expectedSha256 = originalSha;
		}
	});

	it("re-downloads a non-empty cached model when its checksum is wrong", async () => {
		const paths = modelPaths(dir);
		await mkdir(path.dirname(paths.whisper), { recursive: true });
		await writeFile(paths.whisper, "corrupt-cache");
		const replacement = Buffer.from("verified-ggml-weights");
		const originalSha = STT_MODELS.whisper.files[0].expectedSha256;
		STT_MODELS.whisper.files[0].expectedSha256 = createHash("sha256")
			.update(replacement)
			.digest("hex");
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			return new Response(replacement, { status: 200 });
		};

		try {
			await ensureModels({ baseDir: dir, only: ["whisper"], fetcher });
			expect(fetches).toBe(1);
			expect(await readFile(paths.whisper)).toEqual(replacement);
			// The stale copy is displaced by the atomic rename, not quarantined
			// beside it: a `.bad` sibling would strand 264 MB nothing ever reaps.
			expect(existsSync(`${paths.whisper}.bad`)).toBe(false);
			expect(existsSync(`${paths.whisper}.partial`)).toBe(false);
		} finally {
			STT_MODELS.whisper.files[0].expectedSha256 = originalSha;
		}
	});

	it("never lets a mismatching download occupy the live model path", async () => {
		const paths = modelPaths(dir);
		const originalSha = STT_MODELS.whisper.files[0].expectedSha256;
		STT_MODELS.whisper.files[0].expectedSha256 = createHash("sha256")
			.update("the-weights-we-asked-for")
			.digest("hex");
		const served = Buffer.from("truncated-or-tampered-weights");
		const fetcher: typeof fetch = async () => new Response(served, { status: 200 });

		try {
			await expect(ensureModels({ baseDir: dir, only: ["whisper"], fetcher })).rejects.toThrow(
				/SHA-256 mismatch/,
			);
			expect(existsSync(paths.whisper)).toBe(false);
			expect(existsSync(`${paths.whisper}.partial`)).toBe(false);
		} finally {
			STT_MODELS.whisper.files[0].expectedSha256 = originalSha;
		}
	});

	it("keeps the cached model when the replacement download also mismatches", async () => {
		const paths = modelPaths(dir);
		await mkdir(path.dirname(paths.whisper), { recursive: true });
		await writeFile(paths.whisper, "the-only-copy-the-user-has");
		const originalSha = STT_MODELS.whisper.files[0].expectedSha256;
		STT_MODELS.whisper.files[0].expectedSha256 = createHash("sha256")
			.update("the-weights-we-asked-for")
			.digest("hex");
		const fetcher: typeof fetch = async () =>
			new Response(Buffer.from("also-wrong"), { status: 200 });

		try {
			await expect(ensureModels({ baseDir: dir, only: ["whisper"], fetcher })).rejects.toThrow(
				/SHA-256 mismatch/,
			);
			expect(await readFile(paths.whisper, "utf8")).toBe("the-only-copy-the-user-has");
		} finally {
			STT_MODELS.whisper.files[0].expectedSha256 = originalSha;
		}
	});

	it("ensureModels downloads the missing GGML file with progress", async () => {
		const paths = modelPaths(dir);
		const originalSha = STT_MODELS.whisper.files[0].expectedSha256;
		STT_MODELS.whisper.files[0].expectedSha256 = null;

		const progressCalls: Array<{
			id: string;
			file: string;
			bytes: number;
		}> = [];
		let fetches = 0;

		const fetcher: typeof fetch = async (input) => {
			fetches++;
			// ensureModels passes a plain string URL, but a `typeof fetch` stub has to
			// honour the whole signature (string | URL | Request).
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const content = Buffer.from(`content-for-${url.split("/").pop()}`);
			return new Response(content, { status: 200 });
		};

		try {
			await ensureModels({
				baseDir: dir,
				only: ["whisper"],
				fetcher,
				onProgress: (ev) => {
					progressCalls.push({
						id: ev.id,
						file: ev.file,
						bytes: ev.downloadedBytes,
					});
				},
			});

			expect(fetches).toBe(1);
			const s = await stat(paths.whisper);
			expect(s.size).toBeGreaterThan(0);
			expect(progressCalls.length).toBeGreaterThanOrEqual(1);
			expect(progressCalls[0].file).toBe("ggml-small-q8_0.bin");
		} finally {
			STT_MODELS.whisper.files[0].expectedSha256 = originalSha;
		}
	});

	it("ensureModels surfaces 4xx errors immediately instead of retrying", async () => {
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			return new Response("auth required", {
				status: 401,
				statusText: "Unauthorized",
			});
		};

		await expect(
			ensureModels({
				baseDir: dir,
				only: ["whisper"],
				fetcher,
				onProgress: () => undefined,
			}),
		).rejects.toThrow(/HTTP 401/);

		expect(fetches).toBe(1);
	});

	it("ensureModels retries transient 5xx errors with bounded backoff", async () => {
		const originalSha = STT_MODELS.whisper.files[0].expectedSha256;
		STT_MODELS.whisper.files[0].expectedSha256 = null;
		const attempts: number[] = [];
		const fetcher: typeof fetch = async () => {
			attempts.push(attempts.length + 1);
			if (attempts.length <= 1) {
				return new Response("busy", {
					status: 503,
					statusText: "Service Unavailable",
				});
			}
			return new Response(Buffer.from("ggml weights"), { status: 200 });
		};

		try {
			await ensureModels({
				baseDir: dir,
				only: ["whisper"],
				fetcher,
				onProgress: () => undefined,
			});
			expect(attempts).toHaveLength(2);
		} finally {
			STT_MODELS.whisper.files[0].expectedSha256 = originalSha;
		}
	});

	describe("CTC aligners", () => {
		it("pins every aligner to a digest and names its upstream revision", () => {
			for (const file of Object.values(CTC_ALIGNERS)) {
				expect(file.expectedSha256).toMatch(/^[0-9a-f]{64}$/);
				expect(file.source).toMatch(/@[0-9a-f]{40}$/);
				// Hosted under a `v0.0.0-*` release tag, never a moving one.
				expect(file.url).toMatch(/\/releases\/download\/v0\.0\.0-[^/]+\//);
			}
		});

		it("has none for a language it does not cover, prototype keys included", async () => {
			expect(alignerPath(dir, "de")).toBeNull();
			expect(alignerPath(dir, "constructor")).toBeNull();
			expect(await ensureAligner({ baseDir: dir, language: "de" })).toBeNull();
		});

		it("downloads, verifies and returns the aligner of a covered language", async () => {
			const bytes = Buffer.from("gguf weights");
			const original = CTC_ALIGNERS.fr.expectedSha256;
			CTC_ALIGNERS.fr.expectedSha256 = createHash("sha256").update(bytes).digest("hex");
			try {
				const file = await ensureAligner({
					baseDir: dir,
					language: "fr",
					fetcher: async () => new Response(bytes, { status: 200 }),
				});
				expect(file).toBe(alignerPath(dir, "fr"));
				expect(await readFile(file as string)).toEqual(bytes);
			} finally {
				CTC_ALIGNERS.fr.expectedSha256 = original;
			}
		});

		it("refuses a download whose digest does not match", async () => {
			await expect(
				ensureAligner({
					baseDir: dir,
					language: "en",
					fetcher: async () => new Response("tampered", { status: 200 }),
				}),
			).rejects.toThrow(/SHA-256 mismatch/);
			expect(existsSync(alignerPath(dir, "en") as string)).toBe(false);
		});

		/** A body that sends a few bytes, then nothing, ever. */
		const stalledBody = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(8));
					},
				}),
				{ status: 200 },
			);

		it("aborts a download that stops sending, and leaves no partial file", async () => {
			const file = alignerPath(dir, "fr") as string;
			await expect(
				ensureAligner({
					baseDir: dir,
					language: "fr",
					stallMs: 50,
					fetcher: async () => stalledBody(),
				}),
			).rejects.toThrow(/stalled/);
			expect(existsSync(file)).toBe(false);
			expect(existsSync(`${file}.partial`)).toBe(false);
		});

		it("stops when its signal aborts, mid-body or between attempts", async () => {
			const controller = new AbortController();
			const download = ensureAligner({
				baseDir: dir,
				language: "fr",
				signal: controller.signal,
				fetcher: async () => stalledBody(),
			});
			setTimeout(() => controller.abort(new Error("cancelled")), 20);
			await expect(download).rejects.toThrow("cancelled");

			// A 503 puts it in a backoff of seconds: the abort must not wait for it.
			const again = new AbortController();
			const started = Date.now();
			const retrying = ensureAligner({
				baseDir: dir,
				language: "fr",
				signal: again.signal,
				fetcher: async () => new Response("busy", { status: 503 }),
			});
			setTimeout(() => again.abort(new Error("quit")), 20);
			await expect(retrying).rejects.toThrow("quit");
			expect(Date.now() - started).toBeLessThan(1000);
		});

		it("verifies a cached copy without the network", async () => {
			expect(await cachedAligner(dir, "fr")).toBeNull();
			const file = alignerPath(dir, "fr") as string;
			const bytes = Buffer.from("gguf weights");
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, bytes);
			// Present but not the pinned bytes: not usable.
			expect(await cachedAligner(dir, "fr")).toBeNull();
			const original = CTC_ALIGNERS.fr.expectedSha256;
			CTC_ALIGNERS.fr.expectedSha256 = createHash("sha256").update(bytes).digest("hex");
			try {
				expect(await cachedAligner(dir, "fr")).toBe(file);
			} finally {
				CTC_ALIGNERS.fr.expectedSha256 = original;
			}
		});
	});
});
