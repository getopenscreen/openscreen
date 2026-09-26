/**
 * GENERATED FILE — do not edit. Run `node scripts/gen-recreation.mjs` instead.
 *
 * Every value below was read out of, or computed from, one of:
 *   · src/components/Recreation/fixture-slim.json (the project document, schemaVersion 7)
 *   · ../src/i18n/locales/en/{editor,settings,timeline}.json
 *   · ../src/lib/ai-edition/timeline/{format,zoom-scale,aggregated-transcript}.ts, imported and run
 *   · ../src/components/ai-edition/v4/V4Timeline.tsx, lifted as source text and evaluated
 *   · ../src/styles/design-tokens.css
 *   · static/img/walkthrough/04-agent-a.jpg and editor-1560.jpg (two strings; see PROVENANCE)
 *
 * PROVENANCE names the source of every string this file puts on screen. Nothing
 * that could not be sourced was invented to fill a gap: the chat's context pill
 * is absent for that reason, and so is the webcam bubble.
 */

export interface RecreationWord {
	i: number;
	id: string;
	kind: "word" | "silence";
	text: string;
	startSec: number;
	endSec: number;
	kept: boolean;
	trimId: string | null;
}

export interface RecreationPill {
	lane: string;
	id: string;
	label: string;
	startSec: number;
	endSec: number;
	leftPct: number;
	widthPct: number;
	/** zoom lanes only — the stored ordinal the label was derived from. */
	depth?: number;
	/** zoom lanes only. */
	focusMode?: string;
	/** trim lanes only — "agent" for the two the agent placed. */
	origin?: string;
}

export interface RecreationLane {
	id: string;
	hint: string | null;
	pills: RecreationPill[];
}

export interface ProvenanceEntry {
	shown: string;
	source: string;
}

/** Where this data came from, and what it is a recreation of. */
export const META = {
	schemaVersion: 7,
	projectId: "proj_97e2ec4f-78a1-4198-9743-05511c204daa",
	projectTitle: "Bellrock — docs walkthrough",
	assetLabel: "Bellrock — docs walkthrough",
	assetDurationSec: 40.033,
	assetVideo: {
		codec: "unknown",
		width: 1920,
		height: 1080,
		fps: 0,
	},
	cameraTrackVisible: false,
	generator: "website/scripts/gen-recreation.mjs",
} as const;

/** The transcript pane's header. */
export const INSPECTOR = {
	title: "Transcript",
	indexBadge: "1",
	filename: "Bellrock — docs walkthrough",
	clipRange: "Clip 1 · 0:00.0—0:40.0",
	wordCount: 103,
	silenceCount: 3,
	silenceThresholdSec: 0.2,
} as const;

/**
 * The transcript flow, produced by the app's own `buildClipSection`: 103
 * words and 3 silence markers, each tagged kept or removed against the
 * document's two agent trims. 2 entries are removed, all of them silences.
 */
