// The two things `npm run i18n:check` cannot see in a tooltip string.
//
// It only compares key sets, so a locale that renames `{{language}}` or drops it passes, and at
// runtime shows the raw `{{raccourci}}` (or the untouched `{{language}}`). Nor does it look at
// length: a tooltip is capped at 260px wide and reads best in at most four lines. Add a key here
// when a tooltip (or the accessible name of an icon-only control) gets one.
//
// See technical-documentation/engineering/tooltips.md.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LOCALES_DIR = resolve(process.cwd(), "src/i18n/locales");
const MAX_LENGTH = 130;

const TOOLTIP_KEYS: Record<string, string[]> = {
	launch: [
		"tooltips.hideHUD",
		"tooltips.hideHUDTip",
		"tooltips.closeApp",
		"tooltips.restartRecording",
		"tooltips.cancelRecording",
		"tooltips.pauseRecording",
		"tooltips.resumeRecording",
		"tooltips.useVerticalTray",
		"tooltips.useHorizontalTray",
		"tooltips.changeSource",
		"tooltips.systemAudio",
		"tooltips.microphone",
		"tooltips.camera",
		"tooltips.openStudio",
		"tooltips.openNotes",
		"cursor.name",
		"cursor.editableTip",
		"cursor.systemTip",
		"recording.selectSource",
		"recording.systemPicker",
		"recording.start",
		"recording.stop",
		"languageWithName",
		"deviceSettings.title",
		"deviceSettings.close",
	],
	timeline: ["trails.zoomIn", "trails.zoomOut", "trails.zoomInCut", "trails.zoomOutCut"],
};

function read(locale: string, namespace: string, key: string): string {
	const file = JSON.parse(readFileSync(`${LOCALES_DIR}/${locale}/${namespace}.json`, "utf8"));
	const value = key.split(".").reduce((node, part) => node?.[part], file);
	if (typeof value !== "string") throw new Error(`${locale}/${namespace}: ${key} is not a string`);
	return value;
}

const placeholders = (text: string) =>
	[...text.matchAll(/\{\{\s*\w+\s*\}\}/g)].map((m) => m[0]).sort();
// en included: it is the source, and its own length is held to the same cap.
const locales = readdirSync(LOCALES_DIR);
const entries = Object.entries(TOOLTIP_KEYS).flatMap(([namespace, keys]) =>
	keys.map((key) => [namespace, key] as const),
);

describe("tooltip strings", () => {
	it.each(locales)("%s keeps the placeholders of en and stays short", (locale) => {
		const placeholderDrift: string[] = [];
		const tooLong: string[] = [];
		for (const [namespace, key] of entries) {
			const text = read(locale, namespace, key);
			const source = read("en", namespace, key);
			if (placeholders(text).join() !== placeholders(source).join()) {
				placeholderDrift.push(`${namespace}.${key}: ${text}`);
			}
			if (text.length > MAX_LENGTH) tooLong.push(`${namespace}.${key} (${text.length})`);
		}
		expect(placeholderDrift).toEqual([]);
		expect(tooLong).toEqual([]);
	});
});

// The long tail: the tips on the inspector switches and the Notes mirror button, and the
// tooltips reworded with them (the roundness range, the transcript word chips, the camera
// preview's name). A list of its own, so it changes apart from the one above.
const LONG_TAIL_KEYS: Record<string, string[]> = {
	settings: [
		"effects.depthOfFieldTip",
		"effects.roundnessFrameHelp",
		"cursor.autoHideTip",
		"cursor.model3dTip",
		"cursor.clickImpactTip",
		"layout.reactiveWebcamTip",
		"transcript.insertedWord",
		"transcript.correctedWord",
	],
	launch: ["tooltips.notesToolbar.mirrorTip"],
	editor: ["preview.webcamPreview"],
};
const longTailEntries = Object.entries(LONG_TAIL_KEYS).flatMap(([namespace, keys]) =>
	keys.map((key) => [namespace, key] as const),
);

describe("long-tail tooltip strings", () => {
	it.each(locales)("%s keeps the placeholders of en and stays short", (locale) => {
		const placeholderDrift: string[] = [];
		const tooLong: string[] = [];
		for (const [namespace, key] of longTailEntries) {
			const text = read(locale, namespace, key);
			const source = read("en", namespace, key);
			if (placeholders(text).join() !== placeholders(source).join()) {
				placeholderDrift.push(`${namespace}.${key}: ${text}`);
			}
			if (text.length > MAX_LENGTH) tooLong.push(`${namespace}.${key} (${text.length})`);
		}
		expect(placeholderDrift).toEqual([]);
		expect(tooLong).toEqual([]);
	});

	// A locale that copied the English would pass both checks above.
	it.each(locales.filter((locale) => locale !== "en"))("%s translates every key", (locale) => {
		const untranslated = longTailEntries
			.filter(([namespace, key]) => read(locale, namespace, key) === read("en", namespace, key))
			.map(([namespace, key]) => `${namespace}.${key}`);
		expect(untranslated).toEqual([]);
	});
});

