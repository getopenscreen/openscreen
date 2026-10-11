import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { planChunks } from "./chunking";
import { extractMono16kPcm } from "./extractAudio";
import { _resetSttManagerForTests, getSttManager, SttManager, shutdownStt } from "./index";
import type { SttStatusEvent, SttTranscribeResponse } from "./transcriptionContract";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/fake-stt-user-data" } }));
vi.mock("./extractAudio", () => ({ extractMono16kPcm: vi.fn() }));

// We swap the long-lived modules for fakes so the manager's `init()` and
// `transcribe()` paths can be exercised without spawning real processes.
const fakeWhisperServer = {
	start: vi.fn(),
	status: {
		backend: "whispercpp-cpu" as const,
		port: 9000,
		running: true,
		startedAtMs: 1,
		pid: 1,
		lastError: null,
	},
	transcribe: vi.fn(),
	stop: vi.fn(),
	shutdown: vi.fn(),
};

const fakeAgyTranscribe = vi.fn();
vi.mock("./agyProvider", () => ({
	AgyTranscriptionProvider: class {
		transcribe = fakeAgyTranscribe;
	},
}));
const fakeGmiTranscribe = vi.fn();
vi.mock("./gmiProvider", () => ({
	GmiTranscriptionProvider: class {
		transcribe = fakeGmiTranscribe;
	},
}));

vi.mock("./whisperServer", () => {
	class FakeWhisperServerManager {
		start = fakeWhisperServer.start;
		status = fakeWhisperServer.status;
		transcribe = fakeWhisperServer.transcribe;
		stop = fakeWhisperServer.stop;
		shutdown = fakeWhisperServer.shutdown;
	}
	return { WhisperServerManager: FakeWhisperServerManager };
});

vi.mock("./modelManager", () => ({
	ensureModels: vi.fn(async () => undefined),
	ensureAligner: vi.fn(async ({ language }: { language: string }) => `/fake/${language}.gguf`),
	cachedAligner: vi.fn(async () => null),
	alignerPath: vi.fn((base: string, language: string): string | null => `${base}/${language}.gguf`),
	modelPaths: (base: string) => ({
		whisper: `${base}/whisper-ggml/ggml-small-q8_0.bin`,
	}),
}));

vi.mock("./gpuDetector", () => ({
	detectGpuBackend: vi.fn(async () => ({ backend: "whispercpp-cpu", reason: "fake → cpu" })),
	binaryNameForBackend: () => "whisper-stt-server",
	candidateBinaryPaths: () => [] as string[],
	resolveBinaryPath: vi.fn(async () => ({
		path: "/fake/whisper-stt-server",
		backend: "whispercpp-cpu" as const,
	})),
}));

