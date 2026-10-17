import { describe, expect, it } from "vitest";
import { executeAgentTool } from "../../../electron/ai-edition/agent-tools";
import { buildSceneDescription } from "../../native/sceneDescription";
import { duplicateClip, removeClip } from "../ai-edition/document/timeline";
import { type AxcutDocument, createEmptyDocument, documentSchema } from "../ai-edition/schema";
import {
	buildKeystrokeTrack,
	coalesceKeystrokeSamplesToRegions,
	formatKeycapLabel,
	formatShortcutKeycaps,
	getKeystrokeTelemetryCandidates,
	isShortcutSample,
	normalizeKeyToken,
	parseShortcutKeys,
} from "./keystrokeTelemetry";

const FIXTURE_CREATED_AT = "2026-01-01T00:00:00.000Z";

function createTestDocument(): AxcutDocument {
	const base = createEmptyDocument({
		title: "Keystroke Test",
		projectId: "proj_keys",
		createdAt: FIXTURE_CREATED_AT,
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "Screen Recording",
				originalPath: "/recordings/demo.mp4",
				durationSec: 20,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 20,
					timelineStartSec: 0,
					timelineEndSec: 20,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			trimRanges: [
				{
					id: "trim_1",
					assetId: "asset_1",
					clipId: "clip_1",
					startSec: 8,
					endSec: 10,
					reason: "pause",
					origin: "user",
				},
			],
		},
	});
}

describe("keystrokeTelemetry helpers", () => {
	it("normalizes and parses shortcut key strings and arrays", () => {
		expect(normalizeKeyToken("command")).toBe("Cmd");
		expect(normalizeKeyToken("control")).toBe("Ctrl");
		expect(normalizeKeyToken("opt")).toBe("Option");
		expect(normalizeKeyToken("escape")).toBe("Esc");
		expect(normalizeKeyToken("f12")).toBe("F12");
		expect(normalizeKeyToken("k")).toBe("K");

		expect(parseShortcutKeys("cmd + shift + p")).toEqual(["Cmd", "Shift", "P"]);
		expect(parseShortcutKeys(["ctrl", "alt", "delete"])).toEqual(["Ctrl", "Alt", "Delete"]);
		expect(parseShortcutKeys("Cmd++")).toEqual(["Cmd", "+"]);
	});

	it("formats platform-specific keycap labels for macOS and Windows", () => {
		expect(formatShortcutKeycaps(["Cmd", "Shift", "P"], "darwin")).toEqual(["⌘", "⇧", "P"]);
		expect(formatShortcutKeycaps(["Option", "Backspace"], "darwin")).toEqual(["⌥", "⌫"]);
		expect(formatShortcutKeycaps(["Cmd", "Shift", "P"], "win32")).toEqual(["Ctrl", "Shift", "P"]);
		expect(formatKeycapLabel("Enter", "darwin")).toBe("↵");
		expect(formatKeycapLabel("Up", "win32")).toBe("↑");
	});

	it("distinguishes intentional shortcuts from plain typing for privacy safety", () => {
		expect(isShortcutSample({ timeMs: 1000, keys: ["Cmd", "K"] })).toBe(true);
		expect(isShortcutSample({ timeMs: 1200, keys: ["Ctrl", "Shift", "P"] })).toBe(true);
		expect(isShortcutSample({ timeMs: 1400, keys: ["F5"] })).toBe(true);
		expect(isShortcutSample({ timeMs: 1500, keys: ["Esc"] })).toBe(true);
		// Plain typing (letters, numbers, Shift+letter, Space, Backspace) must be ignored by default
		expect(isShortcutSample({ timeMs: 1600, keys: ["a"] })).toBe(false);
		expect(isShortcutSample({ timeMs: 1700, keys: ["Shift", "a"] })).toBe(true);
		expect(isShortcutSample({ timeMs: 1800, keys: ["Space"] })).toBe(false);
		expect(isShortcutSample({ timeMs: 1900, keys: ["Shift"] })).toBe(false);
		// Explicit override
		expect(isShortcutSample({ timeMs: 2000, keys: ["Space"], isShortcut: true })).toBe(true);
	});

	it("returns candidate sidecar paths for a video path", () => {
		const candidates = getKeystrokeTelemetryCandidates("/recordings/take-1.mp4");
		expect(candidates).toEqual([
			"/recordings/take-1.mp4.keys.json",
			"/recordings/take-1.keys.json",
		]);
		expect(getKeystrokeTelemetryCandidates("")).toEqual([]);
	});

	it("coalesces rapid repeated shortcuts and filters out prose keystrokes", () => {
		const spans = coalesceKeystrokeSamplesToRegions(
			[
				{ timeMs: 1000, keys: ["Cmd", "S"], label: "Save" },
				{ timeMs: 1300, keys: ["Cmd", "S"] }, // within 600ms merge window
				{ timeMs: 1500, keys: ["x"] }, // plain key — filtered out
				{ timeMs: 3000, keys: ["Cmd", "Shift", "P"], label: "Command Palette" },
			],
			{ holdMs: 1500, mergeWindowMs: 500 },
		);

		expect(spans).toEqual([
			{
				startMs: 1000,
				endMs: 2800,
				keys: "Cmd+S",
				label: "Save",
			},
			{
				startMs: 3000,
				endMs: 4500,
				keys: "Cmd+Shift+P",
				label: "Command Palette",
			},
		]);
	});

	it("projects recorded keystrokes onto the edited timeline and flags trimmed spans", () => {
		const doc = createTestDocument();
		const track = buildKeystrokeTrack(
			[
				{ timeMs: 2000, keys: ["Cmd", "K"], label: "Quick Open" },
				{ timeMs: 9000, keys: ["Cmd", "B"], label: "Toggle Sidebar" }, // inside trim 8..10s
			],
			doc.timeline.clips,
			doc.timeline.trimRanges,
			{ assetId: "asset_1" },
		);

		expect(track.assetId).toBe("asset_1");
		expect(track.eventCount).toBe(2);
		expect(track.events[0]).toMatchObject({
			atSec: 2,
			virtualSec: 2,
			keys: "Cmd+K",
			label: "Quick Open",
			isShortcut: true,
		});
		expect(track.events[1]).toMatchObject({
			atSec: 9,
			virtualSec: 9,
			keys: "Cmd+B",
			trimmed: true,
		});
	});
});