export const WORDS: RecreationWord[] = [
	{ i: 0, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:silence_1", kind: "silence", text: "[silence 2.2s]", startSec: 0, endSec: 2.19, kept: false, trimId: "trim_f52989cf-489c-47f5-a6c7-b95a7d71b399" },
	{ i: 1, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_1", kind: "word", text: "Hi,", startSec: 2.19, endSec: 2.63, kept: true, trimId: null },
	{ i: 2, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_2", kind: "word", text: "quick", startSec: 2.63, endSec: 3.02, kept: true, trimId: null },
	{ i: 3, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_3", kind: "word", text: "walk", startSec: 3.02, endSec: 3.08, kept: true, trimId: null },
	{ i: 4, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_4", kind: "word", text: "through", startSec: 3.08, endSec: 3.29, kept: true, trimId: null },
	{ i: 5, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_5", kind: "word", text: "the", startSec: 3.29, endSec: 3.95, kept: true, trimId: null },
	{ i: 6, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_6", kind: "word", text: "documentation", startSec: 3.95, endSec: 4.62, kept: true, trimId: null },
	{ i: 7, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_7", kind: "word", text: "site.", startSec: 4.62, endSec: 4.94, kept: true, trimId: null },
	{ i: 8, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_8", kind: "word", text: "The", startSec: 4.94, endSec: 5.2, kept: true, trimId: null },
	{ i: 9, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_9", kind: "word", text: "new", startSec: 5.2, endSec: 5.5200000000000005, kept: true, trimId: null },
	{ i: 10, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_10", kind: "word", text: "release", startSec: 5.5200000000000005, endSec: 5.62, kept: true, trimId: null },
	{ i: 11, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_11", kind: "word", text: "went", startSec: 5.62, endSec: 5.79, kept: true, trimId: null },
	{ i: 12, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_12", kind: "word", text: "out", startSec: 5.79, endSec: 6.01, kept: true, trimId: null },
	{ i: 13, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_13", kind: "word", text: "this", startSec: 6.01, endSec: 6.47, kept: true, trimId: null },
	{ i: 14, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_14", kind: "word", text: "morning.", startSec: 6.47, endSec: 6.82, kept: true, trimId: null },
	{ i: 15, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_15", kind: "word", text: "The", startSec: 6.83, endSec: 7.2, kept: true, trimId: null },
	{ i: 16, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_16", kind: "word", text: "hero", startSec: 7.2, endSec: 7.37, kept: true, trimId: null },
	{ i: 17, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_17", kind: "word", text: "does", startSec: 7.37, endSec: 7.57, kept: true, trimId: null },
	{ i: 18, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_18", kind: "word", text: "the", startSec: 7.57, endSec: 7.88, kept: true, trimId: null },
	{ i: 19, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_19", kind: "word", text: "work", startSec: 7.88, endSec: 8.16, kept: true, trimId: null },
	{ i: 20, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_20", kind: "word", text: "now.", startSec: 8.16, endSec: 8.58, kept: true, trimId: null },
	{ i: 21, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_21", kind: "word", text: "One", startSec: 8.58, endSec: 9.06, kept: true, trimId: null },
	{ i: 22, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_22", kind: "word", text: "line,", startSec: 9.06, endSec: 9.5, kept: true, trimId: null },
	{ i: 23, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_23", kind: "word", text: "one", startSec: 9.5, endSec: 10.040000000000001, kept: true, trimId: null },
	{ i: 24, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_24", kind: "word", text: "promise,", startSec: 10.040000000000001, endSec: 10.41, kept: true, trimId: null },
	{ i: 25, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_25", kind: "word", text: "and", startSec: 10.41, endSec: 10.6, kept: true, trimId: null },
	{ i: 26, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_26", kind: "word", text: "the", startSec: 10.6, endSec: 10.950000000000001, kept: true, trimId: null },
	{ i: 27, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_27", kind: "word", text: "install", startSec: 10.950000000000001, endSec: 11.21, kept: true, trimId: null },
	{ i: 28, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_28", kind: "word", text: "command", startSec: 11.21, endSec: 11.61, kept: true, trimId: null },
	{ i: 29, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_29", kind: "word", text: "right", startSec: 11.61, endSec: 11.97, kept: true, trimId: null },
	{ i: 30, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_30", kind: "word", text: "under", startSec: 11.97, endSec: 12.290000000000001, kept: true, trimId: null },
	{ i: 31, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_31", kind: "word", text: "it.", startSec: 12.290000000000001, endSec: 12.68, kept: true, trimId: null },
	{ i: 32, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_32", kind: "word", text: "Scrolling", startSec: 12.68, endSec: 13.25, kept: true, trimId: null },
	{ i: 33, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_33", kind: "word", text: "down,", startSec: 13.25, endSec: 13.63, kept: true, trimId: null },
	{ i: 34, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_34", kind: "word", text: "those", startSec: 13.63, endSec: 14.02, kept: true, trimId: null },
	{ i: 35, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_35", kind: "word", text: "six", startSec: 14.02, endSec: 14.4, kept: true, trimId: null },
	{ i: 36, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_36", kind: "word", text: "cards", startSec: 14.4, endSec: 14.450000000000001, kept: true, trimId: null },
	{ i: 37, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_37", kind: "word", text: "are", startSec: 14.450000000000001, endSec: 14.620000000000001, kept: true, trimId: null },
	{ i: 38, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_38", kind: "word", text: "the", startSec: 14.620000000000001, endSec: 14.77, kept: true, trimId: null },
	{ i: 39, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_39", kind: "word", text: "whole", startSec: 14.77, endSec: 15.21, kept: true, trimId: null },
	{ i: 40, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_40", kind: "word", text: "library", startSec: 15.21, endSec: 15.530000000000001, kept: true, trimId: null },
	{ i: 41, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_41", kind: "word", text: "on", startSec: 15.530000000000001, endSec: 15.75, kept: true, trimId: null },
	{ i: 42, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_42", kind: "word", text: "one", startSec: 15.75, endSec: 16.13, kept: true, trimId: null },
	{ i: 43, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_43", kind: "word", text: "screen.", startSec: 16.13, endSec: 16.62, kept: true, trimId: null },
	{ i: 44, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_44", kind: "word", text: "No", startSec: 16.82, endSec: 16.93, kept: true, trimId: null },
	{ i: 45, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_45", kind: "word", text: "page", startSec: 16.93, endSec: 17.37, kept: true, trimId: null },
	{ i: 46, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_46", kind: "word", text: "gets", startSec: 17.37, endSec: 17.62, kept: true, trimId: null },
	{ i: 47, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_47", kind: "word", text: "more", startSec: 17.62, endSec: 17.7, kept: true, trimId: null },
	{ i: 48, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_48", kind: "word", text: "than", startSec: 17.7, endSec: 17.96, kept: true, trimId: null },
	{ i: 49, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_49", kind: "word", text: "a", startSec: 17.96, endSec: 18.18, kept: true, trimId: null },
	{ i: 50, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_50", kind: "word", text: "sentence.", startSec: 18.18, endSec: 18.93, kept: true, trimId: null },
	{ i: 51, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_51", kind: "word", text: "Over", startSec: 18.93, endSec: 19.07, kept: true, trimId: null },
	{ i: 52, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_52", kind: "word", text: "on", startSec: 19.07, endSec: 19.56, kept: true, trimId: null },
	{ i: 53, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_53", kind: "word", text: "status,", startSec: 19.56, endSec: 20.17, kept: true, trimId: null },
	{ i: 54, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_54", kind: "word", text: "every", startSec: 20.17, endSec: 20.650000000000002, kept: true, trimId: null },
	{ i: 55, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_55", kind: "word", text: "component", startSec: 20.650000000000002, endSec: 21.06, kept: true, trimId: null },
	{ i: 56, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_56", kind: "word", text: "with", startSec: 21.06, endSec: 21.31, kept: true, trimId: null },
	{ i: 57, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_57", kind: "word", text: "30", startSec: 21.31, endSec: 21.490000000000002, kept: true, trimId: null },
	{ i: 58, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_58", kind: "word", text: "days", startSec: 21.490000000000002, endSec: 21.82, kept: true, trimId: null },
	{ i: 59, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_59", kind: "word", text: "of", startSec: 21.82, endSec: 21.91, kept: true, trimId: null },
	{ i: 60, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_60", kind: "word", text: "probes", startSec: 21.91, endSec: 22.36, kept: true, trimId: null },
	{ i: 61, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_61", kind: "word", text: "behind", startSec: 22.36, endSec: 22.740000000000002, kept: true, trimId: null },
	{ i: 62, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_62", kind: "word", text: "it.", startSec: 22.740000000000002, endSec: 23.05, kept: true, trimId: null },
	{ i: 63, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_63", kind: "word", text: "One", startSec: 23.19, endSec: 23.45, kept: true, trimId: null },
	{ i: 64, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_64", kind: "word", text: "amber", startSec: 23.45, endSec: 23.63, kept: true, trimId: null },
	{ i: 65, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_65", kind: "word", text: "day", startSec: 23.63, endSec: 23.830000000000002, kept: true, trimId: null },
	{ i: 66, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_66", kind: "word", text: "on", startSec: 23.830000000000002, endSec: 24.060000000000002, kept: true, trimId: null },
	{ i: 67, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_67", kind: "word", text: "the", startSec: 24.060000000000002, endSec: 24.27, kept: true, trimId: null },
	{ i: 68, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_68", kind: "word", text: "validator,", startSec: 24.27, endSec: 24.94, kept: true, trimId: null },
	{ i: 69, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_69", kind: "word", text: "and", startSec: 24.94, endSec: 25.19, kept: true, trimId: null },
	{ i: 70, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_70", kind: "word", text: "it", startSec: 25.19, endSec: 25.560000000000002, kept: true, trimId: null },
	{ i: 71, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_71", kind: "word", text: "recovered,", startSec: 25.560000000000002, endSec: 25.990000000000002, kept: true, trimId: null },
	{ i: 72, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_72", kind: "word", text: "and", startSec: 25.990000000000002, endSec: 26.54, kept: true, trimId: null },
	{ i: 73, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_73", kind: "word", text: "releases.", startSec: 26.54, endSec: 27.09, kept: true, trimId: null },
	{ i: 74, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:silence_2", kind: "silence", text: "[silence 0.2s]", startSec: 27.09, endSec: 27.32, kept: true, trimId: null },
	{ i: 75, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_74", kind: "word", text: "Three", startSec: 27.32, endSec: 27.400000000000002, kept: true, trimId: null },
	{ i: 76, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_75", kind: "word", text: "of", startSec: 27.400000000000002, endSec: 27.45, kept: true, trimId: null },
	{ i: 77, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_76", kind: "word", text: "them,", startSec: 27.45, endSec: 28.060000000000002, kept: true, trimId: null },
	{ i: 78, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_77", kind: "word", text: "newest", startSec: 28.060000000000002, endSec: 28.54, kept: true, trimId: null },
	{ i: 79, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_78", kind: "word", text: "first,", startSec: 28.54, endSec: 28.95, kept: true, trimId: null },
	{ i: 80, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_79", kind: "word", text: "and", startSec: 28.95, endSec: 29.240000000000002, kept: true, trimId: null },
	{ i: 81, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_80", kind: "word", text: "every", startSec: 29.240000000000002, endSec: 29.53, kept: true, trimId: null },
	{ i: 82, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_81", kind: "word", text: "line", startSec: 29.53, endSec: 29.88, kept: true, trimId: null },
	{ i: 83, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_82", kind: "word", text: "links", startSec: 29.88, endSec: 30.09, kept: true, trimId: null },
	{ i: 84, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_83", kind: "word", text: "into", startSec: 30.09, endSec: 30.32, kept: true, trimId: null },
	{ i: 85, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_84", kind: "word", text: "the", startSec: 30.32, endSec: 30.560000000000002, kept: true, trimId: null },
	{ i: 86, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_85", kind: "word", text: "commit", startSec: 30.560000000000002, endSec: 30.62, kept: true, trimId: null },
	{ i: 87, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_86", kind: "word", text: "that", startSec: 30.62, endSec: 30.810000000000002, kept: true, trimId: null },
	{ i: 88, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_87", kind: "word", text: "did", startSec: 30.810000000000002, endSec: 31.1, kept: true, trimId: null },
	{ i: 89, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_88", kind: "word", text: "it.", startSec: 31.1, endSec: 31.560000000000002, kept: true, trimId: null },
	{ i: 90, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_89", kind: "word", text: "Back", startSec: 31.39, endSec: 31.62, kept: true, trimId: null },
	{ i: 91, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_90", kind: "word", text: "to", startSec: 31.62, endSec: 31.76, kept: true, trimId: null },
	{ i: 92, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_91", kind: "word", text: "the", startSec: 31.76, endSec: 32.160000000000004, kept: true, trimId: null },
	{ i: 93, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_92", kind: "word", text: "top,", startSec: 32.160000000000004, endSec: 32.46, kept: true, trimId: null },
	{ i: 94, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_93", kind: "word", text: "and", startSec: 32.46, endSec: 32.730000000000004, kept: true, trimId: null },
	{ i: 95, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_94", kind: "word", text: "that", startSec: 32.730000000000004, endSec: 32.86, kept: true, trimId: null },
	{ i: 96, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_95", kind: "word", text: "is", startSec: 32.86, endSec: 32.9, kept: true, trimId: null },
	{ i: 97, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_96", kind: "word", text: "the", startSec: 32.9, endSec: 33.07, kept: true, trimId: null },
	{ i: 98, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_97", kind: "word", text: "whole", startSec: 33.07, endSec: 33.55, kept: true, trimId: null },
	{ i: 99, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_98", kind: "word", text: "flow.", startSec: 33.55, endSec: 34.03, kept: true, trimId: null },
	{ i: 100, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_99", kind: "word", text: "Tell", startSec: 33.99, endSec: 34.19, kept: true, trimId: null },
	{ i: 101, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_100", kind: "word", text: "me", startSec: 34.19, endSec: 34.5, kept: true, trimId: null },
	{ i: 102, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_101", kind: "word", text: "what", startSec: 34.5, endSec: 34.53, kept: true, trimId: null },
	{ i: 103, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_102", kind: "word", text: "you", startSec: 34.53, endSec: 35, kept: true, trimId: null },
	{ i: 104, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:word_103", kind: "word", text: "think.", startSec: 35, endSec: 35.12, kept: true, trimId: null },
	{ i: 105, id: "clip_3aa049d2-cf6c-406e-99fa-4a9754fea5fe:silence_3", kind: "silence", text: "[silence 4.9s]", startSec: 35.12, endSec: 40.033, kept: false, trimId: "trim_3bad6006-721a-4dd4-a218-091fa734a63e" },
];

/** The five lanes in the app's order. A lane carries its shortcut hint if and
 *  only if the document holds no regions for it. */
export const LANES: RecreationLane[] = [
	{ id: "annotation", hint: "Press A to add annotation", pills: [] },
	{ id: "speed", hint: "Press S to add speed", pills: [] },
	{ id: "trim", hint: null, pills: [{ lane: "trim", id: "trim_f52989cf-489c-47f5-a6c7-b95a7d71b399", label: "0:02.2", startSec: 0, endSec: 2.19, leftPct: 0, widthPct: 5.4705, origin: "agent" }, { lane: "trim", id: "trim_3bad6006-721a-4dd4-a218-091fa734a63e", label: "0:04.9", startSec: 35.12, endSec: 40.033, leftPct: 87.7276, widthPct: 12.2724, origin: "agent" }] },
	{ id: "zoom", hint: null, pills: [{ lane: "zoom", id: "zoom_403360f0-0784-4034-994a-a79eb4e5aa55", label: "1.80×", startSec: 4.2, endSec: 12.6, leftPct: 10.4913, widthPct: 20.9827, depth: 3, focusMode: "auto" }, { lane: "zoom", id: "zoom_2d7bd6ce-02e1-4f7d-ad63-03ada76859e3", label: "2.20×", startSec: 17.5, endSec: 24.5, leftPct: 43.7139, widthPct: 17.4856, depth: 4, focusMode: "manual" }, { lane: "zoom", id: "zoom_11caaa47-6be5-4afa-bf1d-f2e6650f2066", label: "1.80×", startSec: 33.112, endSec: 35.156, leftPct: 82.7118, widthPct: 5.1058, depth: 3, focusMode: "manual" }] },
	{ id: "cameraFullscreen", hint: "Press C to add a Full Camera segment", pills: [] },
];

/** Every pill on the floor, flattened. */
export const PILLS: RecreationPill[] = [
	{ lane: "trim", id: "trim_f52989cf-489c-47f5-a6c7-b95a7d71b399", label: "0:02.2", startSec: 0, endSec: 2.19, leftPct: 0, widthPct: 5.4705, origin: "agent" },
	{ lane: "trim", id: "trim_3bad6006-721a-4dd4-a218-091fa734a63e", label: "0:04.9", startSec: 35.12, endSec: 40.033, leftPct: 87.7276, widthPct: 12.2724, origin: "agent" },
	{ lane: "zoom", id: "zoom_403360f0-0784-4034-994a-a79eb4e5aa55", label: "1.80×", startSec: 4.2, endSec: 12.6, leftPct: 10.4913, widthPct: 20.9827, depth: 3, focusMode: "auto" },
	{ lane: "zoom", id: "zoom_2d7bd6ce-02e1-4f7d-ad63-03ada76859e3", label: "2.20×", startSec: 17.5, endSec: 24.5, leftPct: 43.7139, widthPct: 17.4856, depth: 4, focusMode: "manual" },
	{ lane: "zoom", id: "zoom_11caaa47-6be5-4afa-bf1d-f2e6650f2066", label: "1.80×", startSec: 33.112, endSec: 35.156, leftPct: 82.7118, widthPct: 5.1058, depth: 3, focusMode: "manual" },
];

/** The ruler, re-derived per breakpoint the way the app re-derives it per zoom. */
export const RULER = {
	minLabelGapPx: 76,
	minorPerMajor: 5,
	tickStepsSec: [
		0.05,
		0.1,
		0.25,
		0.5,
		1,
		2,
		5,
		10,
		15,
		30,
		60,
		120,
		300,
		600,
		900,
		1800,
		3600,
	],
	wideBreakpointPx: 3043,
	variants: [
		{
			worldPx: 1920,
			pxPerSec: 47.9604,
			stepSec: 2,
			minorSec: 0.4,
			minorPct: 0.999176,
			labels: [
	{ sec: 0, leftPct: 0, text: "0:00" },
	{ sec: 2, leftPct: 4.9959, text: "0:02" },
	{ sec: 4, leftPct: 9.9918, text: "0:04" },
	{ sec: 6, leftPct: 14.9876, text: "0:06" },
	{ sec: 8, leftPct: 19.9835, text: "0:08" },
	{ sec: 10, leftPct: 24.9794, text: "0:10" },
	{ sec: 12, leftPct: 29.9753, text: "0:12" },
	{ sec: 14, leftPct: 34.9711, text: "0:14" },
	{ sec: 16, leftPct: 39.967, text: "0:16" },
	{ sec: 18, leftPct: 44.9629, text: "0:18" },
	{ sec: 20, leftPct: 49.9588, text: "0:20" },
	{ sec: 22, leftPct: 54.9547, text: "0:22" },
	{ sec: 24, leftPct: 59.9505, text: "0:24" },
	{ sec: 26, leftPct: 64.9464, text: "0:26" },
	{ sec: 28, leftPct: 69.9423, text: "0:28" },
	{ sec: 30, leftPct: 74.9382, text: "0:30" },
	{ sec: 32, leftPct: 79.9341, text: "0:32" },
	{ sec: 34, leftPct: 84.9299, text: "0:34" },
	{ sec: 36, leftPct: 89.9258, text: "0:36" },
	{ sec: 38, leftPct: 94.9217, text: "0:38" },
	{ sec: 40, leftPct: 99.9176, text: "0:40" },
],
		},
		{
			worldPx: 3440,
			pxPerSec: 85.9291,
			stepSec: 1,
			minorSec: 0.2,
			minorPct: 0.499588,
			labels: [
	{ sec: 0, leftPct: 0, text: "0:00" },
	{ sec: 1, leftPct: 2.4979, text: "0:01" },
	{ sec: 2, leftPct: 4.9959, text: "0:02" },
	{ sec: 3, leftPct: 7.4938, text: "0:03" },
	{ sec: 4, leftPct: 9.9918, text: "0:04" },
	{ sec: 5, leftPct: 12.4897, text: "0:05" },
	{ sec: 6, leftPct: 14.9876, text: "0:06" },
	{ sec: 7, leftPct: 17.4856, text: "0:07" },
	{ sec: 8, leftPct: 19.9835, text: "0:08" },
	{ sec: 9, leftPct: 22.4815, text: "0:09" },
	{ sec: 10, leftPct: 24.9794, text: "0:10" },
	{ sec: 11, leftPct: 27.4773, text: "0:11" },
	{ sec: 12, leftPct: 29.9753, text: "0:12" },
	{ sec: 13, leftPct: 32.4732, text: "0:13" },
	{ sec: 14, leftPct: 34.9711, text: "0:14" },
	{ sec: 15, leftPct: 37.4691, text: "0:15" },
	{ sec: 16, leftPct: 39.967, text: "0:16" },
	{ sec: 17, leftPct: 42.465, text: "0:17" },
	{ sec: 18, leftPct: 44.9629, text: "0:18" },
	{ sec: 19, leftPct: 47.4608, text: "0:19" },
	{ sec: 20, leftPct: 49.9588, text: "0:20" },
	{ sec: 21, leftPct: 52.4567, text: "0:21" },
	{ sec: 22, leftPct: 54.9547, text: "0:22" },
	{ sec: 23, leftPct: 57.4526, text: "0:23" },
	{ sec: 24, leftPct: 59.9505, text: "0:24" },
	{ sec: 25, leftPct: 62.4485, text: "0:25" },
	{ sec: 26, leftPct: 64.9464, text: "0:26" },
	{ sec: 27, leftPct: 67.4444, text: "0:27" },
	{ sec: 28, leftPct: 69.9423, text: "0:28" },
	{ sec: 29, leftPct: 72.4402, text: "0:29" },
	{ sec: 30, leftPct: 74.9382, text: "0:30" },
	{ sec: 31, leftPct: 77.4361, text: "0:31" },
	{ sec: 32, leftPct: 79.9341, text: "0:32" },
	{ sec: 33, leftPct: 82.432, text: "0:33" },
	{ sec: 34, leftPct: 84.9299, text: "0:34" },
	{ sec: 35, leftPct: 87.4279, text: "0:35" },
	{ sec: 36, leftPct: 89.9258, text: "0:36" },
	{ sec: 37, leftPct: 92.4238, text: "0:37" },
	{ sec: 38, leftPct: 94.9217, text: "0:38" },
	{ sec: 39, leftPct: 97.4196, text: "0:39" },
	{ sec: 40, leftPct: 99.9176, text: "0:40" },
],
		},
	],
} as const;

/** 320 samples as one smooth area under a line, the clip card's two paths. */
export const WAVEFORM = {
	viewBox: "0 0 319 100",
	sampleCount: 320,
	area: "M0,100 L0,92 C0.17,92 0.83,92 1,92 C1.17,92 1.83,92 2,92 C2.17,92 2.83,92 3,92 C3.17,92 3.83,92 4,92 C4.17,92 4.83,92 5,92 C5.17,92 5.83,92 6,92 C6.17,92 6.83,92 7,92 C7.17,92 7.83,92 8,92 C8.17,92 8.83,92 9,92 C9.17,92 9.83,92 10,92 C10.17,92 10.83,92 11,92 C11.17,92 11.83,92 12,92 C12.17,92 12.83,92 13,92 C13.17,92 13.83,92 14,92 C14.17,92 14.83,96.33 15,92 C15.17,87.67 15.83,72.67 16,66 C16.17,59.33 16.83,52.67 17,52 C17.17,51.33 17.83,55.33 18,62 C18.17,68.67 18.83,87 19,92 C19.17,97 19.83,96 20,92 C20.17,88 20.83,71.83 21,68 C21.17,64.17 21.83,71.33 22,69 C22.17,66.67 22.83,54.5 23,54 C23.17,53.5 23.83,64.5 24,66 C24.17,67.5 24.83,63.83 25,63 C25.17,62.17 25.83,62.5 26,61 C26.17,59.5 26.83,55.33 27,54 C27.17,52.67 27.83,50.83 28,53 C28.17,55.17 28.83,65.17 29,67 C29.17,68.83 29.83,64.5 30,64 C30.17,63.5 30.83,65.17 31,64 C31.17,62.83 31.83,56.33 32,57 C32.17,57.67 32.83,66.17 33,68 C33.17,69.83 33.83,67.83 34,68 C34.17,68.17 34.83,71 35,69 C35.17,67 35.83,55.17 36,56 C36.17,56.83 36.83,68 37,74 C37.17,80 37.83,89 38,92 C38.17,95 38.83,97.17 39,92 C39.17,86.83 39.83,64.67 40,61 C40.17,57.33 40.83,69.5 41,70 C41.17,70.5 41.83,64.67 42,64 C42.17,63.33 42.83,64.33 43,66 C43.17,67.67 43.83,74 44,74 C44.17,74 44.83,68.5 45,66 C45.17,63.5 45.83,60.17 46,59 C46.17,57.83 46.83,58.5 47,59 C47.17,59.5 47.83,60 48,62 C48.17,64 48.83,72.17 49,71 C49.17,69.83 49.83,56.67 50,55 C50.17,53.33 50.83,58.5 51,61 C51.17,63.5 51.83,64.83 52,70 C52.17,75.17 52.83,88.33 53,92 C53.17,95.67 53.83,96.33 54,92 C54.17,87.67 54.83,70.17 55,66 C55.17,61.83 55.83,67.67 56,67 C56.17,66.33 56.83,62.5 57,62 C57.17,61.5 57.83,64.67 58,64 C58.17,63.33 58.83,56.83 59,58 C59.17,59.17 59.83,69.5 60,71 C60.17,72.5 60.83,68.33 61,67 C61.17,65.67 61.83,62.83 62,63 C62.17,63.17 62.83,69.33 63,68 C63.17,66.67 63.83,56.33 64,55 C64.17,53.67 64.83,55.83 65,60 C65.17,64.17 65.83,74.67 66,80 C66.17,85.33 66.83,96 67,92 C67.17,88 67.83,61.5 68,56 C68.17,50.5 68.83,58.17 69,59 C69.17,59.83 69.83,60.83 70,61 C70.17,61.17 70.83,59.83 71,60 C71.17,60.17 71.83,57.83 72,62 C72.17,66.17 72.83,80 73,85 C73.17,90 73.83,94 74,92 C74.17,90 74.83,79 75,73 C75.17,67 75.83,56.17 76,56 C76.17,55.83 76.83,72 77,72 C77.17,72 77.83,58 78,56 C78.17,54 78.83,58.83 79,60 C79.17,61.17 79.83,58.33 80,63 C80.17,67.67 80.83,83.17 81,88 C81.17,92.83 81.83,95.17 82,92 C82.17,88.83 82.83,73.67 83,69 C83.17,64.33 83.83,64.33 84,64 C84.17,63.67 84.83,66.67 85,67 C85.17,67.33 85.83,65.83 86,66 C86.17,66.17 86.83,69.67 87,68 C87.17,66.33 87.83,56.83 88,56 C88.17,55.17 88.83,61.17 89,63 C89.17,64.83 89.83,66.5 90,67 C90.17,67.5 90.83,65.33 91,66 C91.17,66.67 91.83,72.67 92,71 C92.17,69.33 92.83,57 93,56 C93.17,55 93.83,64.33 94,65 C94.17,65.67 94.83,61 95,60 C95.17,59 95.83,59.17 96,59 C96.17,58.83 96.83,53.5 97,59 C97.17,64.5 97.83,86.5 98,92 C98.17,97.5 98.83,93 99,92 C99.17,91 99.83,89.67 100,86 C100.17,82.33 100.83,74.33 101,70 C101.17,65.67 101.83,60.33 102,60 C102.17,59.67 102.83,67.17 103,68 C103.17,68.83 103.83,66.17 104,65 C104.17,63.83 104.83,60.33 105,61 C105.17,61.67 105.83,64.33 106,69 C106.17,73.67 106.83,85.17 107,89 C107.17,92.83 107.83,96.17 108,92 C108.17,87.83 108.83,68 109,64 C109.17,60 109.83,67.33 110,68 C110.17,68.67 110.83,66 111,68 C111.17,70 111.83,79.67 112,80 C112.17,80.33 112.83,74.17 113,70 C113.17,65.83 113.83,55.5 114,55 C114.17,54.5 114.83,67.5 115,67 C115.17,66.5 115.83,52.83 116,52 C116.17,51.17 116.83,61 117,62 C117.17,63 117.83,58.67 118,58 C118.17,57.33 118.83,58.33 119,58 C119.17,57.67 119.83,55.33 120,56 C120.17,56.67 120.83,61.67 121,62 C121.17,62.33 121.83,58.33 122,58 C122.17,57.67 122.83,59.67 123,60 C123.17,60.33 123.83,59.33 124,60 C124.17,60.67 124.83,64 125,64 C125.17,64 125.83,59 126,60 C126.17,61 126.83,68.83 127,70 C127.17,71.17 127.83,68.67 128,67 C128.17,65.33 128.83,59.83 129,60 C129.17,60.17 129.83,63.33 130,68 C130.17,72.67 130.83,84 131,88 C131.17,92 131.83,95.5 132,92 C132.17,88.5 132.83,71.33 133,67 C133.17,62.67 133.83,66.33 134,66 C134.17,65.67 134.83,65 135,65 C135.17,65 135.83,63.5 136,66 C136.17,68.5 136.83,80.5 137,80 C137.17,79.5 137.83,64.33 138,63 C138.17,61.67 138.83,72.67 139,72 C139.17,71.33 139.83,60.33 140,59 C140.17,57.67 140.83,63.5 141,64 C141.17,64.5 141.83,61.83 142,62 C142.17,62.17 142.83,65 143,65 C143.17,65 143.83,61.5 144,62 C144.17,62.5 144.83,67.17 145,68 C145.17,68.83 145.83,64.5 146,67 C146.17,69.5 146.83,78.83 147,83 C147.17,87.17 147.83,90.5 148,92 C148.17,93.5 148.83,98 149,92 C149.17,86 149.83,61.67 150,56 C150.17,50.33 150.83,57.83 151,58 C151.17,58.17 151.83,56.5 152,57 C152.17,57.5 152.83,58 153,61 C153.17,64 153.83,74.5 154,75 C154.17,75.5 154.83,65.67 155,64 C155.17,62.33 155.83,63.83 156,65 C156.17,66.17 156.83,66.83 157,71 C157.17,75.17 157.83,86.5 158,90 C158.17,93.5 158.83,96.83 159,92 C159.17,87.17 159.83,65.33 160,61 C160.17,56.67 160.83,64.83 161,66 C161.17,67.17 161.83,67.67 162,68 C162.17,68.33 162.83,66.17 163,68 C163.17,69.83 163.83,80 164,79 C164.17,78 164.83,64.5 165,62 C165.17,59.5 165.83,63.5 166,64 C166.17,64.5 166.83,65 167,65 C167.17,65 167.83,65 168,64 C168.17,63 168.83,60 169,59 C169.17,58 169.83,56.33 170,58 C170.17,59.67 170.83,68.83 171,69 C171.17,69.17 171.83,59.17 172,59 C172.17,58.83 172.83,67.33 173,68 C173.17,68.67 173.83,64.33 174,63 C174.17,61.67 174.83,60.83 175,60 C175.17,59.17 175.83,53.5 176,58 C176.17,62.5 176.83,85.83 177,87 C177.17,88.17 177.83,69.83 178,65 C178.17,60.17 178.83,58 179,58 C179.17,58 179.83,64.17 180,65 C180.17,65.83 180.83,58.5 181,63 C181.17,67.5 181.83,87.17 182,92 C182.17,96.83 182.83,97.33 183,92 C183.17,86.67 183.83,65 184,60 C184.17,55 184.83,61.33 185,62 C185.17,62.67 185.83,63.5 186,64 C186.17,64.5 186.83,65 187,65 C187.17,65 187.83,65 188,64 C188.17,63 188.83,59.67 189,59 C189.17,58.33 189.83,59.83 190,60 C190.17,60.17 190.83,60 191,60 C191.17,60 191.83,60 192,60 C192.17,60 192.83,59.5 193,60 C193.17,60.5 193.83,63.5 194,63 C194.17,62.5 194.83,58 195,57 C195.17,56 195.83,55.17 196,57 C196.17,58.83 196.83,62.17 197,68 C197.17,73.83 197.83,92 198,92 C198.17,92 198.83,72.67 199,68 C199.17,63.33 199.83,64.17 200,64 C200.17,63.83 200.83,67.17 201,67 C201.17,66.83 201.83,64.33 202,63 C202.17,61.67 202.83,60.33 203,59 C203.17,57.67 203.83,54.5 204,55 C204.17,55.5 204.83,55.83 205,62 C205.17,68.17 205.83,87 206,92 C206.17,97 206.83,96.33 207,92 C207.17,87.67 207.83,70.67 208,66 C208.17,61.33 208.83,64 209,64 C209.17,64 209.83,65.5 210,66 C210.17,66.5 210.83,66.67 211,67 C211.17,67.33 211.83,67.33 212,68 C212.17,68.67 212.83,67 213,71 C213.17,75 213.83,88.5 214,92 C214.17,95.5 214.83,92 215,92 C215.17,92 215.83,96.67 216,92 C216.17,87.33 216.83,69 217,64 C217.17,59 217.83,60.83 218,62 C218.17,63.17 218.83,70.5 219,71 C219.17,71.5 219.83,62.33 220,65 C220.17,67.67 220.83,82.5 221,87 C221.17,91.5 221.83,95.17 222,92 C222.17,88.83 222.83,72.5 223,68 C223.17,63.5 223.83,65.33 224,65 C224.17,64.67 224.83,61.5 225,66 C225.17,70.5 225.83,92.67 226,92 C226.17,91.33 226.83,66.67 227,62 C227.17,57.33 227.83,60.17 228,64 C228.17,67.83 228.83,80.33 229,85 C229.17,89.67 229.83,90.83 230,92 C230.17,93.17 230.83,96.83 231,92 C231.17,87.17 231.83,67.83 232,63 C232.17,58.17 232.83,62.5 233,63 C233.17,63.5 233.83,66.83 234,66 C234.17,65.17 234.83,58.83 235,58 C235.17,57.17 235.83,58.83 236,61 C236.17,63.17 236.83,70.17 237,71 C237.17,71.83 237.83,64.33 238,66 C238.17,67.67 238.83,81.67 239,81 C239.17,80.33 239.83,64.17 240,62 C240.17,59.83 240.83,67.83 241,68 C241.17,68.17 241.83,63 242,63 C242.17,63 242.83,67.83 243,68 C243.17,68.17 243.83,65 244,64 C244.17,63 244.83,61.5 245,62 C245.17,62.5 245.83,66.5 246,67 C246.17,67.5 246.83,65.67 247,65 C247.17,64.33 247.83,58.5 248,63 C248.17,67.5 248.83,87.17 249,92 C249.17,96.83 249.83,96.5 250,92 C250.17,87.5 250.83,69.67 251,65 C251.17,60.33 251.83,63.67 252,64 C252.17,64.33 252.83,66.83 253,67 C253.17,67.17 253.83,63.17 254,65 C254.17,66.83 254.83,79.67 255,78 C255.17,76.33 255.83,57.83 256,55 C256.17,52.17 256.83,54.83 257,61 C257.17,67.17 257.83,86.83 258,92 C258.17,97.17 258.83,96.67 259,92 C259.17,87.33 259.83,69 260,64 C260.17,59 260.83,61.5 261,62 C261.17,62.5 261.83,66.5 262,67 C262.17,67.5 262.83,65.83 263,65 C263.17,64.17 263.83,63.17 264,62 C264.17,60.83 264.83,56.5 265,58 C265.17,59.5 265.83,70.67 266,71 C266.17,71.33 266.83,62.33 267,60 C267.17,57.67 267.83,55.5 268,57 C268.17,58.5 268.83,63.17 269,69 C269.17,74.83 269.83,88.17 270,92 C270.17,95.83 270.83,97.17 271,92 C271.17,86.83 271.83,66.83 272,61 C272.17,55.17 272.83,56.17 273,57 C273.17,57.83 273.83,66.17 274,66 C274.17,65.83 274.83,55.67 275,56 C275.17,56.33 275.83,66.5 276,68 C276.17,69.5 276.83,66 277,65 C277.17,64 277.83,62.5 278,62 C278.17,61.5 278.83,58.5 279,62 C279.17,65.5 279.83,78 280,83 C280.17,88 280.83,90.5 281,92 C281.17,93.5 281.83,92 282,92 C282.17,92 282.83,92 283,92 C283.17,92 283.83,92 284,92 C284.17,92 284.83,92 285,92 C285.17,92 285.83,92 286,92 C286.17,92 286.83,92 287,92 C287.17,92 287.83,92 288,92 C288.17,92 288.83,92 289,92 C289.17,92 289.83,92 290,92 C290.17,92 290.83,92 291,92 C291.17,92 291.83,92 292,92 C292.17,92 292.83,92 293,92 C293.17,92 293.83,92 294,92 C294.17,92 294.83,92 295,92 C295.17,92 295.83,92 296,92 C296.17,92 296.83,92 297,92 C297.17,92 297.83,92 298,92 C298.17,92 298.83,92 299,92 C299.17,92 299.83,92 300,92 C300.17,92 300.83,92 301,92 C301.17,92 301.83,92 302,92 C302.17,92 302.83,92 303,92 C303.17,92 303.83,92 304,92 C304.17,92 304.83,92 305,92 C305.17,92 305.83,92 306,92 C306.17,92 306.83,92 307,92 C307.17,92 307.83,92 308,92 C308.17,92 308.83,92 309,92 C309.17,92 309.83,92 310,92 C310.17,92 310.83,92 311,92 C311.17,92 311.83,92 312,92 C312.17,92 312.83,92 313,92 C313.17,92 313.83,92 314,92 C314.17,92 314.83,92 315,92 C315.17,92 315.83,92 316,92 C316.17,92 316.83,92 317,92 C317.17,92 317.83,92 318,92 C318.17,92 318.83,92 319,92 L319,100 Z",
	line: "M0,92 C0.17,92 0.83,92 1,92 C1.17,92 1.83,92 2,92 C2.17,92 2.83,92 3,92 C3.17,92 3.83,92 4,92 C4.17,92 4.83,92 5,92 C5.17,92 5.83,92 6,92 C6.17,92 6.83,92 7,92 C7.17,92 7.83,92 8,92 C8.17,92 8.83,92 9,92 C9.17,92 9.83,92 10,92 C10.17,92 10.83,92 11,92 C11.17,92 11.83,92 12,92 C12.17,92 12.83,92 13,92 C13.17,92 13.83,92 14,92 C14.17,92 14.83,96.33 15,92 C15.17,87.67 15.83,72.67 16,66 C16.17,59.33 16.83,52.67 17,52 C17.17,51.33 17.83,55.33 18,62 C18.17,68.67 18.83,87 19,92 C19.17,97 19.83,96 20,92 C20.17,88 20.83,71.83 21,68 C21.17,64.17 21.83,71.33 22,69 C22.17,66.67 22.83,54.5 23,54 C23.17,53.5 23.83,64.5 24,66 C24.17,67.5 24.83,63.83 25,63 C25.17,62.17 25.83,62.5 26,61 C26.17,59.5 26.83,55.33 27,54 C27.17,52.67 27.83,50.83 28,53 C28.17,55.17 28.83,65.17 29,67 C29.17,68.83 29.83,64.5 30,64 C30.17,63.5 30.83,65.17 31,64 C31.17,62.83 31.83,56.33 32,57 C32.17,57.67 32.83,66.17 33,68 C33.17,69.83 33.83,67.83 34,68 C34.17,68.17 34.83,71 35,69 C35.17,67 35.83,55.17 36,56 C36.17,56.83 36.83,68 37,74 C37.17,80 37.83,89 38,92 C38.17,95 38.83,97.17 39,92 C39.17,86.83 39.83,64.67 40,61 C40.17,57.33 40.83,69.5 41,70 C41.17,70.5 41.83,64.67 42,64 C42.17,63.33 42.83,64.33 43,66 C43.17,67.67 43.83,74 44,74 C44.17,74 44.83,68.5 45,66 C45.17,63.5 45.83,60.17 46,59 C46.17,57.83 46.83,58.5 47,59 C47.17,59.5 47.83,60 48,62 C48.17,64 48.83,72.17 49,71 C49.17,69.83 49.83,56.67 50,55 C50.17,53.33 50.83,58.5 51,61 C51.17,63.5 51.83,64.83 52,70 C52.17,75.17 52.83,88.33 53,92 C53.17,95.67 53.83,96.33 54,92 C54.17,87.67 54.83,70.17 55,66 C55.17,61.83 55.83,67.67 56,67 C56.17,66.33 56.83,62.5 57,62 C57.17,61.5 57.83,64.67 58,64 C58.17,63.33 58.83,56.83 59,58 C59.17,59.17 59.83,69.5 60,71 C60.17,72.5 60.83,68.33 61,67 C61.17,65.67 61.83,62.83 62,63 C62.17,63.17 62.83,69.33 63,68 C63.17,66.67 63.83,56.33 64,55 C64.17,53.67 64.83,55.83 65,60 C65.17,64.17 65.83,74.67 66,80 C66.17,85.33 66.83,96 67,92 C67.17,88 67.83,61.5 68,56 C68.17,50.5 68.83,58.17 69,59 C69.17,59.83 69.83,60.83 70,61 C70.17,61.17 70.83,59.83 71,60 C71.17,60.17 71.83,57.83 72,62 C72.17,66.17 72.83,80 73,85 C73.17,90 73.83,94 74,92 C74.17,90 74.83,79 75,73 C75.17,67 75.83,56.17 76,56 C76.17,55.83 76.83,72 77,72 C77.17,72 77.83,58 78,56 C78.17,54 78.83,58.83 79,60 C79.17,61.17 79.83,58.33 80,63 C80.17,67.67 80.83,83.17 81,88 C81.17,92.83 81.83,95.17 82,92 C82.17,88.83 82.83,73.67 83,69 C83.17,64.33 83.83,64.33 84,64 C84.17,63.67 84.83,66.67 85,67 C85.17,67.33 85.83,65.83 86,66 C86.17,66.17 86.83,69.67 87,68 C87.17,66.33 87.83,56.83 88,56 C88.17,55.17 88.83,61.17 89,63 C89.17,64.83 89.83,66.5 90,67 C90.17,67.5 90.83,65.33 91,66 C91.17,66.67 91.83,72.67 92,71 C92.17,69.33 92.83,57 93,56 C93.17,55 93.83,64.33 94,65 C94.17,65.67 94.83,61 95,60 C95.17,59 95.83,59.17 96,59 C96.17,58.83 96.83,53.5 97,59 C97.17,64.5 97.83,86.5 98,92 C98.17,97.5 98.83,93 99,92 C99.17,91 99.83,89.67 100,86 C100.17,82.33 100.83,74.33 101,70 C101.17,65.67 101.83,60.33 102,60 C102.17,59.67 102.83,67.17 103,68 C103.17,68.83 103.83,66.17 104,65 C104.17,63.83 104.83,60.33 105,61 C105.17,61.67 105.83,64.33 106,69 C106.17,73.67 106.83,85.17 107,89 C107.17,92.83 107.83,96.17 108,92 C108.17,87.83 108.83,68 109,64 C109.17,60 109.83,67.33 110,68 C110.17,68.67 110.83,66 111,68 C111.17,70 111.83,79.67 112,80 C112.17,80.33 112.83,74.17 113,70 C113.17,65.83 113.83,55.5 114,55 C114.17,54.5 114.83,67.5 115,67 C115.17,66.5 115.83,52.83 116,52 C116.17,51.17 116.83,61 117,62 C117.17,63 117.83,58.67 118,58 C118.17,57.33 118.83,58.33 119,58 C119.17,57.67 119.83,55.33 120,56 C120.17,56.67 120.83,61.67 121,62 C121.17,62.33 121.83,58.33 122,58 C122.17,57.67 122.83,59.67 123,60 C123.17,60.33 123.83,59.33 124,60 C124.17,60.67 124.83,64 125,64 C125.17,64 125.83,59 126,60 C126.17,61 126.83,68.83 127,70 C127.17,71.17 127.83,68.67 128,67 C128.17,65.33 128.83,59.83 129,60 C129.17,60.17 129.83,63.33 130,68 C130.17,72.67 130.83,84 131,88 C131.17,92 131.83,95.5 132,92 C132.17,88.5 132.83,71.33 133,67 C133.17,62.67 133.83,66.33 134,66 C134.17,65.67 134.83,65 135,65 C135.17,65 135.83,63.5 136,66 C136.17,68.5 136.83,80.5 137,80 C137.17,79.5 137.83,64.33 138,63 C138.17,61.67 138.83,72.67 139,72 C139.17,71.33 139.83,60.33 140,59 C140.17,57.67 140.83,63.5 141,64 C141.17,64.5 141.83,61.83 142,62 C142.17,62.17 142.83,65 143,65 C143.17,65 143.83,61.5 144,62 C144.17,62.5 144.83,67.17 145,68 C145.17,68.83 145.83,64.5 146,67 C146.17,69.5 146.83,78.83 147,83 C147.17,87.17 147.83,90.5 148,92 C148.17,93.5 148.83,98 149,92 C149.17,86 149.83,61.67 150,56 C150.17,50.33 150.83,57.83 151,58 C151.17,58.17 151.83,56.5 152,57 C152.17,57.5 152.83,58 153,61 C153.17,64 153.83,74.5 154,75 C154.17,75.5 154.83,65.67 155,64 C155.17,62.33 155.83,63.83 156,65 C156.17,66.17 156.83,66.83 157,71 C157.17,75.17 157.83,86.5 158,90 C158.17,93.5 158.83,96.83 159,92 C159.17,87.17 159.83,65.33 160,61 C160.17,56.67 160.83,64.83 161,66 C161.17,67.17 161.83,67.67 162,68 C162.17,68.33 162.83,66.17 163,68 C163.17,69.83 163.83,80 164,79 C164.17,78 164.83,64.5 165,62 C165.17,59.5 165.83,63.5 166,64 C166.17,64.5 166.83,65 167,65 C167.17,65 167.83,65 168,64 C168.17,63 168.83,60 169,59 C169.17,58 169.83,56.33 170,58 C170.17,59.67 170.83,68.83 171,69 C171.17,69.17 171.83,59.17 172,59 C172.17,58.83 172.83,67.33 173,68 C173.17,68.67 173.83,64.33 174,63 C174.17,61.67 174.83,60.83 175,60 C175.17,59.17 175.83,53.5 176,58 C176.17,62.5 176.83,85.83 177,87 C177.17,88.17 177.83,69.83 178,65 C178.17,60.17 178.83,58 179,58 C179.17,58 179.83,64.17 180,65 C180.17,65.83 180.83,58.5 181,63 C181.17,67.5 181.83,87.17 182,92 C182.17,96.83 182.83,97.33 183,92 C183.17,86.67 183.83,65 184,60 C184.17,55 184.83,61.33 185,62 C185.17,62.67 185.83,63.5 186,64 C186.17,64.5 186.83,65 187,65 C187.17,65 187.83,65 188,64 C188.17,63 188.83,59.67 189,59 C189.17,58.33 189.83,59.83 190,60 C190.17,60.17 190.83,60 191,60 C191.17,60 191.83,60 192,60 C192.17,60 192.83,59.5 193,60 C193.17,60.5 193.83,63.5 194,63 C194.17,62.5 194.83,58 195,57 C195.17,56 195.83,55.17 196,57 C196.17,58.83 196.83,62.17 197,68 C197.17,73.83 197.83,92 198,92 C198.17,92 198.83,72.67 199,68 C199.17,63.33 199.83,64.17 200,64 C200.17,63.83 200.83,67.17 201,67 C201.17,66.83 201.83,64.33 202,63 C202.17,61.67 202.83,60.33 203,59 C203.17,57.67 203.83,54.5 204,55 C204.17,55.5 204.83,55.83 205,62 C205.17,68.17 205.83,87 206,92 C206.17,97 206.83,96.33 207,92 C207.17,87.67 207.83,70.67 208,66 C208.17,61.33 208.83,64 209,64 C209.17,64 209.83,65.5 210,66 C210.17,66.5 210.83,66.67 211,67 C211.17,67.33 211.83,67.33 212,68 C212.17,68.67 212.83,67 213,71 C213.17,75 213.83,88.5 214,92 C214.17,95.5 214.83,92 215,92 C215.17,92 215.83,96.67 216,92 C216.17,87.33 216.83,69 217,64 C217.17,59 217.83,60.83 218,62 C218.17,63.17 218.83,70.5 219,71 C219.17,71.5 219.83,62.33 220,65 C220.17,67.67 220.83,82.5 221,87 C221.17,91.5 221.83,95.17 222,92 C222.17,88.83 222.83,72.5 223,68 C223.17,63.5 223.83,65.33 224,65 C224.17,64.67 224.83,61.5 225,66 C225.17,70.5 225.83,92.67 226,92 C226.17,91.33 226.83,66.67 227,62 C227.17,57.33 227.83,60.17 228,64 C228.17,67.83 228.83,80.33 229,85 C229.17,89.67 229.83,90.83 230,92 C230.17,93.17 230.83,96.83 231,92 C231.17,87.17 231.83,67.83 232,63 C232.17,58.17 232.83,62.5 233,63 C233.17,63.5 233.83,66.83 234,66 C234.17,65.17 234.83,58.83 235,58 C235.17,57.17 235.83,58.83 236,61 C236.17,63.17 236.83,70.17 237,71 C237.17,71.83 237.83,64.33 238,66 C238.17,67.67 238.83,81.67 239,81 C239.17,80.33 239.83,64.17 240,62 C240.17,59.83 240.83,67.83 241,68 C241.17,68.17 241.83,63 242,63 C242.17,63 242.83,67.83 243,68 C243.17,68.17 243.83,65 244,64 C244.17,63 244.83,61.5 245,62 C245.17,62.5 245.83,66.5 246,67 C246.17,67.5 246.83,65.67 247,65 C247.17,64.33 247.83,58.5 248,63 C248.17,67.5 248.83,87.17 249,92 C249.17,96.83 249.83,96.5 250,92 C250.17,87.5 250.83,69.67 251,65 C251.17,60.33 251.83,63.67 252,64 C252.17,64.33 252.83,66.83 253,67 C253.17,67.17 253.83,63.17 254,65 C254.17,66.83 254.83,79.67 255,78 C255.17,76.33 255.83,57.83 256,55 C256.17,52.17 256.83,54.83 257,61 C257.17,67.17 257.83,86.83 258,92 C258.17,97.17 258.83,96.67 259,92 C259.17,87.33 259.83,69 260,64 C260.17,59 260.83,61.5 261,62 C261.17,62.5 261.83,66.5 262,67 C262.17,67.5 262.83,65.83 263,65 C263.17,64.17 263.83,63.17 264,62 C264.17,60.83 264.83,56.5 265,58 C265.17,59.5 265.83,70.67 266,71 C266.17,71.33 266.83,62.33 267,60 C267.17,57.67 267.83,55.5 268,57 C268.17,58.5 268.83,63.17 269,69 C269.17,74.83 269.83,88.17 270,92 C270.17,95.83 270.83,97.17 271,92 C271.17,86.83 271.83,66.83 272,61 C272.17,55.17 272.83,56.17 273,57 C273.17,57.83 273.83,66.17 274,66 C274.17,65.83 274.83,55.67 275,56 C275.17,56.33 275.83,66.5 276,68 C276.17,69.5 276.83,66 277,65 C277.17,64 277.83,62.5 278,62 C278.17,61.5 278.83,58.5 279,62 C279.17,65.5 279.83,78 280,83 C280.17,88 280.83,90.5 281,92 C281.17,93.5 281.83,92 282,92 C282.17,92 282.83,92 283,92 C283.17,92 283.83,92 284,92 C284.17,92 284.83,92 285,92 C285.17,92 285.83,92 286,92 C286.17,92 286.83,92 287,92 C287.17,92 287.83,92 288,92 C288.17,92 288.83,92 289,92 C289.17,92 289.83,92 290,92 C290.17,92 290.83,92 291,92 C291.17,92 291.83,92 292,92 C292.17,92 292.83,92 293,92 C293.17,92 293.83,92 294,92 C294.17,92 294.83,92 295,92 C295.17,92 295.83,92 296,92 C296.17,92 296.83,92 297,92 C297.17,92 297.83,92 298,92 C298.17,92 298.83,92 299,92 C299.17,92 299.83,92 300,92 C300.17,92 300.83,92 301,92 C301.17,92 301.83,92 302,92 C302.17,92 302.83,92 303,92 C303.17,92 303.83,92 304,92 C304.17,92 304.83,92 305,92 C305.17,92 305.83,92 306,92 C306.17,92 306.83,92 307,92 C307.17,92 307.83,92 308,92 C308.17,92 308.83,92 309,92 C309.17,92 309.83,92 310,92 C310.17,92 310.83,92 311,92 C311.17,92 311.83,92 312,92 C312.17,92 312.83,92 313,92 C313.17,92 313.83,92 314,92 C314.17,92 314.83,92 315,92 C315.17,92 315.83,92 316,92 C316.17,92 316.83,92 317,92 C317.17,92 317.83,92 318,92 C318.17,92 318.83,92 319,92",
} as const;

/** The conversation. */
export const CHAT = {
	conversationTitle: "Conversation 1",
	emptyState: "No messages yet. Ask the agent to cut silences, tighten pauses, or add captions.",
	authorUser: "You",
	authorAssistant: "OpenScreen",
	userPrompt: "Cut the dead time in this recording: long pauses, silences, and idle stretches where nothing is being said or done. Keep the pacing tight and natural, and do not cut anything a viewer needs. Apply the edits directly to the timeline.",
	agentReply: [
		{
			kind: "p",
			runs: [
				{
					text: "Here's what I found and cut:",
					strong: false,
				},
			],
		},
		{
			kind: "p",
			runs: [
				{
					text: "Finding:",
					strong: true,
				},
				{
					text: " The speech itself is nearly gapless — every pause between spoken words is well under a second, so there were no internal silences to remove. The only silences over 1s were at the two ends:",
					strong: false,
				},
			],
		},
		{
			kind: "p",
			runs: [
				{
					text: "Cuts applied (both on your single placed clip, which is untouched otherwise):",
					strong: true,
				},
			],
		},
		{
			kind: "li",
			runs: [
				{
					text: "0–2.19s",
					strong: true,
				},
				{
					text: " — the 2.2s dead lead-in before \"Hi,\" (cut)",
					strong: false,
				},
			],
		},
		{
			kind: "li",
			runs: [
				{
					text: "35.12–40.03s",
					strong: true,
				},
				{
					text: " — the ~4.9s dead tail after \"think.\" (cut)",
					strong: false,
				},
			],
		},
		{
			kind: "p",
			runs: [
				{
					text: "The video now runs from \"Hi,\" straight through to \"think.\" — about ",
					strong: false,
				},
				{
					text: "7 seconds shorter",
					strong: true,
				},
				{
					text: " (40.0s → 33.0s of playable footage).",
					strong: false,
				},
			],
		},
		{
			kind: "p",
			runs: [
				{
					text: "Your zooms (incl. the manual 1.8×/2.2× punches) stay anchored to the same moments in the narration.",
					strong: false,
				},
			],
		},
		{
			kind: "p",
			runs: [
				{
					text: "One note: the cut starts the video right at the first word with no lead-in. If you'd rather keep a half-second of breathing room before \"Hi,\" say the word and I'll restore a short lead.",
					strong: false,
				},
			],
		},
	],
	agentReplyText: "Here's what I found and cut:\n\n**Finding:** The speech itself is nearly gapless — every pause between spoken words is well under a second, so there were no internal silences to remove. The only silences over 1s were at the two ends:\n\n**Cuts applied (both on your single placed clip, which is untouched otherwise):**\n\n- **0–2.19s** — the 2.2s dead lead-in before \"Hi,\" (cut)\n- **35.12–40.03s** — the ~4.9s dead tail after \"think.\" (cut)\n\nThe video now runs from \"Hi,\" straight through to \"think.\" — about **7 seconds shorter** (40.0s → 33.0s of playable footage).\n\nYour zooms (incl. the manual 1.8×/2.2× punches) stay anchored to the same moments in the narration.\n\nOne note: the cut starts the video right at the first word with no lead-in. If you'd rather keep a half-second of breathing room before \"Hi,\" say the word and I'll restore a short lead.",
	applied: "applied: added 2 trims",
	composerPlaceholder: "Describe the edit you want.",
	modelChip: "deepseek-v4-flash",
} as const;

/** The preview frame's geometry, and the loop that plays inside it. */
export const STAGE = {
	aspectRatio: "16:9",
	wallpaper: "/wallpapers/wallpaper5.jpg",
	padding: 55,
	paddingFit: 0.78,
	borderRadius: 40,
	frame: {
		width: 1071,
		height: 603,
	},
	contentBox: {
		width: 835,
		height: 470,
	},
	screen: {
		width: 835,
		height: 470,
	},
	webcam: null,
	webcamReason: "assets[0].cameraTrack.visible is false and legacyEditor.webcamLayoutPreset is \"no-webcam\" — there is no bubble to draw",
} as const;
export const LOOP = {
	startSec: 17.5,
	contentEndSec: 24.3,
	contentDurationSec: 6.8,
	durationSec: 7,
	dissolveSec: 0.6,
	holdSec: 0.2,
	zoomScale: 2.2,
	crop: {
		w: 872,
		h: 490,
		x: 524,
		y: 295,
	},
	src: "/video/canvas-loop.mp4",
	srcSmall: "/video/canvas-loop-sm.mp4",
	poster: "/img/walkthrough/canvas-poster.jpg",
	width: 836,
	height: 470,
	widthSmall: 640,
	heightSmall: 360,
	timeMapping: "startSec + min(currentTime, contentDurationSec)",
} as const;

/** The three facet panels the scroll opens before the transcript, with every
 *  control's label as the app's locale files spell it. */
export const PANELS = {
	background: {
		title: "Background",
		tabs: [
			"Image",
			"Color",
			"Gradient",
		],
		uploadCustom: "Upload image",
		wallpaperCount: 18,
		swatchLabels: [
			"Background 1",
			"Background 2",
			"Background 3",
			"Background 4",
			"Background 5",
			"Background 6",
			"Background 7",
			"Background 8",
			"Background 9",
			"Background 10",
			"Background 11",
			"Background 12",
			"Background 13",
			"Background 14",
			"Background 15",
			"Background 16",
			"Background 17",
			"Background 18",
		],
	},
	effects: {
		title: "Composition",
		padding: "Padding",
		blurBg: "Blur background",
		motionBlur: "Motion blur",
		shadow: "Shadow",
		roundness: "Roundness",
	},
	cursor: {
		title: "Cursor",
		show: "Show cursor",
		size: "Size",
		smoothing: "Smoothing",
	},
} as const;

/** The padding formula's coefficients, so the slider moves the composite by the
 *  app's own arithmetic rather than by a number that looks about right. */
export const EFFECTS = {
	paddingDefault: 55,
	borderRadiusDefault: 40,
	paddingFitFactor: 0.4,
	paddingFitMin: 0.4,
} as const;

/** Every slider and toggle on those panels, at this document's settings, scaled
 *  and suffixed the way RightPanes.tsx scales and suffixes it. */
export const CONTROLS = {
	padding: {
		label: "Padding",
		value: 55,
		min: 0,
		max: 100,
		suffix: "%",
		display: "55%",
	},
	blurBg: {
		label: "Blur background",
		on: true,
	},
	motionBlur: {
		label: "Motion blur",
		value: 30,
		min: 0,
		max: 100,
		suffix: "%",
		display: "30%",
	},
	shadow: {
		label: "Shadow",
		value: 35,
		min: 0,
		max: 100,
		suffix: "%",
		display: "35%",
	},
	roundness: {
		label: "Roundness",
		value: 40,
		min: 0,
		max: 64,
		suffix: "px",
		display: "40px",
	},
	cursorShow: {
		label: "Show cursor",
		on: true,
	},
	cursorSize: {
		label: "Size",
		value: 45,
		min: 5,
		max: 100,
		suffix: "",
		display: "45.0",
	},
	smoothing: {
		label: "Smoothing",
		value: 35,
		min: 0,
		max: 100,
		suffix: "%",
		display: "35%",
	},
} as const;

/** The cursor art the page draws, each sprite with the application's own
 *  hotspot, normalised to a fraction of the sprite. */
export const CURSORS = {
	themes: [
		{
			id: "default",
			name: "Default",
			hotspotX: 0.119,
			hotspotY: 0.0874,
			src: "/img/cursors/00-arrow.png",
		},
	],
	pointer: {
		name: "Default",
		hotspotX: 0.3893,
		hotspotY: 0.0032,
		src: "/img/cursors/mac-pointer.png",
	},
	text: {
		name: "Default",
		hotspotX: 0.4375,
		hotspotY: 0.5333,
		src: "/img/cursors/mac-text.png",
	},
} as const;

export const TRANSPORT = {
	restCurrent: "0:17.5",
	endCurrent: "0:24.3",
	total: "0:40.0",
	restLeftPct: 43.7139,
	endLeftPct: 60.6999,
} as const;
export const TOOLBAR = {
	aspectRatio: "16:9",
	panKbd: "Shift+Scroll",
	panLabel: "Pan",
	zoomKbd: "Ctrl+Scroll",
	zoomLabel: "Zoom",
	clipLabel: "Bellrock — docs walkthrough",
} as const;

/** The app's dark tokens, read out of design-tokens.css. */
export const TOKENS = {
	surface: "#14181f",
	surface1: "#191d26",
	surface2: "#1c2029",
	surface3: "#252a35",
	border: "#252a35",
	borderHi: "#3a4150",
	fg: "#e6e9ef",
	fg2: "#f3f5f8",
	muted: "#8b95a3",
	meta: "#8b95a3",
	metaInApp: "#7a8491",
	accent: "#10b981",
	danger: "#f87171",
	playhead: "#6c55ff",
} as const;

/** One entry per string on screen. */
export const PROVENANCE: ProvenanceEntry[] = [
	{ shown: "Transcript", source: "src/i18n/locales/en/settings.json → transcript.title" },
	{ shown: "Clip 1 · 0:00.0—0:40.0", source: "computed: settings.json transcript.clipLabel with index 1, joined to formatMs(0) and formatMs(40033) from src/lib/ai-edition/timeline/format.ts" },
	{ shown: "Bellrock — docs walkthrough", source: "fixture assets[0].label" },
	{ shown: "[silence 2.2s]", source: "computed: settings.json transcript.silence over the 2.190s gap 0–2.19 that buildClipSection inserted at SILENCE_THRESHOLD_SEC 0.2; inside trimRange trim_f52989cf-489c-47f5-a6c7-b95a7d71b399" },
	{ shown: "[silence 0.2s]", source: "computed: settings.json transcript.silence over the 0.230s gap 27.09–27.32 that buildClipSection inserted at SILENCE_THRESHOLD_SEC 0.2; outside any trim" },
	{ shown: "[silence 4.9s]", source: "computed: settings.json transcript.silence over the 4.913s gap 35.12–40.033 that buildClipSection inserted at SILENCE_THRESHOLD_SEC 0.2; inside trimRange trim_3bad6006-721a-4dd4-a218-091fa734a63e" },
	{ shown: "Hi, quick walk through the documentation site. The new release went out this morning. The hero does the work now. One line, one promise, and the install command right under it. Scrolling down, those six cards are the whole library on one screen. No page gets more than a sentence. Over on status, every component with 30 days of probes behind it. One amber day on the validator, and it recovered, and releases. Three of them, newest first, and every line links into the commit that did it. Back to the top, and that is the whole flow. Tell me what you think.", source: "fixture transcript.words, rejoined in start order; every entry is rendered as its own span" },
	{ shown: "Conversation 1", source: "computed: editor.json chat.untitledConversation + the session index, as LeftPanel.tsx:1184 renders it" },
	{ shown: "No messages yet. Ask the agent to cut silences, tighten pauses, or add captions.", source: "editor.json chat.emptyState" },
	{ shown: "You", source: "editor.json chat.authorUser" },
	{ shown: "OpenScreen", source: "editor.json chat.authorAssistant" },
	{ shown: "Cut the dead time in this recording: long pauses, silences, and idle stretches where nothing is being said or done. Keep the pacing tight and natural, and do not cut anything a viewer needs. Apply the edits directly to the timeline.", source: "src/components/ai-edition/v4/V4Timeline.tsx AI_ENHANCE_PROMPT, lifted verbatim as source text" },
	{ shown: "Here's what I found and cut:\n\n**Finding:** The speech itself is nearly gapless — every pause between spoken words is well under a second, so there were no internal silences to remove. The only silences over 1s were at the two ends:\n\n**Cuts applied (both on your single placed clip, which is untouched otherwise):**\n\n- **0–2.19s** — the 2.2s dead lead-in before \"Hi,\" (cut)\n- **35.12–40.03s** — the ~4.9s dead tail after \"think.\" (cut)\n\nThe video now runs from \"Hi,\" straight through to \"think.\" — about **7 seconds shorter** (40.0s → 33.0s of playable footage).\n\nYour zooms (incl. the manual 1.8×/2.2× punches) stay anchored to the same moments in the narration.\n\nOne note: the cut starts the video right at the first word with no lead-in. If you'd rather keep a half-second of breathing room before \"Hi,\" say the word and I'll restore a short lead.", source: "photograph: static/img/walkthrough/04-agent-a.jpg — hand-transcribed; the conversation is in no store on disk and this photograph is its only existence. THE WEAKEST PROVENANCE ON THE PAGE. Every timecode, duration, quoted word and cut total in it is regenerated from timeline.trimRanges and transcript.words, not transcribed. Two figures are transcribed as the model wrote them and disagree with this file's arithmetic on purpose: \"33.0s\" (recomputed: 32.93s) and \"1.8×/2.2×\" (the pills read 1.80×/2.20×). The page is quoting a message, not drawing a readout." },
	{ shown: "applied: added 2 trims", source: "computed: editor.json chat.appliedPrefix + the bulk-add tool's own wording (electron/ai-edition/agent-tools.ts: added ${n} ${noun}s) with n = 2, the trimRanges whose origin is \"agent\"" },
	{ shown: "Describe the edit you want.", source: "editor.json chat.composerPlaceholder" },
	{ shown: "deepseek-v4-flash", source: "photograph: static/img/walkthrough/editor-1560.jpg — what was on screen when the plate was shot. NOT in provider-registry.ts; it was typed into an OpenAI-compatible provider config. The one visible string whose referent cannot be verified in the source, kept because the photographs beside it already ship it." },
	{ shown: "1.80×", source: "computed: effectiveZoomScale(zoomRanges depth 3).toFixed(2) + \"×\" from src/lib/ai-edition/timeline/zoom-scale.ts" },
	{ shown: "2.20×", source: "computed: effectiveZoomScale(zoomRanges depth 4).toFixed(2) + \"×\" from src/lib/ai-edition/timeline/zoom-scale.ts" },
	{ shown: "1.80×", source: "computed: effectiveZoomScale(zoomRanges depth 3).toFixed(2) + \"×\" from src/lib/ai-edition/timeline/zoom-scale.ts" },
	{ shown: "0:02.2", source: "computed: formatSec(2.19 − 0) over trimRange trim_f52989cf-489c-47f5-a6c7-b95a7d71b399" },
	{ shown: "0:04.9", source: "computed: formatSec(40.033 − 35.12) over trimRange trim_3bad6006-721a-4dd4-a218-091fa734a63e" },
	{ shown: "Press A to add annotation", source: "timeline.json hints.pressAnnotation — rendered because the document holds no annotation regions" },
	{ shown: "Press S to add speed", source: "timeline.json hints.pressSpeed — rendered because the document holds no speed regions" },
	{ shown: "Press C to add a Full Camera segment", source: "timeline.json hints.pressCameraFullscreen — rendered because the document holds no cameraFullscreen regions" },
	{ shown: "0:00 0:02 0:04 0:06 0:08 0:10 0:12 0:14 0:16 0:18 0:20 0:22 0:24 0:26 0:28 0:30 0:32 0:34 0:36 0:38 0:40", source: "computed: fmtTick lifted from V4Timeline.tsx over a 2s step, itself derived as the first TICK_STEPS_SEC entry clearing MIN_LABEL_GAP_PX 76 at 47.9604 px/s" },
	{ shown: "0:40.0", source: "computed: formatSec(assets[0].durationSec = 40.033)" },
	{ shown: "0:17.5", source: "computed: formatSec(zoomRanges[1].sourceStartSec = 17.5) — where the loop starts" },
	{ shown: "16:9", source: "fixture legacyEditor.aspectRatio" },
	{ shown: "Shift+Scroll Pan", source: "computed: timeline.json labels.pan, with the key hint V4Timeline.tsx:1474 writes beside it" },
	{ shown: "Ctrl+Scroll Zoom", source: "computed: timeline.json labels.zoom, with the key hint V4Timeline.tsx:1477 writes beside it" },
	{ shown: "Bellrock — docs walkthrough", source: "fixture assets[0].label, as the clip card's own label" },
	{ shown: "Background", source: "src/i18n/locales/en/settings.json → background.title" },
	{ shown: "Image", source: "src/i18n/locales/en/settings.json → background.image" },
	{ shown: "Color", source: "src/i18n/locales/en/settings.json → background.color" },
	{ shown: "Gradient", source: "src/i18n/locales/en/settings.json → background.gradient" },
	{ shown: "Upload image", source: "src/i18n/locales/en/settings.json → background.uploadCustom" },
	{ shown: "Background 1", source: "computed: settings.json background.imageLabel over the 18 wallpapers WALLPAPER_COUNT declares in src/lib/wallpaper.ts" },
	{ shown: "Composition", source: "src/i18n/locales/en/settings.json → effects.title" },
	{ shown: "Padding", source: "src/i18n/locales/en/settings.json → effects.padding" },
	{ shown: "Blur background", source: "src/i18n/locales/en/settings.json → effects.blurBg" },
	{ shown: "Motion blur", source: "src/i18n/locales/en/settings.json → effects.motionBlur" },
	{ shown: "Shadow", source: "src/i18n/locales/en/settings.json → effects.shadow" },
	{ shown: "Roundness", source: "src/i18n/locales/en/settings.json → effects.roundness" },
	{ shown: "Cursor", source: "src/i18n/locales/en/settings.json → cursor.title" },
	{ shown: "Show cursor", source: "src/i18n/locales/en/settings.json → cursor.show" },
	{ shown: "Size", source: "src/i18n/locales/en/settings.json → cursor.size" },
	{ shown: "Smoothing", source: "src/i18n/locales/en/settings.json → cursor.smoothing" },
];

/** What check-recreation.mjs asserts against. */
export const MARKUP = {
	pills: PILLS,
	hints: LANES.filter((lane) => lane.hint !== null).map((lane) => lane.id),
	words: WORDS,
	contrastPairs: [
	[
		"#e6e9ef",
		"#14181f",
		"transcript word on the inspector",
	],
	[
		"#8b95a3",
		"#191d26",
		"clip range on the inspector",
	],
	[
		"#8b95a3",
		"#14181f",
		"lane hint on the floor",
	],
	[
		"#8b95a3",
		"#14181f",
		"ruler label on the floor",
	],
	[
		"#10b981",
		"#14181f",
		"zoom pill label",
	],
	[
		"#f87171",
		"#14181f",
		"trim pill label and struck silence",
	],
	[
		"#e6e9ef",
		"#1c2029",
		"chat message body",
	],
	[
		"#8b95a3",
		"#14181f",
		"chat author label",
	],
	[
		"#10b981",
		"#14181f",
		"applied line",
	],
	[
		"#8b95a3",
		"#191d26",
		"composer placeholder",
	],
] as [string, string, string][],
} as const;