describe("SttManager", () => {
	let infoSpy: MockInstance<typeof console.info>;
	let warnSpy: MockInstance<typeof console.warn>;

	it("retains every phrase when Chinese chunks mix sentence-only and word timing", async () => {
		fakeWhisperServer.transcribe
			.mockResolvedValueOnce({
				segments: [{ text: "这是完整中文句子", startSec: 0, endSec: 7 }],
				wordSegments: [{ word: "这是完整中文句子", startSec: 0, endSec: 4 }],
				detectedLanguage: "zh",
				backend: "whispercpp-metal",
			})
			.mockResolvedValueOnce({
				segments: [{ text: "第二句", startSec: 0, endSec: 2 }],
				wordSegments: [
					{ word: "第二", startSec: 0, endSec: 1 },
					{ word: "句", startSec: 1, endSec: 2 },
				],
				detectedLanguage: "zh",
				backend: "whispercpp-metal",
			});
		const manager = new SttManager({
			getProviderConfig: () => ({
				provider: "whisper",
				cloudConsent: false,
				traditionalChinese: true,
			}),
		});
		const result = await manager.transcribe({
			samples: new Float32Array(100 * 16000),
			language: "zh",
		});
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledTimes(2);
		expect(result.wordSegments).toEqual([]);
		expect(result.segments).toEqual([
			{ text: "這是完整中文句子", startSec: 0, endSec: 7 },
			{ text: "第二句", startSec: 90, endSec: 92 },
		]);
	});

	it("requires separate AGY consent before extraction or upload", async () => {
		const manager = new SttManager({
			getProviderConfig: () => ({ provider: "agy", cloudConsent: true, apiKey: "private-token" }),
		});
		await expect(manager.transcribe({ samples: new Float32Array(16000) })).rejects.toThrow(
			/separate explicit consent/,
		);
		expect(fakeAgyTranscribe).not.toHaveBeenCalled();
		expect(fakeWhisperServer.start).not.toHaveBeenCalled();
	});
	it("routes AGY phrase results without initializing Whisper or using the GMI key", async () => {
		fakeAgyTranscribe.mockResolvedValue({
			segments: [{ text: "繁體字幕", startSec: 0, endSec: 0.9 }],
			wordSegments: [],
			detectedLanguage: "zh",
			backend: "agy-gemini",
			timing: { elapsedSec: 2, audioSec: 1, rtf: 2 },
		});
		const manager = new SttManager({
			getProviderConfig: () => ({
				provider: "agy",
				cloudConsent: true,
				agyCloudConsent: true,
				apiKey: "private-token",
			}),
		});
		const result = await manager.transcribe({ samples: new Float32Array(16000) });
		expect(result.backend).toBe("agy-gemini");
		expect(result.wordSegments).toEqual([]);
		expect(result.timing?.elapsedSec).toBe(2);
		expect(fakeWhisperServer.start).not.toHaveBeenCalled();
		expect(fakeGmiTranscribe).not.toHaveBeenCalled();
		expect(fakeAgyTranscribe.mock.calls[0][0]).not.toHaveProperty("apiKey");
	});
	it("cancels an AGY request in flight", async () => {
		fakeAgyTranscribe.mockImplementation(
			({ signal }: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new DOMException("cancel", "AbortError")), {
						once: true,
					}),
				),
		);
		const manager = new SttManager({
			getProviderConfig: () => ({ provider: "agy", cloudConsent: false, agyCloudConsent: true }),
		});
		const request = manager.transcribe({ samples: new Float32Array(16000) });
		const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
		await vi.waitFor(() => expect(fakeAgyTranscribe).toHaveBeenCalled());
		manager.cancel();
		await rejected;
	});

	beforeEach(() => {
		vi.mocked(extractMono16kPcm).mockReset();
		fakeAgyTranscribe.mockReset();
		fakeGmiTranscribe.mockReset();
		fakeGmiTranscribe.mockResolvedValue({
			segments: [{ text: "繁體字幕", startSec: 0.25, endSec: 0.75 }],
			wordSegments: [],
			detectedLanguage: "zh",
			backend: "gmi-gemini",
			timing: { elapsedSec: 0.5, audioSec: 1, rtf: 0.5 },
		});
		fakeWhisperServer.start.mockClear();
		fakeWhisperServer.transcribe.mockClear();
		fakeWhisperServer.stop.mockClear();
		fakeWhisperServer.shutdown.mockClear();
		fakeWhisperServer.start.mockResolvedValue({ port: 9000, backend: "whispercpp-cpu" });
		fakeWhisperServer.transcribe.mockResolvedValue({
			segments: [{ text: "hello", startSec: 0, endSec: 0.5 }],
			wordSegments: [{ word: "hello", startSec: 0, endSec: 0.5 }],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
		});
		_resetSttManagerForTests();
		// The manager narrates every chunk (backend + timing) through `console.*`,
		// which is what puts those lines in the main-process ring buffer. Capture
		// them instead of letting a dozen lines per test onto the suite's output.
		infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	it("routes an authorized GMI run through cloud chunks with absolute caption times, without local models", async () => {
		const mgr = new SttManager({
			getProviderConfig: () => ({
				provider: "gmi",
				cloudConsent: true,
				apiKey: "cloud-secret",
			}),
		});
		const events: SttStatusEvent[] = [];
		mgr.addStatusSink((event) => events.push(event));
		const result = await mgr.transcribe({ samples: new Float32Array(91 * 16_000) });
		expect(result.backend).toBe("gmi-gemini");
		expect(result.segments).toEqual([
			{ text: "繁體字幕", startSec: 0.25, endSec: 0.75 },
			{ text: "繁體字幕", startSec: 90.25, endSec: 90.75 },
		]);
		expect(result.wordSegments).toEqual([]);
		expect(fakeWhisperServer.start).not.toHaveBeenCalled();
		expect(fakeWhisperServer.transcribe).not.toHaveBeenCalled();
		expect(fakeGmiTranscribe.mock.calls.map(([request]) => request.samples.length)).toEqual([
			90 * 16_000,
			16_000,
		]);
		expect(
			events.filter((event) => event.phase === "transcribe").map((event) => event.completedSec),
		).toEqual([0, 90, 91]);
	});

	it("preserves the original media clock and audio mix when GMI transcribes a source path", async () => {
		const samples = new Float32Array(4 * 16_000);
		samples.fill(0.25, 2 * 16_000);
		vi.mocked(extractMono16kPcm).mockResolvedValueOnce(samples);
		const manager = new SttManager({
			getProviderConfig: () => ({ provider: "gmi", cloudConsent: true, apiKey: "test-key" }),
		});
		await manager.transcribe({ sourcePath: "/recordings/delayed-multitrack.mkv" });
		expect(extractMono16kPcm).toHaveBeenCalledWith("/recordings/delayed-multitrack.mkv", {
			signal: expect.any(AbortSignal),
		});
		const sent = fakeGmiTranscribe.mock.calls[0][0].samples as Float32Array;
		expect(sent).toEqual(samples);
		expect(sent.subarray(0, 2 * 16_000).every((sample) => sample === 0)).toBe(true);
		expect(fakeWhisperServer.start).not.toHaveBeenCalled();
	});

	it.each([
		{ provider: "gmi" as const, cloudConsent: false, apiKey: "cloud-secret" },
		{ provider: "gmi" as const, cloudConsent: true },
	])("rejects GMI before decoding or networking when consent/key is missing", async (config) => {
		const mgr = new SttManager({ getProviderConfig: () => config });
		await expect(mgr.transcribe({ sourcePath: "/must-not-read/private.mp4" })).rejects.toThrow(
			/consent|API key/i,
		);
		expect(fakeGmiTranscribe).not.toHaveBeenCalled();
		expect(fakeWhisperServer.start).not.toHaveBeenCalled();
	});

	it("rejects the whole GMI transcript when a later cloud chunk fails, without a local fallback", async () => {
		fakeGmiTranscribe
			.mockResolvedValueOnce({
				segments: [{ text: "第一段", startSec: 0, endSec: 1 }],
				wordSegments: [],
				detectedLanguage: "zh",
				backend: "gmi-gemini",
			})
			.mockRejectedValueOnce(new Error("GMI HTTP 401"));
		const mgr = new SttManager({
			getProviderConfig: () => ({
				provider: "gmi",
				cloudConsent: true,
				apiKey: "cloud-secret",
			}),
		});
		await expect(mgr.transcribe({ samples: new Float32Array(91 * 16_000) })).rejects.toThrow(
			/chunk 2\/2.*GMI HTTP 401/,
		);
		expect(fakeGmiTranscribe).toHaveBeenCalledTimes(2);
		expect(fakeWhisperServer.transcribe).not.toHaveBeenCalled();
	});

	it("surfaces an unexpected transport AbortError when the user has not cancelled", async () => {
		fakeGmiTranscribe.mockRejectedValueOnce(
			new DOMException("GMI response body aborted", "AbortError"),
		);
		const mgr = new SttManager({
			getProviderConfig: () => ({
				provider: "gmi",
				cloudConsent: true,
				apiKey: "cloud-secret",
			}),
		});
		const failure = await mgr
			.transcribe({ samples: new Float32Array(16_000) })
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({ name: "Error" });
		expect((failure as Error).message).toMatch(/GMI transcription failed.*response body aborted/);
	});

	it("rejects empty GMI input instead of reporting an unattempted empty transcript as success", async () => {
		const mgr = new SttManager({
			getProviderConfig: () => ({
				provider: "gmi",
				cloudConsent: true,
				apiKey: "cloud-secret",
			}),
		});
		await expect(mgr.transcribe({ samples: new Float32Array() })).rejects.toThrow(/empty audio/i);
		expect(fakeGmiTranscribe).not.toHaveBeenCalled();
	});

	it("cancel aborts an active GMI request and discards a response arriving after cancellation", async () => {
		let resolve!: (value: unknown) => void;
		fakeGmiTranscribe.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const mgr = new SttManager({
			getProviderConfig: () => ({
				provider: "gmi",
				cloudConsent: true,
				apiKey: "cloud-secret",
			}),
		});
		const pending = mgr.transcribe({ samples: new Float32Array(16_000) });
		await vi.waitFor(() => expect(fakeGmiTranscribe).toHaveBeenCalledOnce());
		const signal = fakeGmiTranscribe.mock.calls[0][0].signal as AbortSignal;
		mgr.cancel();
		expect(signal.aborted).toBe(true);
		resolve({ segments: [], wordSegments: [], detectedLanguage: "zh", backend: "gmi-gemini" });
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	afterEach(() => {
		_resetSttManagerForTests();
		infoSpy.mockRestore();
		warnSpy.mockRestore();
	});

	it("init() forwards model + transcribe phases to the sink", async () => {
		const sink = vi.fn<(e: SttStatusEvent) => void>();
		const mgr = new SttManager();
		await mgr.init({ statusSink: sink, modelsBaseDir: "/tmp/fake-stt-models" });
		const phases = sink.mock.calls.map(([event]) => event.phase);
		expect(phases[0]).toBe("model");
		expect(phases).toContain("transcribe");
	});

	it("transcribe() returns the server's phrase + word segments", async () => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result: SttTranscribeResponse = await mgr.transcribe({
			samples: new Float32Array(16000),
			language: "en",
		});
		expect(result.detectedLanguage).toBe("en");
		expect(result.backend).toBe("whispercpp-cpu");
		expect(result.wordSegments).toHaveLength(1);
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledOnce();
	});

	it("splits a long recording and shifts each chunk's timestamps to absolute time", async () => {
		// Every chunk reports the same relative segment at 1.0s; correct merging
		// turns those into one absolute timestamp per chunk start.
		fakeWhisperServer.transcribe.mockResolvedValue({
			segments: [{ text: "hello", startSec: 1, endSec: 1.5 }],
			wordSegments: [{ word: "hello", startSec: 1, endSec: 1.5 }],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
		});
		const samples = new Float32Array(200 * 16000);
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples, language: "en" });

		const expectedOffsets = planChunks(samples, 16000).map((c) => c.startSample / 16000);
		expect(expectedOffsets.length).toBeGreaterThan(1);
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledTimes(expectedOffsets.length);
		expect(result.segments.map((s) => s.startSec)).toEqual(expectedOffsets.map((o) => o + 1));
		expect(result.wordSegments.map((w) => w.startSec)).toEqual(expectedOffsets.map((o) => o + 1));
	});

	it("reports monotonic progress that ends on the full duration", async () => {
		const sink = vi.fn<(e: SttStatusEvent) => void>();
		const samples = new Float32Array(200 * 16000);
		const mgr = new SttManager();
		await mgr.init({ statusSink: sink, modelsBaseDir: "/tmp/fake-stt-models" });
		sink.mockClear();
		await mgr.transcribe({ samples, language: "en" });

		const progress = sink.mock.calls
			.map(([event]) => event)
			.filter((event) => event.completedSec !== undefined);
		expect(progress[0].completedSec).toBe(0);
		expect(progress[progress.length - 1].completedSec).toBe(200);
		for (const event of progress) expect(event.totalSec).toBe(200);
		for (let i = 1; i < progress.length; i++) {
			expect(progress[i].completedSec).toBeGreaterThan(progress[i - 1].completedSec ?? -1);
		}
	});

	// One per chunk of a 200s recording (90s + 90s + 20s), each with a DIFFERENT
	// ratio on purpose. Identical chunks would let a wrong implementation pass:
	// the arithmetic mean of these RTFs is 0.433, while the weighted figure the
	// run should report is 75/200 = 0.375. Only unequal chunks tell them apart.
	const CHUNK_TIMINGS = [
		{ elapsedSec: 45, audioSec: 90, rtf: 0.5 },
		{ elapsedSec: 18, audioSec: 90, rtf: 0.2 },
		{ elapsedSec: 12, audioSec: 20, rtf: 0.6 },
	];
	const TOTAL_ELAPSED = 75;
	const TOTAL_AUDIO = 200;

	/** The default fake answers without timing; this one measures every chunk. */
	function mockTimedChunks(): void {
		let call = 0;
		fakeWhisperServer.transcribe.mockImplementation(async () => ({
			segments: [],
			wordSegments: [],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
			timing: CHUNK_TIMINGS[Math.min(call++, CHUNK_TIMINGS.length - 1)],
		}));
	}

	it("sums per-chunk timing into one figure for the whole run", async () => {
		mockTimedChunks();
		const samples = new Float32Array(200 * 16000);
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples, language: "en" });

		// Summed, not averaged: chunks differ in length, so the mean of the
		// per-chunk RTFs would not be the RTF of the run.
		expect(planChunks(samples, 16000)).toHaveLength(CHUNK_TIMINGS.length);
		expect(result.timing).toEqual({
			elapsedSec: TOTAL_ELAPSED,
			audioSec: TOTAL_AUDIO,
			rtf: TOTAL_ELAPSED / TOTAL_AUDIO,
		});
		// Nail the distinction down rather than trusting the numbers to differ.
		const mean = CHUNK_TIMINGS.reduce((sum, t) => sum + t.rtf, 0) / CHUNK_TIMINGS.length;
		expect(result.timing?.rtf).not.toBeCloseTo(mean, 3);
	});

	it("reports no run timing at all when one chunk went unmeasured", async () => {
		// A single chunk without a `timing` block is enough to spoil the totals:
		// they would describe 110s of audio for a 200s recording, under a field
		// that says it covers every chunk. The two measured chunks carry DIFFERENT
		// ratios so the running figure asserted below cannot be constant by luck.
		const MEASURED = [
			{ elapsedSec: 45, audioSec: 90, rtf: 0.5 },
			undefined,
			{ elapsedSec: 5, audioSec: 20, rtf: 0.25 },
		];
		let call = 0;
		fakeWhisperServer.transcribe.mockImplementation(async () => ({
			segments: [],
			wordSegments: [],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
			timing: MEASURED[call++],
		}));
		const sink = vi.fn<(e: SttStatusEvent) => void>();
		const mgr = new SttManager();
		await mgr.init({ statusSink: sink, modelsBaseDir: "/tmp/fake-stt-models" });
		sink.mockClear();
		const result = await mgr.transcribe({
			samples: new Float32Array(200 * 16000),
			language: "en",
		});

		expect(result.timing).toBeUndefined();
		// And it says which, rather than claiming nothing was measured at all.
		expect(
			infoSpy.mock.calls.some(([line]) =>
				String(line).includes("timing incomplete (1/3 chunks unmeasured)"),
			),
		).toBe(true);
		// The status `rtf` is held to a different rule than the response total, and
		// this is where that difference is visible: being a RATIO, it survives the
		// gap instead of blanking — it holds at the last known value across the
		// unmeasured chunk, then goes on aggregating. Killing the live speed
		// readout for the rest of a run over one bad chunk would be the opposite of
		// what the field exists for.
		const running = sink.mock.calls
			.map(([event]) => event)
			.filter((event) => event.backend !== undefined)
			.map((event) => event.rtf);
		expect(running).toEqual([45 / 90, 45 / 90, 50 / 110]);
	});

	it("logs the backend and the timing of every chunk", async () => {
		mockTimedChunks();
		const samples = new Float32Array(200 * 16000);
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		await mgr.transcribe({ samples, language: "en" });

		const chunkLines = infoSpy.mock.calls
			.map(([line]) => String(line))
			.filter((line) => line.startsWith("[stt] chunk "));
		expect(chunkLines).toHaveLength(planChunks(samples, 16000).length);
		// Both conventions on the line, so it can be read against the POC report
		// without arithmetic.
		expect(chunkLines[0]).toContain("whispercpp-cpu");
		expect(chunkLines[0]).toContain("90.0s audio in 45.0s (0.50 rtf, 2.0x real-time)");
		// Each line carries ITS OWN chunk's cost, not the running total.
		expect(chunkLines[1]).toContain("90.0s audio in 18.0s (0.20 rtf, 5.0x real-time)");
	});

	it("says so when the helper reports no timing at all", async () => {
		// The default fake stands in for a staged binary older than the field.
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples: new Float32Array(16000) });
		expect(result.timing).toBeUndefined();
		expect(infoSpy.mock.calls.some(([line]) => String(line).includes("no timing reported"))).toBe(
			true,
		);
	});

	it("puts the backend and a running rtf on every chunk's status event", async () => {
		mockTimedChunks();
		const samples = new Float32Array(200 * 16000);
		const sink = vi.fn<(e: SttStatusEvent) => void>();
		const mgr = new SttManager();
		await mgr.init({ statusSink: sink, modelsBaseDir: "/tmp/fake-stt-models" });
		sink.mockClear();
		await mgr.transcribe({ samples, language: "en" });

		// The response alone is too late to be a signal: it arrives once the whole
		// recording is done, and the point is to explain the wait while it happens.
		const reported = sink.mock.calls
			.map(([event]) => event)
			.filter((event) => event.backend !== undefined);
		expect(reported).toHaveLength(CHUNK_TIMINGS.length);
		for (const event of reported) expect(event.backend).toBe("whispercpp-cpu");
		// Cumulative and weighted at every step — 45/90, then 63/180, then 75/200 —
		// which is what makes the figure settle instead of bouncing per chunk.
		expect(reported.map((e) => e.rtf)).toEqual([45 / 90, 63 / 180, 75 / 200]);
	});

	it("warns once per run — not once per chunk — that it landed on CPU", async () => {
		mockTimedChunks();
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		await mgr.transcribe({ samples: new Float32Array(200 * 16000), language: "en" });

		const cpuWarnings = warnSpy.mock.calls
			.map(([line]) => String(line))
			.filter((line) => line.includes("running on CPU"));
		expect(cpuWarnings).toHaveLength(1);
	});

	it("stays quiet about the backend when a GPU one is bound", async () => {
		fakeWhisperServer.transcribe.mockResolvedValue({
			segments: [],
			wordSegments: [],
			detectedLanguage: "en",
			backend: "whispercpp-vulkan",
			timing: { elapsedSec: 20, audioSec: 90, rtf: 20 / 90 },
		});
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples: new Float32Array(200 * 16000) });

		expect(result.backend).toBe("whispercpp-vulkan");
		expect(warnSpy.mock.calls.some(([line]) => String(line).includes("running on CPU"))).toBe(
			false,
		);
	});

	// Both spellings of "detect it for me". `"auto"` is the one the request
	// contract documents, and it is truthy — which is exactly how it used to slip
	// past the pin and let every chunk detect its own language.
	it.each([
		["omitted", undefined] as const,
		["auto", "auto"] as const,
	])("pins later chunks to the language detected on the first one (%s)", async (_label, language) => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		await mgr.transcribe({ samples: new Float32Array(200 * 16000), language });
		const languages = fakeWhisperServer.transcribe.mock.calls.map(([req]) => req.language);
		expect(languages[0]).toBeUndefined();
		expect(languages.slice(1).every((l) => l === "en")).toBe(true);
	});

	it("hands the names and terms to every chunk, not only the first", async () => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		await mgr.transcribe({ samples: new Float32Array(200 * 16000), prompt: "OpenScreen, Vulkan" });
		const prompts = fakeWhisperServer.transcribe.mock.calls.map(([req]) => req.prompt);
		expect(prompts.length).toBeGreaterThan(1);
		expect(prompts.every((p) => p === "OpenScreen, Vulkan")).toBe(true);
	});

	it("retries a failed chunk instead of losing the whole transcription", async () => {
		fakeWhisperServer.transcribe.mockRejectedValueOnce(new Error("helper died")).mockResolvedValue({
			segments: [{ text: "hello", startSec: 0, endSec: 0.5 }],
			wordSegments: [{ word: "hello", startSec: 0, endSec: 0.5 }],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
		});
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples: new Float32Array(16000), language: "en" });
		expect(result.segments).toHaveLength(1);
		// start() again on the retry — the usual cause is a dead helper.
		expect(fakeWhisperServer.start.mock.calls.length).toBeGreaterThan(1);
	});

	it("fails the request when a chunk never succeeds, saying how far it got", async () => {
		fakeWhisperServer.transcribe.mockRejectedValue(new Error("helper wedged"));
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		// 200s in, the failure is on chunk 2 of 3 — "Transcription failed" alone
		// tells the user nothing about a recording this long.
		await expect(mgr.transcribe({ samples: new Float32Array(200 * 16000) })).rejects.toThrow(
			/transcription failed \d+s into a 200s recording \(chunk 1\/3\).*helper wedged/,
		);
	});

	it("stops at the next chunk boundary when cancelled", async () => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		// Cancel lands while the first chunk is in flight — the loop must not go on
		// to the remaining ones, which is what left "regenerate" waiting on a run
		// nobody wanted any more.
		fakeWhisperServer.transcribe.mockImplementation(async () => {
			mgr.cancel();
			return {
				segments: [],
				wordSegments: [],
				detectedLanguage: "en",
				backend: "whispercpp-cpu" as const,
			};
		});
		const samples = new Float32Array(300 * 16000);
		expect(planChunks(samples, 16000).length).toBeGreaterThan(1);

		const error = await mgr.transcribe({ samples }).catch((e: unknown) => e);
		// `AbortError` by name, so the renderer treats it as "the user asked" and
		// drops the job silently instead of toasting an engine failure.
		expect((error as Error).name).toBe("AbortError");
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledOnce();
	});

	it("shutdown() stops whisper-stt-server", async () => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		await mgr.shutdown();
		expect(fakeWhisperServer.shutdown).toHaveBeenCalledOnce();
	});

	it("shutdownStt() stops and releases the singleton exactly once", async () => {
		const mgr = getSttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });

		await shutdownStt();
		await shutdownStt();

		expect(fakeWhisperServer.shutdown).toHaveBeenCalledOnce();
		expect(() => getSttManager()).toThrowError(/cancel/i);
	});

	it("does not respawn the helper when shutdown interrupts a failed chunk", async () => {
		const mgr = getSttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		fakeWhisperServer.transcribe.mockImplementationOnce(async () => {
			await shutdownStt();
			throw new Error("connection closed during quit");
		});

		const error = await mgr
			.transcribe({ samples: new Float32Array(16000), language: "en" })
			.catch((value: unknown) => value);

		expect((error as Error).name).toBe("AbortError");
		expect(fakeWhisperServer.start).toHaveBeenCalledOnce();
		expect(fakeWhisperServer.shutdown).toHaveBeenCalledOnce();
	});

	it("cancels when shutdown starts as setup rejects", async () => {
		const mgr = new SttManager();
		fakeWhisperServer.start.mockImplementationOnce(async () => {
			await mgr.shutdown();
			throw new Error("connection closed during startup");
		});

		const error = await mgr
			.init({ modelsBaseDir: "/tmp/fake-stt-models" })
			.catch((value: unknown) => value);

		expect((error as Error).name).toBe("AbortError");
		expect(fakeWhisperServer.shutdown).toHaveBeenCalledOnce();
	});

	it("cancels when shutdown starts as the final chunk resolves", async () => {
		const mgr = getSttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		fakeWhisperServer.transcribe.mockImplementationOnce(async () => {
			await shutdownStt();
			return {
				segments: [{ text: "late", startSec: 0, endSec: 0.5 }],
				wordSegments: [{ word: "late", startSec: 0, endSec: 0.5 }],
				detectedLanguage: "en",
				backend: "whispercpp-cpu" as const,
			};
		});

		const error = await mgr
			.transcribe({ samples: new Float32Array(16_000), language: "en" })
			.catch((value: unknown) => value);

		expect((error as Error).name).toBe("AbortError");
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledOnce();
	});

	it("retries setup after a failed one instead of caching the rejection", async () => {
		// First run downloads a 264 MB model. Caching a rejected `prepare()` meant
		// one dropped connection failed every later transcription in the session —
		// including the retry the editor offers — until the app was restarted.
		const { ensureModels } = await import("./modelManager");
		const mocked = vi.mocked(ensureModels);
		mocked.mockClear();
		mocked.mockRejectedValueOnce(new Error("Failed to download: network unreachable"));
		const mgr = new SttManager();

		await expect(mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" })).rejects.toThrow(
			"network unreachable",
		);
		// The network came back: the next attempt must actually attempt.
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });

		expect(mocked).toHaveBeenCalledTimes(2);
		expect(fakeWhisperServer.start).toHaveBeenCalledOnce();
	});

	describe("word aligner", () => {
		/** Chunks report what `alignerFor("fr")` gave them, as the helper would use it. */
		function recordAligner() {
			const asked: Array<string | null> = [];
			fakeWhisperServer.transcribe.mockImplementation(
				async (opts: { alignerFor?: (language: string) => Promise<string | null> }) => {
					asked.push((await opts.alignerFor?.("fr")) ?? null);
					return {
						segments: [],
						wordSegments: [],
						detectedLanguage: "fr",
						backend: "whispercpp-cpu" as const,
					};
				},
			);
			return asked;
		}
		const long = new Float32Array(16_000 * 400);

		async function mocks() {
			const mm = await import("./modelManager");
			const ensure = vi.mocked(mm.ensureAligner);
			const cached = vi.mocked(mm.cachedAligner);
			ensure.mockReset();
			cached.mockReset();
			cached.mockResolvedValue(null);
			return { ensure, cached };
		}

		it("never holds a chunk on the download, and uses the aligner once it lands", async () => {
			const { ensure } = await mocks();
			let land: (file: string) => void = () => undefined;
			ensure.mockImplementation(() => new Promise((resolve) => (land = resolve)));
			const asked = recordAligner();
			const mgr = new SttManager();
			await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });

			// The download never finishes during this run: every chunk goes on without it.
			await mgr.transcribe({ samples: long, language: "fr" });
			expect(asked.length).toBeGreaterThan(1);
			expect(asked.every((x) => x === null)).toBe(true);
			expect(ensure).toHaveBeenCalledOnce();

			land("/fake/fr.gguf");
			await new Promise((resolve) => setTimeout(resolve, 0));
			asked.length = 0;
			await mgr.transcribe({ samples: new Float32Array(16_000), language: "fr" });
			expect(asked).toEqual(["/fake/fr.gguf"]);
			expect(ensure).toHaveBeenCalledOnce();
		});

		it("uses a verified copy already on disk without downloading", async () => {
			const { ensure, cached } = await mocks();
			cached.mockResolvedValue("/fake/fr.gguf");
			const asked = recordAligner();
			const mgr = new SttManager();
			await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
			await mgr.transcribe({ samples: long, language: "fr" });
			expect(asked.every((x) => x === "/fake/fr.gguf")).toBe(true);
			expect(cached).toHaveBeenCalledOnce();
			expect(ensure).not.toHaveBeenCalled();
		});

		it("aborts the download on cancel and on shutdown, then retries on a later run", async () => {
			const { ensure } = await mocks();
			const signals: AbortSignal[] = [];
			ensure.mockImplementation(
				({ signal }: { signal?: AbortSignal }) =>
					new Promise((_, reject) => {
						if (signal) signals.push(signal);
						signal?.addEventListener("abort", () => reject(signal.reason));
					}),
			);
			recordAligner();
			const mgr = new SttManager();
			await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
			await mgr.transcribe({ samples: long, language: "fr" });
			expect(signals).toHaveLength(1);

			mgr.cancel();
			expect(signals[0].aborted).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Not cached as failed for good: the next transcription starts it again.
			await mgr.transcribe({ samples: long, language: "fr" });
			expect(signals).toHaveLength(2);
			expect(signals[1].aborted).toBe(false);
			await mgr.shutdown();
			expect(signals[1].aborted).toBe(true);
		});

		it("gives a language without an aligner nothing, and downloads nothing", async () => {
			const { ensure } = await mocks();
			const mm = await import("./modelManager");
			vi.mocked(mm.alignerPath).mockReturnValueOnce(null);
			const asked = recordAligner();
			const mgr = new SttManager();
			await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
			await mgr.transcribe({ samples: new Float32Array(16_000), language: "fr" });
			expect(asked).toEqual([null]);
			expect(ensure).not.toHaveBeenCalled();
		});
	});

	it("fans status out to every sink, and detaching one leaves the others", async () => {
		const mgr = new SttManager();
		const a = vi.fn<(e: SttStatusEvent) => void>();
		const b = vi.fn<(e: SttStatusEvent) => void>();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const detachA = mgr.addStatusSink(a);
		mgr.addStatusSink(b);
		await mgr.transcribe({ samples: new Float32Array(16000), language: "en" });
		expect(a).toHaveBeenCalled();
		expect(b).toHaveBeenCalled();

		// The whole point of the Set. Two overlapping IPC requests each attach a
		// sink; when the first finishes and detaches, the second must keep getting
		// its own progress instead of falling silent for the rest of its run.
		detachA();
		a.mockClear();
		b.mockClear();
		await mgr.transcribe({ samples: new Float32Array(16000), language: "en" });
		expect(a).not.toHaveBeenCalled();
		expect(b).toHaveBeenCalled();
	});
});
