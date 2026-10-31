// The in-app recorder against stand-ins for the app: the HUD's signals are called by
// hand, and the editor is a document behind a revision.

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import {
	type AppRecorderDeps,
	createAppRecorder,
	pickTakePrefs,
	type TakePrefs,
	takePrefs,
} from "./app-recorder";
import type { McpApplyResult } from "./openscreen-mcp-server";

const VIDEO = path.resolve("recordings", "take.webm");
const FAST = { startMs: 200, saveMs: 200, openMs: 400, pollMs: 5, settleMs: 20 };
const REQUEST = {
	displayIndex: 0,
	windowTitle: "My App",
	mic: false,
	micDevice: null,
	systemAudio: false,
	camera: false,
	cameraDevice: null,
	cursorMode: "editable-overlay" as const,
};

/** The editor's project for the take: `clipEndSec` 60 is the placeholder it starts with. */
function takeDocument(clipEndSec: number, zooms = 0): AxcutDocument {
	const base = createEmptyDocument({ title: "Recording 1", projectId: "proj_take" });
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [{ id: "asset_1", kind: "video", label: "take", originalPath: VIDEO, durationSec: 12 }],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: clipEndSec,
					timelineStartSec: 0,
					timelineEndSec: clipEndSec,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
		zoomRanges: Array.from({ length: zooms }, (_, i) => ({
			id: `zoom_${i}`,
			startMs: 3_000 + i * 4_000,
			endMs: 5_000 + i * 4_000,
			clipId: "clip_1",
			sourceStartSec: 3 + i * 4,
			sourceEndSec: 5 + i * 4,
			depth: 3,
			focus: { cx: 0.5, cy: 0.5 },
			focusMode: "manual",
			source: "manual",
		})),
	});
}

function setup(overrides: Partial<AppRecorderDeps> = {}) {
	const calls: string[] = [];
	const editor = {
		document: null as AxcutDocument | null,
		revision: 0,
		applied: [] as AxcutDocument[],
	};
	const recorder = createAppRecorder({
		isRecording: () => false,
		editorHasUnsavedChanges: () => false,
		prepare: async (request) => {
			calls.push(`prepare ${request.windowTitle}`);
			return () => calls.push("restore");
		},
		startTake: () => calls.push("startTake"),
		stopTake: () => calls.push("stopTake"),
		host: {
			snapshot: async () =>
				editor.document ? { document: editor.document, revision: editor.revision } : null,
			apply: async (document, revision): Promise<McpApplyResult> => {
				if (revision !== editor.revision) return "conflict";
				editor.applied.push(document);
				editor.document = document;
				editor.revision++;
				return "applied";
			},
		},
		timing: FAST,
		...overrides,
	});
	return { recorder, calls, editor };
}

/** A take started as the app would: the HUD reports it recording once it was handed over. */
async function started(recorder: ReturnType<typeof setup>["recorder"], calls: string[]) {
	const handedOver = calls.filter((call) => call === "startTake").length;
	const starting = recorder.start(REQUEST);
	while (calls.filter((call) => call === "startTake").length === handedOver) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	recorder.recordingChanged(true);
	return starting;
}