describe("keystrokeRanges document & agent tool integration", () => {
	it("adds, updates, projects, duplicates, and removes keystroke HUD callouts", () => {
		const doc = createTestDocument();

		const added = executeAgentTool(
			doc,
			"addKeystroke",
			JSON.stringify({
				startSec: 2,
				endSec: 4,
				keys: ["Cmd", "Shift", "P"],
				label: "Command Palette",
				position: "bottom-center",
				theme: "glass",
				size: "lg",
				platform: "darwin",
			}),
		);
		expect(added.ok).toBe(true);
		const addedDoc = added.document as AxcutDocument;
		expect(addedDoc.keystrokeRanges).toHaveLength(1);
		const keystrokeId = addedDoc.keystrokeRanges?.[0]?.id ?? "";

		// Verify sceneDescription projection
		const scene = buildSceneDescription(addedDoc);
		expect(scene.keystrokeRegions).toHaveLength(1);
		expect(scene.keystrokeRegions?.[0]).toMatchObject({
			id: keystrokeId,
			startSec: 2,
			endSec: 4,
			keys: "Cmd+Shift+P",
			label: "Command Palette",
			position: "bottom-center",
			theme: "glass",
			size: "lg",
			platform: "darwin",
		});

		// Update via setKeystroke
		const updated = executeAgentTool(
			addedDoc,
			"setKeystroke",
			JSON.stringify({
				keystrokeId,
				startSec: 3,
				endSec: 5.5,
				keys: ["Cmd", "K"],
				label: "Search",
				position: "top-right",
			}),
		);
		expect(updated.ok).toBe(true);
		const updatedDoc = updated.document as AxcutDocument;
		expect(updatedDoc.keystrokeRanges?.[0]).toMatchObject({
			startMs: 3000,
			endMs: 5500,
			keys: "Cmd+K",
			label: "Search",
			position: "top-right",
			theme: "glass",
		});

		// Verify getCurrentDocument includes keystrokeRanges
		const snapshotExec = executeAgentTool(updatedDoc, "getCurrentDocument", "{}");
		expect(snapshotExec.ok).toBe(true);
		const snapshot = JSON.parse(snapshotExec.resultJson);
		expect(snapshot.keystrokeRanges).toHaveLength(1);
		expect(snapshot.keystrokeRanges[0]).toMatchObject({
			id: updatedDoc.keystrokeRanges?.[0]?.id,
			startSec: 3,
			endSec: 5.5,
			keys: "Cmd+K",
			label: "Search",
		});

		// Duplicating a clip copies its anchored keystroke ranges
		const duplicated = duplicateClip(updatedDoc, "clip_1");
		expect(duplicated.keystrokeRanges).toHaveLength(2);

		// Removing a clip drops its anchored keystroke ranges
		const afterClipRemoved = removeClip(duplicated, "clip_1");
		expect(afterClipRemoved.keystrokeRanges).toHaveLength(1);

		// Removing via removeModifier
		const remainingId = afterClipRemoved.keystrokeRanges?.[0]?.id ?? "";
		const removed = executeAgentTool(
			afterClipRemoved,
			"removeModifier",
			JSON.stringify({ id: remainingId }),
		);
		expect(removed.ok).toBe(true);
		expect(removed.document?.keystrokeRanges).toHaveLength(0);
	});
});
