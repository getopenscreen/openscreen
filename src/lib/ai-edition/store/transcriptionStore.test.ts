// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSCRIPTION_SETTINGS_CHANGED_EVENT } from "@/hooks/useTranscriptionProvider";
import { toastText } from "@/i18n/toastText";
import type { AxcutDocument, AxcutTranscript } from "../schema";
import { useProjectStore } from "./projectStore";
import {
	useAutoTranscription,
	useTranscriptionStore,
	whenTranscriptionIdle,
} from "./transcriptionStore";
import { redo, undo } from "./undo";
import { future, past } from "./undoStack";

const bridgeMocks = vi.hoisted(() => ({
	save: vi.fn(),
}));

const transcribeMocks = vi.hoisted(() => ({
	transcribeAsset: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: { save: bridgeMocks.save } },
}));

vi.mock("../document/transcribe", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../document/transcribe")>();
	return { ...actual, transcribeAsset: transcribeMocks.transcribeAsset };
});

vi.mock("sonner", () => ({
	toast: { success: toastMocks.success, error: toastMocks.error, info: toastMocks.info },
}));

function asset(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		kind: "video" as const,
		label: `${id}.mp4`,
		originalPath: `/tmp/${id}.mp4`,
		cameraTrack: null,
		...extra,
	};
}

function makeDoc(assetIds: string[], projectId = "proj_1"): AxcutDocument {
	return {
		schemaVersion: 8,
		project: {
			id: projectId,
			title: "Test",
			createdAt: "2026-06-25T10:00:00.000Z",
			updatedAt: "2026-06-25T10:00:00.000Z",
			primaryAssetId: assetIds[0],
		},
		assets: assetIds.map((id) => asset(id)),
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
	} as unknown as AxcutDocument;
}

function transcriptFor(assetId: string): AxcutTranscript {
	return {
		assetId,
		language: "en",
		segments: [
			{ id: "seg_1", kind: "speech", startSec: 0, endSec: 1, text: "hello", wordIds: ["word_1"] },
		],
		words: [{ id: "word_1", segmentId: "seg_1", startSec: 0, endSec: 1, text: "hello" }],
	};
}

/** A promise plus a 0-arg release, so a mocked run can be held open mid-flight. */
function deferred(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => {
		// Replaced synchronously by the executor below, before this can be called.
	};
	const promise = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	return { promise, release: () => release() };
}

/** Loads a document into the project store the way `loadProject` would. */
function loadDocument(document: AxcutDocument) {
	useProjectStore.setState({
		projectId: document.project.id,
		document,
		status: "ready",
		error: null,
		dirty: false,
	});
}