// The editor's own block: the timeline toolbar and transport, the top bar, the inspector rail,
// Record mode and the chat. Kept apart from the list above so the two grow independently.
const EDITOR_TOOLTIP_KEYS: Record<string, string[]> = {
	timeline: [
		"buttons.addZoom",
		"buttons.addTrim",
		"buttons.addSpeed",
		"buttons.addAnnotation",
		"buttons.addCameraFullscreen",
		"buttons.autoFocusAll",
		"buttons.autoFocusAllTip",
		"buttons.clearTimeline",
		"toolbar.dragToReorderHint",
		"toolbar.editInOutPoints",
		"toolbar.deleteClip",
		"labels.panTip",
		"labels.zoomTip",
	],
	editor: [
		"transport.play",
		"transport.pause",
		"topbar.toggleChatPanel",
		"inspector.editClipTip",
		"rec.systemAudioTip",
		"rec.editableCursor",
		"rec.editableCursorTip",
		"rec.hideDesktopIconsHintMac",
		"rec.hideDesktopIconsHintWindows",
		"chat.contextTooltip",
		"chat.compactContext",
		"chat.aiSettings",
		"chat.history",
		"chat.newConversation",
		"chat.clickToRename",
		"chat.renameConversation",
		"chat.deleteConversation",
		"chat.rewindToMessage",
		"chat.rewindTip",
		"chat.copyMessage",
		"chat.send",
		"chat.composerDisabledNoProvider",
		"mediaStage.regenerate",
		"mediaStage.regenerateTip",
		"mediaStage.cpuBackendHint",
	],
	settings: [
		"facets.tips.effects",
		"facets.tips.layout",
		"facets.tips.audio",
		"facets.tips.cursor",
		"facets.tips.transcript",
		"audioTrack.slipHint",
	],
	shortcuts: ["fixedActions.undo", "fixedActions.redo"],
};
// Tooltips that end in a chip built from the user's live binding (formatBinding). A key written
// into the string would lie after a remap, and inside Arabic text it breaks the order of words.
const CHIP_KEYS: Record<string, string[]> = {
	timeline: [
		"buttons.addZoom",
		"buttons.addTrim",
		"buttons.addSpeed",
		"buttons.addAnnotation",
		"buttons.addCameraFullscreen",
	],
	editor: ["transport.play", "transport.pause", "chat.send"],
};
const editorEntries = Object.entries(EDITOR_TOOLTIP_KEYS).flatMap(([namespace, keys]) =>
	keys.map((key) => [namespace, key] as const),
);
const chipEntries = Object.entries(CHIP_KEYS).flatMap(([namespace, keys]) =>
	keys.map((key) => [namespace, key] as const),
);

describe("editor tooltip strings", () => {
	it.each(locales)("%s keeps the placeholders of en and stays short", (locale) => {
		const placeholderDrift: string[] = [];
		const tooLong: string[] = [];
		for (const [namespace, key] of editorEntries) {
			const text = read(locale, namespace, key);
			const source = read("en", namespace, key);
			if (placeholders(text).join() !== placeholders(source).join()) {
				placeholderDrift.push(`${namespace}.${key}: ${text}`);
			}
			if (text.length > MAX_LENGTH) tooLong.push(`${namespace}.${key} (${text.length})`);
		}
		expect(placeholderDrift).toEqual([]);
		expect(tooLong).toEqual([]);
	});

	it.each(locales)("%s writes no key into a tooltip that shows a shortcut chip", (locale) => {
		const bakedIn = chipEntries
			.map(([namespace, key]) => [`${namespace}.${key}`, read(locale, namespace, key)] as const)
			// "(Z)", "(Space)", "（Z）" and the like, in any script.
			.filter(([, text]) => /[(（]\s*(?:[A-Z]|Space|Enter|Ctrl[^)）]*)\s*[)）]/.test(text));
		expect(bakedIn).toEqual([]);
	});

	// French sets a no-break space before : ; ? !, so a tooltip never wraps with the mark starting
	// the next line ("Ajouter Caméra plein écran" / ": affiche ...").
	it("fr keeps punctuation with the word before it", () => {
		const loose = editorEntries
			.map(([namespace, key]) => [`${namespace}.${key}`, read("fr", namespace, key)] as const)
			.filter(([, text]) => / [:;?!]/.test(text));
		expect(loose).toEqual([]);
	});

	// One term per concept: the HUD's toggle and this row are the same setting.
	it.each(locales)("%s calls the Record mode cursor row what the HUD calls it", (locale) => {
		expect(read(locale, "editor", "rec.editableCursor")).toBe(
			read(locale, "launch", "cursor.name"),
		);
	});

	// Clear timeline has no confirmation, so its tooltip is where the loss is said: what goes
	// (Full Camera included) and what stays.
	it("says what Clear timeline removes and what it keeps", () => {
		const text = read("en", "timeline", "buttons.clearTimeline");
		for (const goes of ["zooms", "trims", "speeds", "annotations", "Full Camera"]) {
			expect(text).toContain(goes);
		}
		expect(text).toContain("Clips, audio and captions stay");
	});

	it.each(locales)("%s does not call the moving line on the timeline the playhead", (locale) => {
		// It is the word for the mouse cursor in pt-BR, ru and tr: the strings say "current time".
		const uses = editorEntries
			.map(([namespace, key]) => [`${namespace}.${key}`, read(locale, namespace, key)] as const)
			.filter(([, text]) => /playhead/i.test(text));
		expect(uses).toEqual([]);
	});
});
