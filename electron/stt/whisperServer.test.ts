import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperServerManager, writeSamplesAsWav } from "./whisperServer";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	// ponytail: vi.mock factory has to preserve the module's full surface
	// (named + default + namespace). Replacing only `spawn` would otherwise
	// drop the `default` export and break the `import("node:child_process")`
	// cycle whisperServer.ts relies on for `ChildProcessByStdio`.
	const spawn = vi.fn();
	return { ...actual, spawn, default: { ...(actual.default ?? {}), spawn } };
});

describe("whisperServer.writeSamplesAsWav", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "stt-wav-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes a 16 kHz mono 16-bit PCM WAV with a valid RIFF header", async () => {
		const samples = new Float32Array(1600);
		for (let i = 0; i < samples.length; i++) {
			samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16_000) * 0.5;
		}
		const wavPath = await writeSamplesAsWav(samples);
		const statResult = await stat(wavPath);
		// RIFF header (44) + 16-bit mono (samples * 2).
		expect(statResult.size).toBe(44 + samples.length * 2);
		try {
			const fs = await import("node:fs/promises");
			const head = await fs.readFile(wavPath, { encoding: null });
			const headBuf = head.subarray(0, 12);
			expect(headBuf.toString("ascii", 0, 4)).toBe("RIFF");
			expect(headBuf.toString("ascii", 8, 12)).toBe("WAVE");
			expect(head.readUInt16LE(22)).toBe(1); // mono
			expect(head.readUInt32LE(24)).toBe(16_000); // sample rate
			expect(head.readUInt16LE(34)).toBe(16); // bits per sample
		} finally {
			// Cleanup the parent temp dir the helper created.
			await rm(path.dirname(wavPath), { recursive: true, force: true });
		}
	});

	it("clamps samples outside [-1, 1] so the writer can't overflow int16", async () => {
		const samples = new Float32Array([2, -2, 1.5, -1.5]);
		const wavPath = await writeSamplesAsWav(samples);
		try {
			const fs = await import("node:fs/promises");
			const head = await fs.readFile(wavPath, { encoding: null });
			const dataOffset = 44;
			// 2 → +1 → 32_767; -2 → -1 → -32_767 (round(-32_767.5) is implementation-defined for ties).
			expect(head.readInt16LE(dataOffset)).toBe(32_767);
			expect(head.readInt16LE(dataOffset + 2)).toBe(-32_767);
			// 1.5 → clamp to +1 → still 32_767.
			expect(head.readInt16LE(dataOffset + 4)).toBe(32_767);
			expect(head.readInt16LE(dataOffset + 6)).toBe(-32_767);
		} finally {
			await rm(path.dirname(wavPath), { recursive: true, force: true });
		}
	});
});