describe("useTranscriptionStore", () => {
	beforeEach(() => {
		useTranscriptionStore.getState().reset();
		useProjectStore.getState().clear();
		bridgeMocks.save.mockReset();
		// The bridge echoes back whatever it was handed, like a successful save.
		bridgeMocks.save.mockImplementation(async (document: AxcutDocument) => ({
			success: true,
			document,
		}));
		transcribeMocks.transcribeAsset.mockReset();
		toastMocks.success.mockReset();
		toastMocks.error.mockReset();
		toastMocks.info.mockReset();
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the preload bridge
		(window as any).electronAPI = { stt: { transcribe: vi.fn() } };
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the preload bridge
		delete (window as any).electronAPI;
	});

	it("transcribes every asset that has no transcript, one at a time", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await Promise.resolve();
				inFlight -= 1;
				return transcriptFor(assetId);
			},
		);
		loadDocument(makeDoc(["asset_1", "asset_2"]));

		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		expect(maxInFlight).toBe(1);
		expect(transcribeMocks.transcribeAsset).toHaveBeenCalledTimes(2);
		expect(
			useProjectStore
				.getState()
				.document?.transcripts.map((t) => t.assetId)
				.sort(),
		).toEqual(["asset_1", "asset_2"]);
		expect(useTranscriptionStore.getState().jobs).toEqual({});
		// The background pass stays quiet on success.
		expect(toastMocks.success).not.toHaveBeenCalled();
	});

	it("does not re-enqueue an asset whose transcript it just wrote", async () => {
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => transcriptFor(assetId),
		);
		loadDocument(makeDoc(["asset_1"]));

		const { sync } = useTranscriptionStore.getState();
		sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		// Every document change re-runs sync in the shell — this is the loop guard.
		sync(useProjectStore.getState().document);
		sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		expect(transcribeMocks.transcribeAsset).toHaveBeenCalledTimes(1);
		expect(useTranscriptionStore.getState().jobs).toEqual({});
	});

	it("remembers a no-audio verdict on the asset and never retries it by itself", async () => {
		transcribeMocks.transcribeAsset.mockRejectedValue(
			new Error("No audio track found in this video."),
		);
		loadDocument(makeDoc(["asset_1"]));

		const { sync } = useTranscriptionStore.getState();
		sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		const job = useTranscriptionStore.getState().jobs.asset_1;
		expect(job?.status).toBe("failed");
		expect(job?.failure?.kind).toBe("no-audio");
		expect(useProjectStore.getState().document?.assets[0].transcriptionFailure?.kind).toBe(
			"no-audio",
		);
		// Silence is an expected outcome, not an incident.
		expect(toastMocks.error).not.toHaveBeenCalled();

		sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();
		expect(transcribeMocks.transcribeAsset).toHaveBeenCalledTimes(1);
	});

	it("skips an asset that already carries a persisted failure on a fresh load", async () => {
		const doc = makeDoc(["asset_1"]);
		loadDocument({
			...doc,
			assets: [
				asset("asset_1", { transcriptionFailure: { kind: "no-audio", message: "silent" } }),
			] as AxcutDocument["assets"],
		});

		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		expect(transcribeMocks.transcribeAsset).not.toHaveBeenCalled();
		expect(useTranscriptionStore.getState().jobs).toEqual({});
	});

	it("keeps a transient failure in memory only, and toasts it", async () => {
		transcribeMocks.transcribeAsset.mockRejectedValue(new Error("whisper-server exited"));
		loadDocument(makeDoc(["asset_1"]));

		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		expect(useTranscriptionStore.getState().jobs.asset_1?.failure?.kind).toBe("error");
		expect(useProjectStore.getState().document?.assets[0].transcriptionFailure).toBeUndefined();
		expect(toastMocks.error).toHaveBeenCalledTimes(1);
	});

	it("stops the queue on an engine failure instead of failing each asset in turn", async () => {
		// The model download died / whisper-server didn't come up: that verdict is
		// about the engine, so the remaining assets inherit it rather than each
		// spending a full retry budget and stacking an identical toast.
		transcribeMocks.transcribeAsset.mockRejectedValue(new Error("whisper-server exited"));
		loadDocument(makeDoc(["asset_1", "asset_2", "asset_3"]));

		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		expect(transcribeMocks.transcribeAsset).toHaveBeenCalledTimes(1);
		const jobs = useTranscriptionStore.getState().jobs;
		expect(Object.values(jobs).map((j) => j.status)).toEqual(["failed", "failed", "failed"]);
		expect(jobs.asset_3?.failure?.message).toBe("whisper-server exited");
		expect(toastMocks.error).toHaveBeenCalledTimes(1);
	});

	// The verdict is about the FILE, so a run the user asked for by hand answers
	// it as information rather than as a broken job — issue #628 showed a red
	// "Transcription failed" carrying ffmpeg's stderr on a muted screen recording.
	it("answers a hand-asked run on a silent media without calling it a failure", async () => {
		transcribeMocks.transcribeAsset.mockRejectedValue(
			new Error("No decodable audio in /rec.mp4: Output file #0 does not contain any stream"),
		);
		loadDocument(makeDoc(["asset_1"]));

		// The background pass discovers the silence first, and says nothing about it.
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();
		expect(useTranscriptionStore.getState().jobs.asset_1?.failure?.kind).toBe("no-audio");
		expect(toastMocks.info).not.toHaveBeenCalled();

		// Asking by hand deserves an answer — an informational one. `request`
		// resolves as soon as the job settles, which is before the run has finished
		// writing the verdict and reporting it, so wait for the queue too.
		await useTranscriptionStore.getState().request("asset_1", "auto");
		await whenTranscriptionIdle();

		expect(toastMocks.error).not.toHaveBeenCalled();
		expect(toastMocks.info).toHaveBeenCalledTimes(1);
		// The COPY, not just the count: the point of the toast is that it says the
		// file has no audio. Resolved through the same helper the store uses, so a
		// reworded string stays a translation change rather than a test failure.
		expect(toastMocks.info).toHaveBeenCalledWith(
			toastText("editor", "mediaStage.noAudioTrackHint"),
		);
	});

	it("request() re-runs a failed asset and clears the remembered verdict", async () => {
		transcribeMocks.transcribeAsset.mockRejectedValueOnce(
			new Error("No audio track found in this video."),
		);
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => transcriptFor(assetId),
		);
		loadDocument(makeDoc(["asset_1"]));

		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();
		expect(useProjectStore.getState().document?.assets[0].transcriptionFailure?.kind).toBe(
			"no-audio",
		);

		await useTranscriptionStore.getState().request("asset_1", "fr");

		expect(transcribeMocks.transcribeAsset).toHaveBeenLastCalledWith(
			expect.anything(),
			"asset_1",
			expect.objectContaining({ language: "fr" }),
		);
		expect(useProjectStore.getState().document?.transcripts).toHaveLength(1);
		expect(useProjectStore.getState().document?.assets[0].transcriptionFailure).toBeNull();
		expect(useTranscriptionStore.getState().jobs).toEqual({});
		// A run the user asked for reports back.
		expect(toastMocks.success).toHaveBeenCalledTimes(1);
	});

	it("drops the queue when another project is loaded", async () => {
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => transcriptFor(assetId),
		);
		loadDocument(makeDoc(["asset_1"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		const other = makeDoc(["asset_9"], "proj_2");
		loadDocument(other);
		useTranscriptionStore.getState().sync(other);
		expect(useTranscriptionStore.getState().projectId).toBe("proj_2");
		await whenTranscriptionIdle();

		expect(useProjectStore.getState().document?.transcripts.map((t) => t.assetId)).toEqual([
			"asset_9",
		]);
	});

	it("forgets a job when its asset leaves the document", async () => {
		transcribeMocks.transcribeAsset.mockRejectedValue(new Error("whisper-server exited"));
		loadDocument(makeDoc(["asset_1", "asset_2"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();
		expect(Object.keys(useTranscriptionStore.getState().jobs)).toEqual(["asset_1", "asset_2"]);

		const doc = useProjectStore.getState().document as AxcutDocument;
		const pruned = { ...doc, assets: doc.assets.filter((a) => a.id === "asset_1") };
		loadDocument(pruned);
		useTranscriptionStore.getState().sync(pruned);

		expect(Object.keys(useTranscriptionStore.getState().jobs)).toEqual(["asset_1"]);
	});

	it("runs no background pass without a local STT engine", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the preload bridge
		delete (window as any).electronAPI;
		loadDocument(makeDoc(["asset_1"]));

		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await whenTranscriptionIdle();

		expect(transcribeMocks.transcribeAsset).not.toHaveBeenCalled();
		expect(useTranscriptionStore.getState().jobs).toEqual({});
	});

	it("lets a manual request supersede the background run of the same asset", async () => {
		// The background pass is mid-run on asset_1 (auto language) when the user
		// asks for French from the media card. The outgoing run must neither win
		// the race nor delete the request that replaced it.
		const languages: string[] = [];
		const firstRun = deferred();
		transcribeMocks.transcribeAsset.mockImplementation(
			async (
				_doc: AxcutDocument,
				assetId: string,
				options: { language?: string; signal?: AbortSignal },
			) => {
				languages.push(options.language ?? "auto");
				if (languages.length === 1) {
					await firstRun.promise;
					throw new DOMException("Aborted", "AbortError");
				}
				return { ...transcriptFor(assetId), language: options.language ?? "auto" };
			},
		);
		loadDocument(makeDoc(["asset_1"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await Promise.resolve();
		expect(useTranscriptionStore.getState().jobs.asset_1?.status).toBe("running");

		const requested = useTranscriptionStore.getState().request("asset_1", "fr");
		expect(useTranscriptionStore.getState().jobs.asset_1?.status).toBe("queued");
		firstRun.release();
		await requested;
		await whenTranscriptionIdle();

		expect(languages).toEqual(["auto", "fr"]);
		expect(useProjectStore.getState().document?.transcripts).toHaveLength(1);
		expect(useProjectStore.getState().document?.transcripts[0].language).toBe("fr");
		expect(useTranscriptionStore.getState().jobs).toEqual({});
	});

	it("requestTimelineTranscripts covers the timeline's media, skipping the silent ones", async () => {
		// The pane button used to target `primaryAssetId` only — which in a
		// recording project is the (often silent) screen capture, leaving the
		// talking clip next to it untranscribable from there.
		// The background pass is off here so the assertions see only what the
		// button itself asked for.
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the preload bridge
		delete (window as any).electronAPI;
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => transcriptFor(assetId),
		);
		const doc = makeDoc(["silent", "voice", "offTimeline"]);
		loadDocument({
			...doc,
			assets: [
				asset("silent", { transcriptionFailure: { kind: "no-audio", message: "silent" } }),
				asset("voice"),
				asset("offTimeline"),
			],
			timeline: {
				...doc.timeline,
				clips: ["silent", "voice"].map((assetId, i) => ({
					id: `clip_${i}`,
					assetId,
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: i * 10,
					timelineEndSec: i * 10 + 10,
					wordRefs: [],
					origin: "user",
					reason: "",
				})),
			},
		} as unknown as AxcutDocument);

		await useTranscriptionStore.getState().requestTimelineTranscripts();

		expect(transcribeMocks.transcribeAsset.mock.calls.map((c) => c[1])).toEqual(["voice"]);
		expect(useProjectStore.getState().document?.transcripts.map((t) => t.assetId)).toEqual([
			"voice",
		]);
	});

	it("waits for the background run instead of transcribing the same asset twice", async () => {
		const firstRun = deferred();
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => {
				await firstRun.promise;
				return transcriptFor(assetId);
			},
		);
		loadDocument(makeDoc(["asset_1"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await Promise.resolve();
		expect(useTranscriptionStore.getState().jobs.asset_1?.status).toBe("running");

		const requested = useTranscriptionStore.getState().requestTimelineTranscripts();
		firstRun.release();
		await requested;

		expect(transcribeMocks.transcribeAsset).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.transcripts).toHaveLength(1);
	});

	it("still honours a manual request without the auto pass", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test-only stub of the preload bridge
		delete (window as any).electronAPI;
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => transcriptFor(assetId),
		);
		loadDocument(makeDoc(["asset_1"]));

		await useTranscriptionStore.getState().request("asset_1");

		expect(useProjectStore.getState().document?.transcripts).toHaveLength(1);
	});

	it("saves imported SRT on its asset and primary mirror, clearing failures without STT", async () => {
		const doc = makeDoc(["asset_1", "asset_2"]);
		const previous = transcriptFor("asset_1");
		const other = transcriptFor("asset_2");
		loadDocument({
			...doc,
			assets: [
				asset("asset_1", {
					durationSec: 10,
					transcriptionFailure: { kind: "no-audio", message: "old failure" },
				}),
				asset("asset_2"),
			],
			transcript: previous,
			transcripts: [previous, other],
		});
		useTranscriptionStore.setState({
			projectId: doc.project.id,
			jobs: { asset_1: { status: "failed", language: "auto", manual: false } },
		});

		await useTranscriptionStore
			.getState()
			.importSrt("asset_1", "1\n00:00:01,125 --> 00:00:04,250\n外部繁體逐字稿");

		const saved = useProjectStore.getState().document;
		expect(saved?.transcript?.words[0]).toMatchObject({
			text: "外部繁體逐字稿",
			startSec: 1.125,
			endSec: 4.25,
		});
		expect(saved?.transcripts.find((t) => t.assetId === "asset_1")).toEqual(saved?.transcript);
		expect(saved?.transcripts.find((t) => t.assetId === "asset_2")).toEqual(other);
		expect(saved?.assets[0].transcriptionFailure).toBeNull();
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		expect(transcribeMocks.transcribeAsset).not.toHaveBeenCalled();
		expect(useTranscriptionStore.getState().jobs.asset_1).toBeUndefined();
	});

	it("keeps the primary transcript when importing subtitles for a secondary asset", async () => {
		const primary = transcriptFor("asset_1");
		loadDocument({
			...makeDoc(["asset_1", "asset_2"]),
			transcript: primary,
			transcripts: [primary],
		});
		await useTranscriptionStore
			.getState()
			.importSrt("asset_2", "00:00:00,000 --> 00:00:02,500\n第二支影片");
		expect(useProjectStore.getState().document?.transcript).toEqual(primary);
		expect(useProjectStore.getState().document?.transcripts).toHaveLength(2);
	});

	it("leaves the document and an active job unchanged when SRT validation fails", async () => {
		const held = deferred();
		let signal: AbortSignal | undefined;
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string, options: { signal?: AbortSignal }) => {
				signal = options.signal;
				await held.promise;
				return transcriptFor(assetId);
			},
		);
		loadDocument(makeDoc(["asset_1"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		const before = useProjectStore.getState().document;
		const job = useTranscriptionStore.getState().jobs.asset_1;
		await expect(
			useTranscriptionStore.getState().importSrt("asset_1", "invalid"),
		).rejects.toThrow();
		expect(useProjectStore.getState().document).toBe(before);
		expect(useTranscriptionStore.getState().jobs.asset_1).toBe(job);
		expect(signal?.aborted).toBe(false);
		expect(bridgeMocks.save).not.toHaveBeenCalled();
		held.release();
		await whenTranscriptionIdle();
	});

	it("does not let a cancelled GMI response arriving late overwrite imported subtitles", async () => {
		const held = deferred();
		let signal: AbortSignal | undefined;
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string, options: { signal?: AbortSignal }) => {
				signal = options.signal;
				await held.promise;
				// A provider can resolve despite the cancellation request.
				return transcriptFor(assetId);
			},
		);
		loadDocument(makeDoc(["asset_1"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await useTranscriptionStore
			.getState()
			.importSrt("asset_1", "1\n00:00:00,200 --> 00:00:02,300\n保留匯入字幕");
		expect(signal?.aborted).toBe(true);
		held.release();
		await whenTranscriptionIdle();
		expect(useProjectStore.getState().document?.transcript?.words[0].text).toBe("保留匯入字幕");
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
	});

	it("waits for an old STT save already in flight, then installs imported subtitles", async () => {
		const saving = deferred();
		bridgeMocks.save.mockImplementationOnce(async (document: AxcutDocument) => {
			await saving.promise;
			return { success: true, document };
		});
		transcribeMocks.transcribeAsset.mockImplementation(async () => transcriptFor("asset_1"));
		loadDocument(makeDoc(["asset_1"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		const imported = useTranscriptionStore
			.getState()
			.importSrt("asset_1", "1\n00:00:00,000 --> 00:00:01,000\n新字幕");
		saving.release();
		await imported;
		await whenTranscriptionIdle();
		expect(useProjectStore.getState().document?.transcript?.words[0].text).toBe("新字幕");
		expect(bridgeMocks.save).toHaveBeenCalledTimes(2);
	});

	it("replaces only the queued target and preserves unrelated jobs and their results", async () => {
		const firstRun = deferred();
		const importSave = deferred();
		let otherSignal: AbortSignal | undefined;
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string, options: { signal?: AbortSignal }) => {
				if (assetId === "asset_1") {
					otherSignal = options.signal;
					await firstRun.promise;
				}
				return transcriptFor(assetId);
			},
		);
		bridgeMocks.save.mockImplementationOnce(async (document: AxcutDocument) => {
			await importSave.promise;
			return { success: true, document };
		});
		loadDocument(makeDoc(["asset_1", "asset_2", "asset_3"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		const imported = useTranscriptionStore
			.getState()
			.importSrt("asset_2", "1\n00:00:00,000 --> 00:00:01,000\n指定第二支字幕");
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		// sync must not re-enqueue asset_2 while its import is being saved.
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		firstRun.release();
		await Promise.resolve();
		expect(otherSignal?.aborted).toBe(false);
		importSave.release();
		await imported;
		await whenTranscriptionIdle();
		expect(transcribeMocks.transcribeAsset.mock.calls.map((call) => call[1])).toEqual([
			"asset_1",
			"asset_3",
		]);
		const transcripts = useProjectStore.getState().document?.transcripts;
		expect(transcripts?.map((t) => t.assetId).sort()).toEqual(["asset_1", "asset_2", "asset_3"]);
		expect(transcripts?.find((t) => t.assetId === "asset_2")?.words[0].text).toBe("指定第二支字幕");
	});

	it("does not replace a previous transcript when persisting the import fails", async () => {
		const previous = transcriptFor("asset_1");
		loadDocument({ ...makeDoc(["asset_1"]), transcript: previous, transcripts: [previous] });
		bridgeMocks.save.mockResolvedValueOnce({ success: false, error: "read-only project" });
		await expect(
			useTranscriptionStore
				.getState()
				.importSrt("asset_1", "00:00:00,000 --> 00:00:01,000\n新字幕"),
		).rejects.toThrow(/saved/);
		expect(useProjectStore.getState().document?.transcript).toEqual(previous);
		expect(past).toHaveLength(0);
	});

	it.each([
		"import",
		"edit",
	] as const)("keeps imported subtitles and a concurrent title edit when %s responds first", async (firstResponse) => {
		const importSave = deferred();
		const editSave = deferred();
		bridgeMocks.save
			.mockImplementationOnce(async (document: AxcutDocument) => {
				await importSave.promise;
				return { success: true, document };
			})
			.mockImplementationOnce(async (document: AxcutDocument) => {
				await editSave.promise;
				return { success: true, document };
			});
		loadDocument(makeDoc(["asset_1"]));
		const imported = useTranscriptionStore
			.getState()
			.importSrt("asset_1", "00:00:00,000 --> 00:00:01,000\n不能遺失的字幕");
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		const current = useProjectStore.getState().document;
		expect(current?.transcript?.words[0].text).toBe("不能遺失的字幕");
		if (!current) throw new Error("Expected optimistic import document");
		const edited = { ...current, project: { ...current.project, title: "New title" } };
		const edit = useProjectStore.getState().saveDocument(edited, { history: true });
		if (firstResponse === "import") {
			importSave.release();
			await imported;
			editSave.release();
			await edit;
		} else {
			editSave.release();
			await edit;
			importSave.release();
			await imported;
		}
		const final = useProjectStore.getState().document;
		expect(final?.project.title).toBe("New title");
		expect(final?.transcript?.words[0].text).toBe("不能遺失的字幕");
		expect(bridgeMocks.save.mock.calls[1][0].transcript.words[0].text).toBe("不能遺失的字幕");
		expect(past).toHaveLength(2);
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Test");
		expect(useProjectStore.getState().document?.transcript?.words[0].text).toBe("不能遺失的字幕");
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.transcript).toBeNull();
		expect(redo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Test");
		expect(useProjectStore.getState().document?.transcript?.words[0].text).toBe("不能遺失的字幕");
		expect(redo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("New title");
		expect(useProjectStore.getState().document?.transcript?.words[0].text).toBe("不能遺失的字幕");
	});

	it("preserves concurrent edits rather than rolling them back when import saving fails", async () => {
		const held = deferred();
		bridgeMocks.save.mockImplementationOnce(async () => {
			await held.promise;
			return { success: false, error: "EACCES" };
		});
		loadDocument(makeDoc(["asset_1"]));
		const imported = useTranscriptionStore
			.getState()
			.importSrt("asset_1", "00:00:00,000 --> 00:00:01,000\n匯入的字幕");
		const rejected = expect(imported).rejects.toThrow(/saved/);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		const current = useProjectStore.getState().document;
		if (!current) throw new Error("Expected optimistic import document");
		const edit = { ...current, project: { ...current.project, title: "Unsaved user title" } };
		useProjectStore.getState().setDocument(edit, { history: true });
		held.release();
		await rejected;
		expect(useProjectStore.getState().document).toBe(edit);
		expect(useProjectStore.getState().dirty).toBe(true);
		expect(past).toHaveLength(1); // only the title edit, not the failed import
	});

	it("does not install an import reply or add history after the user undid during saving", async () => {
		const held = deferred();
		bridgeMocks.save.mockImplementationOnce(async (document: AxcutDocument) => {
			await held.promise;
			return { success: true, document };
		});
		loadDocument(makeDoc(["asset_1"]));
		const initial = useProjectStore.getState().document;
		if (!initial) throw new Error("Expected current document");
		useProjectStore
			.getState()
			.setDocument(
				{ ...initial, project: { ...initial.project, title: "Before import" } },
				{ history: true },
			);
		const imported = useTranscriptionStore
			.getState()
			.importSrt("asset_1", "00:00:00,000 --> 00:00:01,000\n待存字幕");
		const rejected = expect(imported).rejects.toThrow(/saved/);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		expect(undo()).toBe(true);
		held.release();
		await rejected;
		expect(useProjectStore.getState().document?.project.title).toBe("Test");
		expect(useProjectStore.getState().document?.transcript).toBeNull();
		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);
	});

	it("does not install an old import or add history after a project switch", async () => {
		const held = deferred();
		bridgeMocks.save.mockImplementationOnce(async (document: AxcutDocument) => {
			await held.promise;
			return { success: true, document };
		});
		loadDocument(makeDoc(["asset_1"]));
		const imported = useTranscriptionStore
			.getState()
			.importSrt("asset_1", "00:00:00,000 --> 00:00:01,000\n舊專案字幕");
		const rejected = expect(imported).rejects.toThrow(/saved/);
		await vi.waitFor(() => expect(bridgeMocks.save).toHaveBeenCalledTimes(1));
		useProjectStore.getState().clear();
		loadDocument(makeDoc(["new_asset"], "proj_2"));
		held.release();
		await rejected;
		expect(useProjectStore.getState().document?.project.id).toBe("proj_2");
		expect(useProjectStore.getState().document?.transcript).toBeNull();
		expect(past).toHaveLength(0);
		expect(future).toHaveLength(0);
	});

	it("does not auto-enqueue at startup while the public settings snapshot is unknown", async () => {
		let resolveSettings: (value: {
			provider: "gmi";
			cloudConsent: boolean;
			autoTranscribe: boolean;
			hasApiKey: boolean;
		}) => void = () => undefined;
		const getSettings = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveSettings = resolve;
				}),
		);
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { stt: { getSettings, transcribe: vi.fn() } },
		});
		const existing = transcriptFor("asset_1");
		loadDocument({
			...makeDoc(["asset_1", "asset_2"]),
			transcript: existing,
			transcripts: [existing],
		});
		renderHook(() => useAutoTranscription());
		expect(getSettings).toHaveBeenCalledTimes(1);
		expect(useTranscriptionStore.getState().jobs).toEqual({});
		expect(transcribeMocks.transcribeAsset).not.toHaveBeenCalled();
		await act(async () => {
			resolveSettings({
				provider: "gmi",
				cloudConsent: true,
				autoTranscribe: false,
				hasApiKey: true,
			});
		});
		await waitFor(() => expect(useTranscriptionStore.getState().autoTranscribe).toBe(false));
		const current = useProjectStore.getState().document;
		if (!current) throw new Error("Expected current document");
		act(() => {
			useProjectStore
				.getState()
				.setDocument(
					{ ...current, project: { ...current.project, title: "Metadata changed" } },
					{ history: false },
				);
		});
		expect(useProjectStore.getState().document?.transcripts).toEqual([existing]);
		expect(useProjectStore.getState().document?.transcript).toEqual(existing);
		expect(useTranscriptionStore.getState().jobs).toEqual({});
		expect(transcribeMocks.transcribeAsset).not.toHaveBeenCalled();
	});

	it("cancels automatic jobs when disabled but lets a queued manual job finish", async () => {
		const held = deferred();
		let automaticSignal: AbortSignal | undefined;
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string, options: { signal?: AbortSignal }) => {
				if (assetId === "asset_1") {
					automaticSignal = options.signal;
					await held.promise;
				}
				return transcriptFor(assetId);
			},
		);
		loadDocument(makeDoc(["asset_1", "asset_2", "asset_3"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document);
		const manual = useTranscriptionStore.getState().request("asset_2");
		useTranscriptionStore.getState().sync(useProjectStore.getState().document, false);
		expect(automaticSignal?.aborted).toBe(true);
		expect(useTranscriptionStore.getState().jobs).toMatchObject({
			asset_2: { status: "queued", manual: true },
		});
		expect(Object.keys(useTranscriptionStore.getState().jobs)).toEqual(["asset_2"]);
		held.release();
		await manual;
		await whenTranscriptionIdle();
		expect(transcribeMocks.transcribeAsset.mock.calls.map((call) => call[1])).toEqual([
			"asset_1",
			"asset_2",
		]);
		expect(useProjectStore.getState().document?.transcripts.map((t) => t.assetId)).toEqual([
			"asset_2",
		]);
	});

	it("does not cancel an explicitly requested running job when automatic transcription is off", async () => {
		const held = deferred();
		let manualSignal: AbortSignal | undefined;
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string, options: { signal?: AbortSignal }) => {
				manualSignal = options.signal;
				await held.promise;
				return transcriptFor(assetId);
			},
		);
		loadDocument(makeDoc(["asset_1"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document, false);
		const manual = useTranscriptionStore.getState().request("asset_1");
		useTranscriptionStore.getState().sync(useProjectStore.getState().document, false);
		expect(manualSignal?.aborted).toBe(false);
		expect(useTranscriptionStore.getState().jobs.asset_1).toMatchObject({
			status: "running",
			manual: true,
		});
		held.release();
		await manual;
	});

	it("can import external SRT offline with automatic transcription disabled", async () => {
		loadDocument(makeDoc(["asset_1"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document, false);
		await useTranscriptionStore
			.getState()
			.importSrt("asset_1", "00:00:00,000 --> 00:00:01,000\n自行轉錄的字幕");
		useTranscriptionStore.getState().sync(useProjectStore.getState().document, false);
		expect(useProjectStore.getState().document?.transcript?.words[0].text).toBe("自行轉錄的字幕");
		expect(transcribeMocks.transcribeAsset).not.toHaveBeenCalled();
		expect(useTranscriptionStore.getState().jobs).toEqual({});
	});

	it("enqueues missing transcripts when automatic transcription is enabled again", async () => {
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => transcriptFor(assetId),
		);
		loadDocument(makeDoc(["asset_1"]));
		useTranscriptionStore.getState().sync(useProjectStore.getState().document, false);
		expect(transcribeMocks.transcribeAsset).not.toHaveBeenCalled();
		useTranscriptionStore.getState().sync(useProjectStore.getState().document, true);
		await whenTranscriptionIdle();
		expect(transcribeMocks.transcribeAsset).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.transcripts).toHaveLength(1);
	});

	it("keeps automatic transcription available for legacy bridges without a settings reader", async () => {
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => transcriptFor(assetId),
		);
		loadDocument(makeDoc(["asset_1"]));
		renderHook(() => useAutoTranscription());
		await act(async () => whenTranscriptionIdle());
		expect(transcribeMocks.transcribeAsset).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.transcripts).toHaveLength(1);
	});

	it("reacts to a settings event enabling automatic transcription", async () => {
		const getSettings = vi.fn().mockResolvedValue({
			provider: "gmi",
			cloudConsent: true,
			autoTranscribe: false,
			hasApiKey: true,
		});
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { stt: { getSettings, transcribe: vi.fn() } },
		});
		transcribeMocks.transcribeAsset.mockImplementation(
			async (_doc: AxcutDocument, assetId: string) => transcriptFor(assetId),
		);
		loadDocument(makeDoc(["asset_1"]));
		renderHook(() => useAutoTranscription());
		await waitFor(() => expect(useTranscriptionStore.getState().autoTranscribe).toBe(false));
		expect(transcribeMocks.transcribeAsset).not.toHaveBeenCalled();
		getSettings.mockResolvedValue({
			provider: "gmi",
			cloudConsent: true,
			autoTranscribe: true,
			hasApiKey: true,
		});
		await act(async () => {
			window.dispatchEvent(new Event(TRANSCRIPTION_SETTINGS_CHANGED_EVENT));
		});
		await act(async () => whenTranscriptionIdle());
		expect(transcribeMocks.transcribeAsset).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.transcripts).toHaveLength(1);
	});
});