describe("an MCP take in the app", () => {
	it("goes through the recording bar, and hands back the project the editor opened", async () => {
		const { recorder, calls, editor } = setup();
		const starting = recorder.start(REQUEST);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(calls).toEqual(["prepare My App", "startTake"]);
		recorder.recordingChanged(true);
		const take = await starting;
		expect(take.startedAt).toBeGreaterThan(0);

		const stopping = take.stop("Demo");
		expect(calls.at(-1)).toBe("stopTake");
		recorder.recordingChanged(false);
		// The take is captured: the user's settings are back before it saves.
		expect(calls.at(-1)).toBe("restore");
		recorder.takeSaved(VIDEO);
		// The editor lays it out in steps: first the placeholder clip, then the measured one.
		editor.document = takeDocument(60);
		await new Promise((resolve) => setTimeout(resolve, 40));
		editor.document = takeDocument(12, 2);
		editor.revision = 3;

		expect(await stopping).toEqual({
			projectId: "proj_take",
			videoPath: VIDEO,
			durationSec: 12,
			autoZooms: 2,
		});
		// The title, through the editor like any change to the open project.
		expect(editor.applied.map((document) => document.project.title)).toEqual(["Demo"]);
		expect(calls.filter((call) => call === "restore")).toHaveLength(1);
	});

	it("returns a take the user stopped by hand, without pressing Stop again", async () => {
		const { recorder, calls, editor } = setup();
		const take = await started(recorder, calls);
		recorder.recordingChanged(false);
		recorder.takeSaved(VIDEO);
		editor.document = takeDocument(12);
		const recorded = await take.stop(undefined);
		expect(recorded.projectId).toBe("proj_take");
		expect(calls).not.toContain("stopTake");
		expect(editor.applied).toEqual([]);
	});

	it("refuses a take while one records, or while the editor holds unsaved changes", async () => {
		const busy = setup({ isRecording: () => true });
		await expect(busy.recorder.start(REQUEST)).rejects.toThrow("already recording");
		const unsaved = setup({ editorHasUnsavedChanges: () => true });
		await expect(unsaved.recorder.start(REQUEST)).rejects.toThrow("not saved");
		expect([...busy.calls, ...unsaved.calls]).toEqual([]);
	});

	it("gives up on a take that never starts, puts the settings back, and leaves a late one to the user", async () => {
		const { recorder, calls } = setup();
		await expect(recorder.start(REQUEST)).rejects.toThrow("had not started");
		expect(calls).toEqual(["prepare My App", "startTake", "restore"]);
		// The user's own take, started from the bar afterwards: nothing here claims it.
		recorder.recordingChanged(true);
		recorder.recordingChanged(false);
		expect(calls).toHaveLength(3);
		// And the next client take may start.
		await expect(started(recorder, calls)).resolves.toMatchObject({
			startedAt: expect.any(Number),
		});
	});

	it("says where the take is when the editor never opens it", async () => {
		const { recorder, calls } = setup();
		const take = await started(recorder, calls);
		recorder.recordingChanged(false);
		recorder.takeSaved(VIDEO);
		await expect(take.stop(undefined)).rejects.toThrow(`saved to ${VIDEO}`);
	});

	it("fails a take the bar never hands over", async () => {
		const { recorder, calls } = setup();
		const take = await started(recorder, calls);
		await expect(take.stop(undefined)).rejects.toThrow("The recording failed");
		// Released: the next take may start.
		await expect(started(recorder, calls)).resolves.toBeDefined();
	});
});

describe("the recording bar's settings for a client's take", () => {
	const listed = {
		displays: [],
		windows: [],
		microphones: [{ label: "USB Mic", deviceId: "mic-1" }],
		microphoneLabelsUnavailable: false,
		cameras: [{ label: "Logitech BRIO", deviceId: "cam-1" }],
		cameraLabelsUnavailable: false,
	};

	it("records the camera and the cursor mode asked for, a named device by its id and name", () => {
		expect(
			takePrefs(
				{ ...REQUEST, mic: true, camera: true, cameraDevice: "brio", cursorMode: "system" },
				listed,
			),
		).toEqual({
			micEnabled: true,
			micDeviceId: null,
			micDeviceName: null,
			camEnabled: true,
			camDeviceId: "cam-1",
			camDeviceName: "Logitech BRIO",
			systemAudioEnabled: false,
			cursorCaptureMode: "system",
			cameraOnly: false,
		});
	});

	it("turns off what the request leaves out, the user's camera included", () => {
		expect(takePrefs(REQUEST, null)).toMatchObject({ micEnabled: false, camEnabled: false });
	});

	// getopenscreen/openscreen#1398: a client asks for a screen, window or display, so a
	// camera only left on in the bar is off for its take, and comes back with the rest.
	it("records a screen even when the user left camera only on", () => {
		expect(takePrefs({ ...REQUEST, camera: true }, null).cameraOnly).toBe(false);
		const user = { ...takePrefs({ ...REQUEST, camera: true }, null), cameraOnly: true };
		expect(pickTakePrefs(user).cameraOnly).toBe(true);
	});

	it("refuses a device no listed name contains", () => {
		expect(() => takePrefs({ ...REQUEST, camera: true, cameraDevice: "Facetime" }, listed)).toThrow(
			`No camera's name contains "Facetime"`,
		);
		expect(() => takePrefs({ ...REQUEST, mic: true, micDevice: "Yeti" }, null)).toThrow(
			"No microphone's name",
		);
	});

	it("puts back exactly the settings a take changes", () => {
		const user: TakePrefs & { hideDesktopIcons: boolean } = {
			...takePrefs({ ...REQUEST, camera: true }, null),
			hideDesktopIcons: true,
		};
		expect(pickTakePrefs(user)).toEqual(takePrefs({ ...REQUEST, camera: true }, null));
	});
});