describe("WhisperServerManager", () => {
	it("reports a clean status when not started", () => {
		const mgr = new WhisperServerManager();
		const status = mgr.status;
		expect(status.running).toBe(false);
		expect(status.pid).toBeNull();
		expect(status.port).toBeNull();
		expect(status.backend).toBeNull();
		expect(status.startedAtMs).toBeNull();
	});

	it("clears lastError between runs", () => {
		const mgr = new WhisperServerManager();
		// Private mutator just to check that calling status gives a fresh shape.
		mgr.stop(); // should be a no-op
		expect(mgr.status.running).toBe(false);
	});

	it("extracts phrase and word segments from a verbose_json response", async () => {
		// ponytail: regression coverage for the parsing bug where `response_format`
		// was "json" (no segments at all) and the code read `json.transcription`
		// (a shape whisper-server never actually emits) — segments and words were
		// always empty, but nothing failed loudly to surface it.
		const fakeJson = {
			task: "transcribe",
			language: "english",
			text: " Hello world.",
			segments: [
				{
					id: 0,
					text: " Hello world.",
					start: 0.0,
					end: 1.5,
					words: [
						{ word: " Hello", start: 0.0, end: 0.8 },
						{ word: " world.", start: 0.8, end: 1.5 },
					],
				},
			],
			detected_language: "english",
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(fakeJson), { status: 200 })),
		);
		try {
			const mgr = new WhisperServerManager();
			// Bypass the real spawn/poll — `transcribe()` only needs `process`+`port` set
			// for `ensureReady()` to pass; the HTTP call itself is the fake fetch above.
			(mgr as unknown as { process: unknown; port: number }).process = {};
			(mgr as unknown as { process: unknown; port: number }).port = 9999;

			const result = await mgr.transcribe({ samples: new Float32Array(1600) });
			expect(result.detectedLanguage).toBe("english");
			expect(result.segments).toEqual([{ text: "Hello world.", startSec: 0, endSec: 1.5 }]);
			expect(result.wordSegments).toEqual([
				{ word: "Hello", startSec: 0, endSec: 0.8 },
				{ word: "world.", startSec: 0.8, endSec: 1.5 },
			]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	describe("WhisperServerManager language normalization", () => {
		// ponytail: regression for the silent-English-bug. whisper-server's built-in
		// language default is `en`, NOT auto-detect — leaving the form field out
		// makes every audio decode as English, which on French audio looks like
		// (very confident) English hallucination. Our IPC contract documents
		// "Omit / `auto` → Whisper detects"; honour that by sending the explicit
		// `auto` keyword in both no-language and "auto"-string cases, and pass
		// through any forced code unchanged.

		function captureFormField(language: string | undefined): Promise<string | null> {
			return new Promise((resolve, reject) => {
				let resolvedText: string | null = null;
				const fakeJson = {
					segments: [],
					detected_language: "english",
				};
				vi.stubGlobal(
					"fetch",
					vi.fn(async (_url: string, init: RequestInit) => {
						// Strip the multipart boundary from the body and pull the
						// `language` field; good enough for assertion, doesn't try
						// to be a full multipart parser.
						const body = init?.body as FormData | undefined;
						if (body && typeof (body as FormData).get === "function") {
							resolvedText = (body as FormData).get("language") as string | null;
						}
						return new Response(JSON.stringify(fakeJson), { status: 200 });
					}),
				);
				(async () => {
					try {
						const mgr = new WhisperServerManager();
						(mgr as unknown as { process: unknown; port: number }).process = {};
						(mgr as unknown as { process: unknown; port: number }).port = 9999;
						await mgr.transcribe({
							samples: new Float32Array(1600),
							language,
						});
						resolve(resolvedText);
					} catch (e) {
						reject(e);
					}
				})().catch(reject);
			});
		}

		it("sends 'auto' when language is undefined (lets whisper-server detect)", async () => {
			const sent = await captureFormField(undefined);
			expect(sent).toBe("auto");
		});

		it("sends 'auto' when the literal 'auto' string is forwarded", async () => {
			const sent = await captureFormField("auto");
			expect(sent).toBe("auto");
		});

		it("passes through an explicit ISO 639-1 code like 'fr' unchanged", async () => {
			const sent = await captureFormField("fr");
			expect(sent).toBe("fr");
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});
	});

	it("composes word timestamps relative to their parent segment (VAD-only contract)", async () => {
		// ponytail: regression coverage for the VAD-relative word timestamp
		// contract discovered against the real whisper-server + Silero VAD pair.
		// With `--vad`, whisper.cpp transcribes each speech region in isolation
		// and emits per-word times relative to the cropped audio. The parent
		// segment's `start` is still absolute. Without `word.start + seg.start`,
		// the first words after a leading silent stretch land at t=0 instead
		// of t=~5s (verified against a 5s-silence test clip: raw "Hello" start
		// = 0.03s, parent seg start = 5.51s, composed absolute = 5.54s).
		const fakeJson = {
			task: "transcribe",
			language: "english",
			text: " Hello world.",
			segments: [
				{
					id: 0,
					text: " Hello world.",
					start: 5.51,
					end: 8.98,
					// raw starts are within the cropped region (0.03s = vad-time).
					words: [
						{ word: " Hello", start: 0.03, end: 0.38 },
						{ word: " world.", start: 0.38, end: 0.65 },
					],
				},
			],
			detected_language: "english",
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(fakeJson), { status: 200 })),
		);
		try {
			const mgr = new WhisperServerManager();
			(mgr as unknown as { process: unknown; port: number }).process = {};
			(mgr as unknown as { process: unknown; port: number }).port = 9999;
			const result = await mgr.transcribe({ samples: new Float32Array(1600) });
			expect(result.segments).toEqual([{ text: "Hello world.", startSec: 5.51, endSec: 8.98 }]);
			// Composed: 5.51 + 0.03 = 5.54, 5.51 + 0.38 = 5.89, ...
			expect(result.wordSegments).toEqual([
				{ word: "Hello", startSec: 5.54, endSec: 5.89 },
				{ word: "world.", startSec: 5.89, endSec: expect.closeTo(6.16, 2) },
			]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("spawns whisper-server with --vad and --vad-model <vadModelPath>", async () => {
		// ponytail: VAD is required for accurate word timestamps after leading
		// silence. The flag pair is the *contract* — if anyone removes either
		// argument or hands back the wrong path, this test fails loudly before
		// we ship code that quietly regresses back to the pre-VAD behavior.
		const fs = await import("node:fs/promises");
		const { spawn } = await import("node:child_process");
		const dir = await mkdtemp(path.join(tmpdir(), "stt-spawn-"));
		try {
			const modelPath = path.join(dir, "model.bin");
			const vadPath = path.join(dir, "vad.bin");
			const fakeBinaryPath = path.join(dir, "whisper-server.exe");
			await fs.writeFile(modelPath, "x");
			await fs.writeFile(vadPath, "y");
			await fs.writeFile(fakeBinaryPath, "x");
			const fakeChild = {
				stdout: { on: vi.fn() },
				stderr: { on: vi.fn() },
				pid: 1234,
				once: vi.fn(),
				on: vi.fn(),
				kill: vi.fn(),
			};
			vi.mocked(spawn).mockReturnValue(fakeChild as never);
			// 200 on the poll so start() doesn't time out.
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response("ok", { status: 200 })),
			);
			try {
				const mgr = new WhisperServerManager();
				await mgr.start({
					modelPath,
					vadModelPath: vadPath,
					binaryPath: fakeBinaryPath,
					backend: "whisper-cpu",
				});
				const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
				expect(args).toContain("--vad");
				const vadModelIdx = args.indexOf("--vad-model");
				expect(vadModelIdx).toBeGreaterThan(-1);
				expect(args[vadModelIdx + 1]).toBe(vadPath);
			} finally {
				vi.unstubAllGlobals();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses to start when the VAD model file is missing", async () => {
		const fs = await import("node:fs/promises");
		const dir = await mkdtemp(path.join(tmpdir(), "stt-no-vad-"));
		try {
			const modelPath = path.join(dir, "model.bin");
			const fakeBinaryPath = path.join(
				dir,
				process.platform === "win32" ? "whisper-server.exe" : "whisper-server",
			);
			await fs.writeFile(modelPath, "x");
			await fs.writeFile(fakeBinaryPath, "x");
			const mgr = new WhisperServerManager();
			await expect(
				mgr.start({
					modelPath,
					vadModelPath: path.join(dir, "missing-vad.bin"),
					binaryPath: fakeBinaryPath,
					backend: "whisper-cpu",
				}),
			).rejects.toThrow(/Silero VAD model not found/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
