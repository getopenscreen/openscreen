// ponytail: port of axcut's AxcutDeepAgentService (apps/server/src/services/
// axcut-deep-agent.ts). Wraps LangChain's `createAgent` (LangGraph ReAct graph)
// with our existing document tools and emits agent.text / agent.toolStart /
// agent.toolEnd / agent.error events into a sink the chat-service pipes through
// `webContents.send`.
//
// It used to wrap `createDeepAgent` from the `deepagents` package. That factory
// stacks three middlewares unconditionally — filesystem, todo-list, sub-agents —
// which handed the model EIGHT extra tools (ls / read_file / write_file /
// edit_file / glob / grep / write_todos / task) bound to an EMPTY in-memory
// backend, plus ~5 800 characters of system prompt promising a filesystem this
// app does not have. Nothing here used any of it, and the cost was not
// cosmetic: asked what cursor telemetry the project holds, the model ran
// `ls {"path":"/"}` then `glob {"pattern":"**/*"}` against that empty sandbox
// and reported, in good faith, that the project contains no pointer data. A
// fabricated proof of absence. `createDeepAgent` has no option to drop those
// middlewares (they are in `REQUIRED_MIDDLEWARE_NAMES`), so the fix is to stop
// going through it: `createAgent` is what it wrapped, minus the sandbox.

import { anthropicPromptCachingMiddleware, createAgent, tool } from "langchain";
import { z } from "zod";
import type { CursorTelemetryPoint } from "../../../src/components/video-editor/types";
import {
	CAPTION_FONT_SIZE_MAX,
	CAPTION_FONT_SIZE_MIN,
	CAPTION_INSET_X_MAX,
	CAPTION_INSET_Y_MAX,
	CAPTION_PLATE_OPACITY_MAX,
	CAPTION_PLATE_OPACITY_MIN,
} from "../../../src/lib/ai-edition/captions";
import {
	CAPTION_WORDS_PER_LINE_MAX,
	CAPTION_WORDS_PER_LINE_MIN,
} from "../../../src/lib/ai-edition/captions/wordsPerLine";
import { AUDIO_FADE_MAX_MS } from "../../../src/lib/ai-edition/document/audioTracks";
import { VOCABULARY_MAX_CHARS } from "../../../src/lib/ai-edition/document/transcript";
import type { AxcutDocument } from "../../../src/lib/ai-edition/schema";
import type { ShaderEffectChecker } from "../../../src/lib/ai-edition/shaderEffects";
import { collectAutoZoomSuggestionsForDocument } from "../../../src/lib/ai-edition/timeline/apply-auto-zooms";
// ponytail: the legend is DERIVED from the depth→scale table, not retyped. Both
// tool descriptions used to assert "depth 1–6 maps to 1.0×–3.5×" — a formula
// (`depth/2 + 0.5`) that was purged from two rendering sites and survived here,
// wrong at both ends of a table that actually runs 1.25× to 5.0×.
import {
	MAX_ZOOM_SCALE,
	MIN_ZOOM_SCALE,
	ZOOM_DEPTH_LEGEND,
} from "../../../src/lib/ai-edition/timeline/zoom-scale";
import { ZOOM_TRANSITION_LEGEND } from "../../../src/lib/ai-edition/timeline/zoom-transitions";
import type { SegmentationSupport } from "../../../src/native/contracts";
import {
	AGENT_EDITS_SETTING,
	type AgentToolExecution,
	type AutoZoomPlan,
	addAnnotationArgs,
	addAudioArgs,
	addAutoZoomsArgs,
	addCameraFullscreenArgs,
	addEffectArgs,
	addSpeedArgs,
	addTrimArgs,
	addTrimsArgs,
	addZoomArgs,
	addZoomsArgs,
	type CursorTelemetryLoad,
	duplicateClipArgs,
	executeAgentTool,
	getCursorTrackArgs,
	getEffectArgs,
	getTranscriptArgs,
	getTranscriptWordsArgs,
	insertClipArgs,
	isMutatingTool,
	moveClipArgs,
	removeClipArgs,
	removeModifierArgs,
	removeTrimArgs,
	removeWordsArgs,
	replaceTimelineArgs,
	resolveCursorAssetId,
	setAnnotationArgs,
	setAspectRatioArgs,
	setAudioArgs,
	setCameraFullscreenArgs,
	setClipRangeArgs,
	setEffectArgs,
	setEffectDefinitionArgs,
	setSpeedArgs,
	setTrimArgs,
	setWordTextArgs,
	setZoomArgs,
	shaderEffectCheckLookup,
	shaderEffectToCheck,
} from "../agent-tools";
import {
	getCaptionsArgs,
	getCaptionTranslationUnitsArgs,
	putCaptionTranslationArgs,
	removeCaptionTranslationArgs,
	setCaptionSettingsArgs,
	setVocabularyArgs,
} from "../caption-tools";
import { setEditorSettingsArgs } from "../editor-settings-tool";
import {
	createOpenScreenChatModel,
	messageContentToText,
	messageContentToThinking,
	type OpenScreenChatModelConfig,
} from "./chat-model";

export interface OpenScreenAgentSink {
	text: (delta: string) => void;
	/** Streaming delta from the model's reasoning block (Anthropic/MiniMax
	 * thinking). Provider-agnostic — for providers without thinking this is
	 * never called. The chat panel uses it to surface the reasoning phase
	 * that would otherwise be invisible "dead air" while the model thinks. */
	thinking: (delta: string) => void;
	toolStart: (name: string, args: unknown) => void;
	toolEnd: (name: string, ok: boolean, summary?: string) => void;
	error: (message: string) => void;
}

// The tool arg schemas live in agent-tools.ts (imported above) — one source of truth for
// both the executor's validation and the LangChain `tool()`s built here. Only the empty /
// inline read-tool schemas below stay local.

/**
 * The block appended when the user has turned edits off: "Agent edits" for the
 * in-app agent, "MCP edits" for an MCP client; `setting` names the one in force.
 *
 * ponytail: the executor's refusal is the wall (see `consentRequired` in
 * agent-tools.ts) but a wall alone does not fix the measured defect. The
 * workbench scores `dsl.consent.no-silent-edit` on the tool_calls the model
 * EMITS, not on what the executor did with them, so a turn that fires three
 * writes and has them all refused still reads as a silent-edit attempt — and
 * rightly: the model tried. Only the prompt can stop the emission. Two layers,
 * neither sufficient alone.
 */
const consentPromptBlock = (setting: string) =>
	[
		"",
		"PROJECT EDITS ARE CURRENTLY DISABLED by the user, who asked to be consulted before the timeline changes.",
		"- Read freely: getCurrentDocument and getTranscript work as usual.",
		"- Do NOT call any tool that writes (removeWords, addTrim, setTrim, setClipRange, moveClip, replaceTimeline, add*/set* effects and settings, putCaptionTranslation, remove*). Every one of them will be refused, so calling them wastes the turn and tells the user nothing.",
		"- Instead: say precisely what you would change — which tool, which times, which ids — and ask the user to confirm. Be specific enough that they can say yes to it.",
		`- Never state or imply that an edit was applied. If the user confirms and you are still refused, tell them to turn on ${setting} first.`,
	].join("\n");

// ponytail: exported so a test can assert that what the model receives is this
// string and NOTHING else — the deepagents regression was invisible precisely
// because the middlewares appended their prompts downstream of this constant.
const BASE_SYSTEM_PROMPT = [
	"You are an AI video editor working inside OpenScreen. The user is editing a recording.",
	"Help them cut silences, tighten pacing, add captions, and rewrite titles.",
	"Be concise, action-oriented, and reference the timeline or transcript by time when relevant.",
	"You can call the tools below against the live document snapshot; the runtime executes each edit and feeds the result back into the loop.",
	"The AxcutDocument is the single source of truth. The timeline, the transcript editor, and the chat panel are all direct editors of the same document — when the user places a clip on the timeline, the document updates immediately, and when the timeline is empty, the document has no clips. Your edits operate on the live document, so preserve the user's placed clips.",
	"",
	"Time-bases (do not mix them up): clips and trims are in SOURCE-time seconds of an asset; zooms, speed regions, annotations, camera-fullscreen regions and effects are in VIRTUAL (edited-timeline) seconds — the position on the editor's ruler, where the clips sit end to end. A trim leaves a hole in that ruler rather than shortening it, and a speed region does not stretch it, so the exported video's own clock differs from it as soon as there is a trim or a speed region: always place effects in ruler seconds. getCurrentDocument returns all of them, clearly labelled.",
	"",
	// ponytail: these describe what each tool is FOR, deliberately without quoting
	// user phrasings. A phrase→tool table reads as helpful and is not: it swaps the
	// model's language understanding for a lookup, so it covers the wordings we
	// happened to list and silently misses every paraphrase — and every language
	// other than English. Say what the tool does; let the model do the matching.
	"How the tools map to intent — pick the most specific one, and prefer the smallest edit that satisfies the request:",
	"- Silences, pauses and dead stretches are removed as trims INSIDE the placed clip. Send them together with addTrims once you know the ranges; addTrim is for a single cut or a correction. The placed clip stays the canonical cut; it is not rebuilt to drop them.",
	"- Cutting specific spoken words (fillers, a repeated or flubbed phrase, a false start, a duplicate take) is removeWords: read getTranscriptWords, choose the occurrences from their surrounding speech, then pass that assetId and ONLY those word IDs. Word IDs restart for each asset, so keep the read's assetId. Consecutive words become one cut. Do not cut every occurrence of a word just because its text matches one you were asked to remove.",
	"- Changing where a clip starts or ends within its source is setClipRange — the clip's in/out, distinct from a trim. It also crops the clip (cropRegion).",
	"- insertClip places footage of any video asset at a position on the timeline; duplicateClip copies a clip right after itself. addAutoZooms plans zooms on the recorded clicks, as the timeline's Automatic zooms does.",
	`- addZoom takes a virtual-timeline span (depth is an ordinal 1–6 selecting from a fixed table — ${ZOOM_DEPTH_LEGEND} — never a multiplier; focus in 0–1 frame fractions). addSpeed changes pacing over a span. addAnnotation puts text, an arrow or a privacy blur on screen: a blur is how an email address, a token or any private detail the recording shows is hidden. addCameraFullscreen enlarges the webcam, and only does something where assets[].hasCameraTrack is true.`,
	"- setEditorSettings sets the look of the whole video: the background (wallpaper, its motion and blur), padding, rounded corners, shadow, a device frame, motion blur, depth of field, the shape of the video (aspectRatio: auto follows the recording) and how a recording of another shape fills it, the camera's layout (picture-in-picture, side by side, stacked, its shape, size, position, framing and background cutout), the cursor, and the master volume. getCurrentDocument returns all of them under settings, in the shape this tool takes, and settingsContext.inactive names each one the editor hides in the current state and why: setting one of those changes nothing, so say so instead of reporting the look as changed. setAspectRatio is the same write for the shape alone.",
	"- A zoom animates in just before its span and out just after it (zoomInFromSec, zoomOutUntilSec in getCurrentDocument). Leave those windows untrimmed, or the export jumps at the cut.",
	"- addAudio lays an imported voiceover or music file over a span. It plays an asset the project already has (kind 'audio'); importing or recording one is the editor's job, not a tool you have — so when the project has none, say so rather than naming an id that does not exist.",
	"- moveClip changes the order of placed clips, one call per clip that moves, preserving ids, source ranges, trims and anchored effects. replaceTimeline rebuilds the timeline from kept intervals and sorts them, so it cannot reorder anything.",
	"- Captions are the transcript drawn on the video, never typed in: setCaptionSettings turns them on, styles and places them, getCaptions reads them back. To caption in another language, read the phrases with getCaptionTranslationUnits, translate them yourself, store them with putCaptionTranslation, then show that language with setCaptionSettings. A translation never rewrites the transcript. For text the speaker did not say, use addAnnotation.",
	"- A visual effect the settings do not offer (a ripple on clicks, a glitch on a cut, a color grade) is written as a shader with addEffect; setEffect re-tunes or moves it, setEffectDefinition changes its code, getEffect reads its code.",
	"- Deleting is a first-class action, not a workaround: removeTrim, removeModifier, removeClip. Never fake a deletion by re-adding an element or zeroing it out (span 0, speed 1×) — that leaves it in the document and misreports what you did.",
	"If nothing in the list does what was asked, say so; do not approximate it with a bigger tool.",
	"",
	"Cursor telemetry: while the screen was captured, OpenScreen recorded where the pointer went. assets[].hasCursorTelemetry in getCurrentDocument says which assets carry it, and getCursorTrack returns the recorded track for one of them — positions over time, and the pointer shape at each moment. What it means is yours to read.",
	"Blindness is not evidence. When a tool reports it could not read something (reason 'unavailable'), that is a limit of your runtime, not a fact about the project. Only an explicit negative — reason 'no-sidecar', or a false flag — supports telling the user the data is not there.",
	"",
].join("\n");

// Exporting is the example of a missing tool only where there is none: `openscreen mcp` has exportVideo.
const honestyRules = (canExport: boolean) =>
	`Honesty rules: if a request has NO matching tool (e.g. deleting an asset/recording${canExport ? "" : ", exporting"}), say so plainly — do not substitute a different edit and report it as the requested one. After your edits, if you are at all unsure the document ended up as intended, call getCurrentDocument and reconcile what you claim with the real state; each tool result already tells you exactly what it did, so never report a change the results don't support.`;

/** The system prompt for a turn: whether the user currently allows writes, and through
 *  which setting. The MCP server reuses it as its instructions, naming its own setting
 *  and, over stdio, the export tool it serves. Exported so the wording can be tested
 *  without a provider. */
export function buildSystemPrompt(options: {
	editsAllowed: boolean;
	/** Where the user turns writes back on. Default: the in-app agent's switch. */
	editsSetting?: string;
	/** The caller also has a tool that exports the video. */
	canExport?: boolean;
}): string {
	const prompt = BASE_SYSTEM_PROMPT + honestyRules(options.canExport === true);
	return options.editsAllowed
		? prompt
		: prompt + consentPromptBlock(options.editsSetting ?? AGENT_EDITS_SETTING);
}

/** The prompt of a normal (edits-allowed) turn — the overwhelmingly common
 *  case, and the string the surface tests measure the wire against. */
export const SYSTEM_PROMPT = buildSystemPrompt({ editsAllowed: true });

// #1028: a zoom's camera moves sit OUTSIDE its span, where nothing on the ruler shows them.
// The editor's "3D camera" control, in the agent's words.
const ZOOM_CAMERA_NOTE =
	"rotationPreset is the zoom's 3D camera: `left` or `right` turns the screen in 3D to that side, `orbit` moves the camera around the screen while the zoom holds, `none` (the default) keeps it flat. It is a strong effect: keep it for a reveal or a key moment, not every zoom. getCurrentDocument reports it as rotationPreset, absent when flat.";

const ZOOM_BEHAVIOUR_NOTE = `The zoom pane's other settings: focusMode "manual" holds focus, "auto" follows the recorded pointer instead (getCurrentDocument reports the effective mode, auto everywhere while autoFocusAll is on); hideCursor hides the pointer while the zoom is on screen; customScale is a free level in place of depth, a factor from ${MIN_ZOOM_SCALE} to ${MAX_ZOOM_SCALE} rounded to the hundredth. A level the depth table has is stored as that depth, and one deeper than the clip takes before its recording blurs is refused with the limit, as the editor refuses it. Pass depth or customScale, not both.`;

const ZOOM_TRANSITIONS_NOTE = `A zoom HOLDS over its span: it animates in during the window just before startSec and out during the window just after endSec. Each move lasts 0.6 s + 0.55 s × ln(renderedScale) of SCREEN time (${ZOOM_TRANSITION_LEGEND}), so a speed region scales the timeline it covers by its speed: longer above 1×, shorter below. getCurrentDocument gives each zoom's zoomInFromSec and zoomOutUntilSec, in virtual seconds like the zoom. A trim inside either window cuts that move and the export jumps at the cut: leave the windows untrimmed. Two zooms at most 1.5 s apart on screen, on the same clip with no trim between them, are chained: the camera pans from one to the next over 1 s of screen time from the first one's end (panUntilSec), with no zoom-out or zoom-in between them.`;
const CUT_TRANSITIONS_RESULT = `When the result cuts a zoom's move in or out, it carries \`cutTransitions\`: which zoom, which side, cutSec, the timeline seconds of the move lost, and by: trim, or junction when the move runs past its clip's edge into the next clip. It is a warning, nothing is refused: move the cut or the zoom unless a hard cut is what you want.`;

export const TOOL_DESCRIPTIONS: Record<string, string> = {
	getCurrentDocument:
		"Read a compact snapshot of the current project: assets (with durations), timeline clips and trim ranges (source-time), and the zoom / speed / annotation / camera-fullscreen / audio / effect regions (virtual, edited-timeline time), each with the settings its writes take: a zoom's level, focus mode and hidden cursor, an annotation's type, box, look and arrow or blur data, an audio track's level and fades. It also gives the project's look under `settings`, in the shape setEditorSettings takes, with `settingsContext`: the formats, wallpapers and cursor themes on offer, and under `inactive` each setting the editor hides in the current state and why. Call this before editing if the snapshot in the system prompt may be stale. The AxcutDocument is the single source of truth — your edits should preserve the user's placed clips and any timeline state they have already set up.",
	getTranscript:
		"Read the transcript segments (speech and silence, with start/end seconds and text) for an asset. Omit assetId to read the primary asset's transcript.",
	getCursorTrack:
		"Read the recorded pointer track for an asset: where the cursor was over time, downsampled to a readable rate. Each point carries atSec (the asset's own source clock), virtualSec (the same instant on the edited timeline — the coordinate addZoom takes, null when no clip carries it), cx/cy as 0–1 fractions of the frame, and `shape`, an index into the pointer bitmaps the recording used (equal values are the same pointer; a change means the pointer changed, e.g. arrow to text caret). Points that are not plain moves carry `kind`; points a trim cuts out of playback carry `trimmed`; points where the pointer was hidden carry `visible:false`. These are real samples, not a summary — reading what the pointer was doing is yours. Omit assetId for the primary asset. It answers `available:false` in two DIFFERENT ways you must not confuse: reason 'no-sidecar' means this asset was checked and genuinely has no telemetry, while reason 'unavailable' means it could not be read from here.",
	getTranscriptWords:
		'Read the transcript one WORD at a time for an asset: each word\'s id, text, start/end seconds, and — only when it is not plain transcription — `source` ("user" for a word the user corrected, "synth" for one they typed in) and `originalText` (what the transcriber had heard before the correction). This is the ONLY read that gives you the ids setWordText and removeWords take; getTranscript answers in segments, whose ids belong to a different namespace and are not accepted there. A whole transcript is large, so pass startSec/endSec to read just the passage you mean to fix. Omit assetId for the primary asset.',
	setWordText:
		"Correct ONE word's text, by the id getTranscriptWords returns. This changes the TRANSCRIPT and nothing else: the captions follow it, the film is untouched and no audio is cut. Use it when the transcriber misheard something — a name, a technical term — and the user asks for it to read correctly. Passing an empty string BLANKS the word: it keeps its place in the media but leaves the captions, which is how a junk token like \"(inaudible)\" is removed without cutting the speech around it. Writing the transcriber's own text back clears the correction. This is NOT how you make a spoken word go away — that removes only the label and leaves the film saying it; use removeWords, which cuts the audio with it.",
	removeWords:
		"Cut the spoken words selected by `wordIds` from getTranscriptWords out of the film: fillers, a repeated or flubbed phrase, a false start, a duplicate take. Pass the same `assetId` as that read: word IDs are numbered independently in each asset. Omit assetId only when the IDs are unique across all transcripts. Read words in context and choose the IDs yourself; the executor does not classify speech or remove every matching text. It resolves each ID to one recorded asset, valid source timestamps, and exactly one fully covering clip, then adds non-destructive trims; words that follow one another in the transcript become ONE trim, so a phrase goes out whole, gaps included. If any ID is missing, invalid, duplicated, already cut or ambiguous, nothing changes. The transcript is untouched. The result lists each word and the ACTUAL trim span (which addTrim may shape), asset, clip and trim ID; report only those results. " +
		CUT_TRANSITIONS_RESULT,
	addTrim: `Add ONE trim range: a cut of a span inside a clip (this source-time span will not be played or exported) that does NOT split the clip. Times are in seconds of the asset's source time. This is the preferred (and for 'remove silences' requests, the only) way to handle silences; it preserves the user's placed clips and only adds a cut. When you have several cuts to make, use addTrims and send them together — this one is for a single cut or a later correction. A cut belongs to ONE clip: \`clipId\` is inferred when a single clip covers the range, but when several clips draw on the same asset over it the call FAILS and lists them — pass the \`clipId\` you mean (ids come from getCurrentDocument). ${ZOOM_TRANSITIONS_NOTE} ${CUT_TRANSITIONS_RESULT}`,
	addTrims: `Add MANY trim ranges in one call: \`ranges\` is a list, each entry taking exactly the fields addTrim takes. Use this whenever you have more than one cut to make — 'remove the silences' on a half-hour recording is hundreds of cuts, and sending them one at a time costs one round trip each. Each range stands or falls ALONE: one that cannot be placed is refused by itself and listed in \`refused\` with its index and the reason, while every other range is still applied. Nothing is rolled back, so a single bad bound never costs you the rest. The result leads with requested / appliedCount / refusedCount so you can see a partial outcome without re-reading the document — report what was refused rather than claiming the whole list landed. ${ZOOM_TRANSITIONS_NOTE} Each applied entry carries the same \`cutTransitions\` warning addTrim reports.`,
	setTrim: `Move or resize an existing trim range by id. Times are source-time seconds. The cut follows to whichever clip the new range lands in, when that clip is unambiguous. ${ZOOM_TRANSITIONS_NOTE} ${CUT_TRANSITIONS_RESULT}`,
	setClipRange:
		"Set a clip's in/out points (source-time seconds) to shorten its head or tail — distinct from a trim (which cuts a span inside the clip) — and/or its crop. Only the fields you pass are changed. All clips are re-laid back-to-back afterwards, so downstream clips shift automatically. Change the range ONLY when the user explicitly asks to shorten or extend a clip. Do NOT use this for 'remove silences' or 'cut pauses' — for those, use addTrim. cropRegion is the part of the source frame the clip shows, {x, y, width, height} in 0–1 fractions of it, per clip as in the editor's Edit clip; null shows the whole frame again. getCurrentDocument reports it on the clip, absent when the clip shows the whole frame. Two neighbouring clips of the same asset whose source ranges meet and whose crops match are one clip: the result says joinedIntoNeighbour when an edit made them so.",
	moveClip:
		"Reorder a placed clip: move `clipId` so it plays just before `beforeClipId` (pass null, or omit it, to move it last). Ids come from getCurrentDocument, where each clip carries its `index` and its label in `reason`. This preserves every clip id, every source range, every trim, and the zooms / speed regions / annotations anchored to each clip. This is the tool for 'swap these clips', 'put X first' and 'change the clip order' — replaceTimeline cannot reorder anything.",
	insertClip:
		"Place a clip of a video asset on the timeline, just before `beforeClipId` (null, or omitted, places it last): another take, or footage imported in the editor. Any video asset of getCurrentDocument works, the primary one too. sourceStartSec/sourceEndSec pick the stretch of the asset in its source seconds, the whole asset by default. Clips stay back to back, so the clips after it shift. Its media continuing the clip before it makes the two one clip (joinedIntoNeighbour). An audio asset is not footage: use addAudio. Nothing here imports a file from disk.",
	duplicateClip:
		"Copy a clip, placed right after it: the same footage, crop and source range, with its own copy of the clip's trims and of the zooms, speed regions, annotations and camera-fullscreen regions on it. Edits to one no longer touch the other. Returns the copy's clipId; moveClip puts it somewhere else.",
	replaceTimeline:
		"Replace the whole timeline with the given kept intervals of the primary asset's source time. Everything outside the intervals becomes a trim. The intervals are SORTED, so this can never reorder clips — use moveClip for that. DO NOT use this for 'cut silences' or 'remove pauses' — the user has likely placed clips on the timeline that you'd be discarding. Use this ONLY when the user explicitly asks you to rebuild the timeline from scratch (e.g. 'start over with the kept intervals from the transcript'). To place another asset's footage, use insertClip. It is refused when it would merge away, shorten or drop an existing clip; the refusal names them and the tool to use instead.",
	addZoom: `Add a zoom-in over a span of the edited timeline (virtual seconds). depth is an ORDINAL 1–6, not a factor: it selects a magnification from a fixed table (${ZOOM_DEPTH_LEGEND}), so the default depth 3 renders at 1.80×. The result reports renderedScale — quote that, never the depth, when telling the user how strong the zoom is. focus is the zoom centre in 0–1 fractions of the frame (default centre). When the recording's pointer telemetry can be read for the footage under the span, the result also carries \`cursorAnchor\`: \`focus\` echoes the value this call used (including the default, if you left it out), \`cursor\` is where the pointer ACTUALLY was over the span the zoom landed on — the median of the recorded samples, \`spread\` being how far the farthest one strays from it — and \`offset\` is the distance between the two, in frame fractions. It is a measurement, not a correction: nothing is moved and no call is refused over it, and a zoom framing a slide, a face, or a region the pointer never enters is a legitimate choice. \`available:false\` names what it found instead (\`no-samples\`, \`trimmed-out\`). Its ABSENCE means no telemetry was read for that footage — never that the recording has none; assets[].hasCursorTelemetry and getCursorTrack are what answer that. Use for 'zoom in on …' and the smart-zoom pass. ${ZOOM_BEHAVIOUR_NOTE} ${ZOOM_CAMERA_NOTE} ${ZOOM_TRANSITIONS_NOTE} ${CUT_TRANSITIONS_RESULT}`,
	addZooms: `Add MANY zooms in one call: \`regions\` is a list, each entry taking exactly the fields addZoom takes (same depth table, ${ZOOM_DEPTH_LEGEND}). Use this for the smart-zoom pass, where you have decided every zoom before emitting the first one — sending them one at a time costs one round trip each. Each region stands or falls ALONE: one that covers no clip is refused by itself and listed in \`refused\` with its index and the reason, while the others are still applied. The result leads with requested / appliedCount / refusedCount, and each applied entry carries its renderedScale — quote that, never the depth — plus the same \`cursorAnchor\` addZoom reports, whenever the footage under that region has readable pointer telemetry, and the same \`cutTransitions\` warning. ${ZOOM_TRANSITIONS_NOTE}`,
	addAutoZooms:
		"Plan zooms on the clicks recorded with each take on the timeline and add them, as the timeline's Automatic zooms does: clicks close in time and on screen share one zoom, the first seconds and the click that stopped the take get none, and no zoom lands on one already there. Takes no arguments. Use it after cutting or rearranging a project, or on one whose zooms were removed. The result lists the zooms added, and telemetry gives each recording's read: ok, no-sidecar (it has no recorded clicks), or unavailable (it could not be read from here, which says nothing about the recording). added 0 is an answer, not a failure.",
	setZoom: `Move, resize, or restyle an existing zoom by id (virtual-timeline seconds). Only the fields you pass are changed. depth selects from the same table (${ZOOM_DEPTH_LEGEND}); if the zoom carries a customScale (getCurrentDocument shows it as depthIsOverridden), that custom value is what renders, and passing depth clears it so the depth takes effect — the result says so. The result reports the resulting renderedScale, and — when the footage under the span has readable pointer telemetry — the same \`cursorAnchor\` addZoom reports, measured against the zoom's EFFECTIVE focus, so a call that moved only the span still learns what its unchanged focus is now looking at. ${ZOOM_BEHAVIOUR_NOTE} ${ZOOM_CAMERA_NOTE} ${ZOOM_TRANSITIONS_NOTE} ${CUT_TRANSITIONS_RESULT}`,
	addSpeed:
		"Add a speed-change region over a span of the edited timeline (virtual seconds). speed > 1 fast-forwards, < 1 slows down, from 0.25× to 16× (default 1.5×). Use to speed through slow stretches without cutting them.",
	setSpeed:
		"Move, resize, or change the multiplier of an existing speed region by id (virtual-timeline seconds). Only the fields you pass are changed.",
	addAnnotation:
		"Add an annotation over a span of the edited timeline (virtual seconds). type picks what it is: 'text' (the default) for callouts, labels and titles; 'figure' for an arrow pointing at something; 'blur' for a privacy mask that blurs or pixelates what is under it, the way to hide an email address, a token, a password field or any private detail the recording shows. Image annotations are not available here: they need a file, added in the editor. x/y place the centre, 0–100 percent of the annotation's box (default the centre). Text and arrows sit on the output frame, the whole picture padding included, as the editor places them: zooms and padding never move them. A blur sits on the recording's picture instead, so x/y/width/height are percent of the recording and it stays on what it hides when padding or a zoom moves the picture. A text box is sized to its words and kept inside the frame; it is drawn on a dark plate by default, and fontSize, color, background, bold and animation set its look. An arrow or a blur takes width/height (default 30 × 20) and its own data: figureData {arrowDirection, color, strokeWidth} for an arrow, blurData {type 'blur' or 'mosaic', shape 'rectangle' or 'oval', color, intensity, blockSize} for a blur. The result reads the annotation back as getCurrentDocument reports it.",
	setAnnotation:
		"Change an existing annotation by id: its span (virtual-timeline seconds), its type, its centre (x/y, percent of its box), its size (width/height, arrow and blur only), its text and look (text only: fontSize, color, background, bold, animation), or its figureData / blurData, of which only the keys you pass change. Only the fields you pass are changed. A type change converts it as the editor's type switch does: it stays where it is on screen, a text turned into an arrow or a blur takes the default box, and the text is kept to come back to. A text box is refitted to its text around its centre. Arguments that belong to another kind (width on a text, blurData on an arrow) are refused. A new span that would run into another annotation is refused, naming it.",
	setAspectRatio:
		"Set the shape of the exported video: 16:9 for X, YouTube or a slide, 9:16 for a vertical story or short, 1:1 or 4:5 for a square feed, auto to follow the recording, or one of the clips' own shapes (getCurrentDocument's settingsContext.originalAspectRatios). Annotations on the frame keep their place and shape. The same as setEditorSettings with aspectRatio alone.",
	setEditorSettings:
		'Change the project\'s look: pass only the settings to change, named as getCurrentDocument returns them under `settings`. Background: wallpaper (a bundled path from settingsContext.bundledWallpapers, a CSS colour or gradient, or a base64 PNG/JPEG data URL; never a file path or web URL; an embedded image reads back as a marker, leave the key out to keep it), wallpaperMotion (moves a gradient or image only), backgroundBlur 0–1. Frame: aspectRatio ("auto", a preset, or an originalAspectRatios token; a fixed format picked for the first time fills the frame with a window that follows the cursor, which formatFollowCursor turns off when settingsContext.formatFill is "available"), padding 0–100 %, borderRadius 0–64 px, shadowIntensity 0–1, frame (none, window, laptop, phone, monitor) and frameTheme (light, dark), motionBlurAmount 0–1, depthOfField (blurs 3D-tilted zooms only). Camera: webcamLayoutPreset, webcamMirrored, webcamReactiveZoom (shrinks on zoom), webcamMaskShape (square or rectangle, the camera\'s own proportions; an untouched roundness follows it), webcamRoundness 0–1, webcamSizePreset 15–60, webcamAnchor (a corner or an edge middle), webcamCropRegion (the framing: a square share of the picture, width = height ≥ 1/3) and webcamCropPan (where that window sits, 0–1 per axis, 0.5 centred), webcamBackgroundMode (none, transparent, blur, custom: needs settingsContext.cameraSegmentation ready), webcamBlurIntensity 0–1, webcamWallpaper (as wallpaper). Cursor, under `cursor`: show, autoHide, theme (settingsContext.cursorThemes), asArrow (the recorded cursor kinds drawn as the arrow instead), size 1.5–6, smoothing 0–1, motionBlur 0–1, clickBounce 0–2, clickImpact, clickSound (only heard when the take recorded clicks) and clickSoundGainDb −24–0, model3d. Also autoFocusAll (every zoom follows the cursor) and audioGainDb −12–12 dB, the master volume. A value out of range or a key not listed is refused with the reason, and nothing changes. The result lists what was applied, including what the editor changes with it, and `inactive` for any of those the current state leaves without effect.',
	addCameraFullscreen:
		"Add a camera-fullscreen region over a span of the edited timeline (virtual seconds): the webcam fills the frame for that span. This only does something when the footage under that span comes from an asset with a linked webcam — check assets[].hasCameraTrack (or hasAnyCamera) in getCurrentDocument first. On footage with no camera the call is refused rather than storing a region that would render nothing; say so instead of retrying.",
	addEffect:
		"Write a visual effect as a shader and pose it over a span of the edited timeline (virtual seconds), or pose one of this project's effects again (effectId). Use it for a look the settings do not offer. `effect.code` is WGSL that defines `fn effect(uv: vec2<f32>) -> vec4<f32>`, called for every pixel; uv is 0..1 with (0,0) top-left. Available inside it: `frame(uv)` samples the composed picture; `params.<name>` reads each declared parameter; `ctx.time` is programme seconds; `ctx.region.x` goes 0 to 1 across the region (y its length in s, z seconds since it began); `ctx.resolution` and `ctx.aspect`; `ctx.cursor` (xy in uv, z = 1 when on screen); `ctx.clicks[0..3]`, the last four clicks, newest first (xy in uv where it happened, z seconds since, w = 1 when the slot holds one); `ctx.footage` and `ctx.camera`, the recording's and the webcam's rects (x, y, w, h in uv; camera zero-sized when absent) — all already placed through zoom and layout; `fx_to_footage(uv)` and `fx_from_footage(p)` map between output uv and the recording's own surface (0..1 across the recording) through the warp the compositor draws it with, zoom, layout and 3D camera included, and `ctx.footage_aspect` is its width over height: the effect works in whichever of the two spaces fits it; `fx_px(n)`, n pixels of a 1080p frame as a fraction of the height; `fx_hash(vec2<u32>)`, a random number in [0,1) identical on every GPU. Rules: the effect is a pure function of those inputs (no state between frames), so the preview and the export show the same pixels; reason in uv or fx_px, never raw pixels; every loop is a `for` with literal bounds (`for (var i = 0; i < 16; i++)`), at most 4096 iterations per pixel — the one hard rule. `params` declares up to 8 (recommended) parameters, each `{type: number|toggle|color|point, name, label, default}` (number also `min`, `max`); declare one only when moving it visibly changes the effect over its whole range. `target`: `image` (default: the picture under the annotations and captions), `text` (the annotations and captions alone, premultiplied alpha), `both` (everything); use text or both only when asked. One effect runs at a time: to combine two looks, write them in one shader. The result gives the cost tier, in frame() reads per pixel, with what a 1080p frame pays on a fast discrete GPU (RTX 4070 Ti) and on an integrated one (Apple M1): light ≤ 8, up to 0.06 ms and 1.3 ms; medium ≤ 32, 0.14 ms and 4.3 ms; heavy ≤ 128, 0.54 ms and 16 ms; very heavy beyond, 2 ms and 49 ms at 512 reads. It also gives a recommendation when the tier runs long: light anywhere, medium up to a minute, heavy up to 10 s, very heavy a few seconds. It is a recommendation, never a refusal. Code that does not compile is refused with the compiler's error at the line of your code: fix it and call again. Check the result with getFrames.",
	setEffect:
		"Move, resize or re-tune an effect region by id (virtual seconds): its span, its parameter `values`, or its `target`. Only the fields you pass change; a value equal to the default is dropped. Refused if the new span runs into another effect: one runs at a time.",
	setEffectDefinition:
		"Change an effect itself by effectId — its name, description, WGSL `code` or `params` — and with it every region that uses it. New code is compiled first and refused with the compiler's error if it does not compile. A removed parameter's values drop; the bounds re-clamp the others. Read the current code with getEffect before rewriting it.",
	getEffect:
		"Read one effect of the project in full: its WGSL code, parameters, description, cost and the regions that use it. getCurrentDocument lists effects without their code.",
	setCameraFullscreen:
		"Move or resize an existing camera-fullscreen region by id (virtual-timeline seconds). Only the fields you pass are changed. Refused if the new span lands on footage with no linked webcam.",
	addAudio: `Lay an ALREADY-IMPORTED audio file over the recording across a span of the edited timeline (virtual seconds): a voiceover, or a music bed. assetId must name an asset whose kind is 'audio' — getCurrentDocument lists them. If there is none, a file has to be imported first (importMedia, where it is offered): never guess an id. Omit endSec to play the whole file from offsetSec. kind picks the lane ('voiceover' or 'music'). offsetSec is where in the FILE playback starts, gainDb its level (0 unchanged, negative ducks it), fadeInMs / fadeOutMs its fades (0 to ${AUDIO_FADE_MAX_MS} ms, default none; a track too short for both shares its span between them). A voiceover-lane track is also what gets transcribed, so the lane is not only cosmetic.`,
	setAudio: `Move, resize, re-level, re-lane, mute, loop, fade or re-point an existing audio track by id (virtual-timeline seconds). Only the fields you pass are changed. Use it to duck a bed under narration (gainDb), to fade it in or out (fadeInMs / fadeOutMs, 0 to ${AUDIO_FADE_MAX_MS} ms), to shift what part of the file plays (offsetSec), or to move it between the voiceover and music lanes (kind). The whole track is edited, not one fragment of it, so a track split across a cut stays one thing.`,
	removeTrim:
		"Delete a trim range by id — the cut is undone and that span plays/exports again. This is how you 'remove a trim'; never re-add a trim to undo one.",
	removeModifier:
		"Delete a modifier (zoom / speed / annotation / camera-fullscreen / audio / effect) by id; the kind is resolved from the id. Touching rows with the same styling render as one pill and are deleted together, so read removedIds in the result for the complete set that disappeared. This is how you 'remove'/'delete' one — never neutralise it (span 0, speed 1×), which leaves it in the document. For a trim use removeTrim; for a clip use removeClip.",
	removeClip:
		"Delete a placed clip by id; remaining clips close the gap and effects anchored to it are dropped. Use only when the user asks to remove a clip — to shorten one, use setClipRange.",
	getCaptions:
		"Read the captions: whether they show (enabled), how they look (font, weight, size, colour, plate and its opacity), where they sit (anchorV/insetY, anchorH/insetX), how many words show at once, the lane they read (resolvedLane: the recording's speech, or the voiceover tracks'), and the language they show (null: the transcript's own words). captionedAssets lists the transcripts they are drawn from, and `warning` says when they are on with nothing to show. translations lists each language layer with its coverage per asset (translated of total phrase units). choices lists what setCaptionSettings accepts for style, fontFamily and plate.",
	setCaptionSettings: `Turn the captions on or off, and set how they look and where they sit, as the editor's Captions pane does. Only the fields you pass change. \`style\` applies a named look first (font, weight, size, colour and plate together); \`plate\` then picks what is behind the text (none, dark, light) and recolours text that would vanish on it; any other field you pass wins over both. fontSize is px at a 1080-high frame (${CAPTION_FONT_SIZE_MIN}–${CAPTION_FONT_SIZE_MAX}), color a #rrggbb hex, plateOpacity ${CAPTION_PLATE_OPACITY_MIN}–${CAPTION_PLATE_OPACITY_MAX}. anchorV pins the caption block to the bottom or top edge, and insetY is its distance from that edge in % of the frame height (0–${CAPTION_INSET_Y_MAX}); anchorH pins it left, centre or right, and insetX (0–${CAPTION_INSET_X_MAX} % of the frame width) is ignored when it is centred. minWordsPerLine and maxWordsPerLine (${CAPTION_WORDS_PER_LINE_MIN}–${CAPTION_WORDS_PER_LINE_MAX}) bound how many words show at once. lane picks whose speech is captioned: the recording's, or the voiceover tracks' (it falls back to the recording when there is none, and resolvedLane says so). language shows a translation layer written with putCaptionTranslation; null shows the transcript's own words. Captions are drawn from the transcript, so they need one; enabled captions are burnt into the export.`,
	getCaptionTranslationUnits:
		"Read what to translate for one caption language: per asset the captions read (or the one assetId names), the transcript grouped into phrase units, each with its id, its span in the asset's source seconds and its text. A unit is a sentence or a run of speech between pauses, never a single word, so translate each one as a whole. By default only the units with no text yet in that language, so a translation sent in batches resumes where it stopped; includeTranslated returns the done ones too, with their translation. Translate them yourself, then store them with putCaptionTranslation.",
	putCaptionTranslation:
		"Store your translation of caption units for one asset in a language layer: `units` lists each unit as { id, text }: its id from getCaptionTranslationUnits and your translation of it. It merges into the layer, which the first call creates, so send long transcripts in batches. language is the layer's code (fr, pt-BR); label is the name the editor's language picker shows, such as Français (default: the code). Unknown unit ids refuse the whole call. The transcript is never changed: this is a separate layer the captions can show. It does not switch the captions to it: setCaptionSettings with this language does.",
	removeCaptionTranslation:
		"Delete one caption language layer. The transcript is untouched, and captions that showed this language go back to the transcript's own.",
	setVocabulary: `Set the project's vocabulary: the names and technical terms Whisper is primed with on every transcription of this project, so it spells them right (at most ${VOCABULARY_MAX_CHARS} characters, read as a plain list such as "OpenScreen, Vulkan, whisper.cpp"). An empty string clears it. It changes no existing transcript: transcribe the asset again for that. getCurrentDocument reports it as vocabulary.`,
};

// ponytail: mutable document holder so a write-tool that updates the snapshot
// is observed by the NEXT tool call inside the same agent turn. LangChain's
// `tool()` factory captures the document by reference via the holder, so
// each tool sees the latest mutated snapshot.
type DocumentHolder = { current: AxcutDocument };

/**
 * The runtime's door onto recorded cursor telemetry.
 *
 * ponytail: an INTERFACE, injected, because everything that can actually read a
 * sidecar lives behind Electron's path allow-list, and `electron/ai-edition/`
 * deliberately imports nothing from `electron`. It takes an assetId plus the
 * path the DOCUMENT already holds — never a path the model chose.
 *
 * When no reader is injected the tool answers "unavailable", which is honest and
 * useless; a reader that is wired everywhere except production would be a
 * quieter version of the bug being fixed, so `handlers.ts` is the one caller
 * that matters and there is a test for the unwired case.
 */
export interface CursorTelemetryReader {
	read(input: { assetId: string; originalPath: string | null }): Promise<CursorTelemetryLoad>;
	/** Cheap "is there a sidecar?" check, run once per turn for every asset so
	 *  `getCurrentDocument` can report `hasCursorTelemetry` without reading the
	 *  file. A reader may omit it; the snapshot then reports null (not checked). */
	probe?(input: { assetId: string; originalPath: string | null }): Promise<boolean>;
}

export interface ToolRuntime {
	cursor?: CursorTelemetryReader;
	availableByAssetId?: Record<string, boolean>;
	/** Asks the compositor whether this machine can cut out the camera background. */
	cameraSegmentation?: () => SegmentationSupport;
	/** Asks the compositor to check an effect's WGSL. */
	checkShaderEffect?: ShaderEffectChecker;
}

/**
 * The tools whose RESULT depends on the recorded pointer track, so the async
 * wrapper knows to do the read before entering the synchronous executor.
 *
 * ponytail: the zoom writes are on this list, not only the reader. A `focus`
 * that nothing reports back on is a `focus` nobody can check — the write
 * answered `ok` whether it framed the pointer or the opposite corner. They pass
 * no assetId, so the read resolves to the primary asset and the executor reports
 * the anchor ONLY for fragments whose clip draws on that same asset: measured
 * against the right media, or left off, never inferred from the wrong one.
 *
 * No cache. The read is a local JSON parse, `addZooms` is what keeps a whole
 * zoom pass to one call rather than N, and nothing on this path memoises today —
 * a cache here would be one more thing to invalidate for a saving nobody has
 * measured.
 */
const TOOLS_READING_CURSOR: ReadonlySet<string> = new Set([
	"getCursorTrack",
	"addZoom",
	"addZooms",
	"setZoom",
]);

// One document tool: run it through the shared executor, advance the holder so
// the next tool in the turn sees the edit, and emit exactly ONE start/end pair
// carrying the executor's REAL verdict.
//
// ponytail: reads go through here too, and that is the point. The read tools
// used to emit nothing of their own and be announced only by the `on_tool_end`
// branch of the stream loop, which hard-coded `ok: true` — so a `getTranscript`
// that came back `{"error":"No transcript for asset …"}` was reported as a
// success, and every write was announced twice (once truthfully here, once as
// `ok: true` there). One factory, one pair, one verdict. `executeAgentTool`
// never throws, so `execution.ok` is the only honest signal available.
function documentTool<S extends z.ZodType>(
	holder: DocumentHolder,
	sink: OpenScreenAgentSink,
	name: string,
	schema: S,
	editsAllowed: boolean,
	runtime: ToolRuntime,
	inTurn: TurnQueue,
) {
	return tool(
		(args: z.infer<S>) =>
			inTurn(async () => {
				sink.toolStart(name, args);
				const execution = await runDocumentTool(holder.current, name, args, editsAllowed, runtime);
				if (execution.document) holder.current = execution.document;
				sink.toolEnd(name, execution.ok, execution.summary);
				return execution.resultJson;
			}),
		{ name, description: TOOL_DESCRIPTIONS[name], schema },
	);
}

type TurnQueue = <T>(run: () => Promise<T>) => Promise<T>;

/**
 * Runs a turn's tool calls one at a time, in the order the agent starts them.
 *
 * The agent starts every call of one model step at once (each is its own `Send`
 * to the tools node). Each call reads the holder, awaits, then writes the holder,
 * so two at once both start from the same document and the last to finish keeps
 * only its own edit, while every one of them reports success. A zoom reads the
 * cursor track before it executes, so it finishes after the trims sent beside it:
 * that is how a turn reported "added 3 trims" over a document holding none.
 */
function turnQueue(): TurnQueue {
	let queue: Promise<unknown> = Promise.resolve();
	return (run) => {
		const next = queue.then(run, run);
		queue = next.catch(() => undefined);
		return next;
	};
}

/**
 * Run one tool against a document: the cursor read it may need, then the shared
 * executor. The in-app agent (`documentTool`) and the MCP server both call this,
 * so a tool behaves the same whichever agent is driving it.
 *
 * ponytail: the ONE async step the pure executor cannot take. Reading a sidecar
 * is IO; `executeAgentTool` is synchronous by design (it is the gate every
 * mutation passes through, and it has to stay testable without a filesystem).
 * So the load happens here and its verdict — including "I could not look" — goes
 * in as data.
 */
export async function runDocumentTool(
	document: AxcutDocument,
	name: string,
	args: unknown,
	editsAllowed: boolean,
	runtime: ToolRuntime,
): Promise<AgentToolExecution> {
	const load = TOOLS_READING_CURSOR.has(name)
		? await loadCursorTelemetry(document, args, runtime)
		: undefined;
	const autoZooms =
		name === "addAutoZooms" && editsAllowed ? await planAutoZooms(document, runtime) : undefined;
	// The compositor compiles an effect's code for real, off the main thread: asked here, before
	// the synchronous executor reads the answer.
	const effectSource =
		editsAllowed && runtime.checkShaderEffect ? shaderEffectToCheck(document, name, args) : null;
	const checkShaderEffect =
		effectSource && runtime.checkShaderEffect
			? shaderEffectCheckLookup(
					effectSource,
					await runtime.checkShaderEffect(effectSource.code, effectSource.params),
				)
			: undefined;
	return executeAgentTool(document, name, JSON.stringify(args ?? {}), {
		editsAllowed,
		cursorTelemetry: { availableByAssetId: runtime.availableByAssetId, load },
		cameraSegmentation: runtime.cameraSegmentation,
		checkShaderEffect,
		autoZooms,
	});
}

/** The timeline wand's plan (`collectAutoZoomSuggestionsForDocument`), each recording's
 *  clicks read through the runtime's cursor reader, and what each read gave. */
async function planAutoZooms(
	document: AxcutDocument,
	runtime: ToolRuntime,
): Promise<AutoZoomPlan | undefined> {
	const cursor = runtime.cursor;
	if (!cursor) return undefined;
	const telemetry: AutoZoomPlan["telemetry"] = {};
	const suggestions = await collectAutoZoomSuggestionsForDocument(document, async (videoPath) => {
		// The plan asks by path; every asset on that file gets the verdict of its one read.
		const assets = document.assets.filter((a) => a.originalPath === videoPath);
		if (assets.length === 0) return [];
		const load = await readCursor(cursor, assets[0].id, videoPath);
		for (const asset of assets) telemetry[asset.id] = load.status;
		// The sidecar's samples, read as the renderer's `getTelemetry` reads them.
		return load.status === "ok" ? (load.samples as CursorTelemetryPoint[]) : [];
	});
	return { suggestions, telemetry };
}

/** Reads the sidecar for whichever asset the call names, defaulting to the
 *  primary one — the same resolution the executor will use to report it. */
async function loadCursorTelemetry(
	document: AxcutDocument,
	args: unknown,
	runtime: ToolRuntime,
): Promise<CursorTelemetryLoad> {
	const requested = (args as { assetId?: unknown } | null)?.assetId;
	const assetId = resolveCursorAssetId(document, typeof requested === "string" ? requested : null);
	if (!assetId) return { status: "unavailable", assetId: null };
	if (!runtime.cursor) {
		return { status: "unavailable", assetId };
	}
	const asset = document.assets.find((a) => a.id === assetId);
	return readCursor(runtime.cursor, assetId, asset?.originalPath ?? null);
}

async function readCursor(
	cursor: CursorTelemetryReader,
	assetId: string,
	originalPath: string | null,
): Promise<CursorTelemetryLoad> {
	try {
		return await cursor.read({ assetId, originalPath });
	} catch (error) {
		// A reader that throws is still "we could not look" — never "there is
		// none". Collapsing the two is the exact failure this tool exists to stop.
		return {
			status: "unavailable",
			assetId,
			note: `Cursor telemetry could not be read: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * The complete tool surface handed to the model. Exported so a test can assert
 * its exact shape — the count is the cheapest tripwire for a dependency that
 * starts injecting tools of its own again.
 *
 * ponytail: the write tools are built even when `editsAllowed` is false, and
 * that is deliberate. Withholding them would make the model answer "I have no
 * tool for that" — a lie, and one that hides the setting instead of surfacing
 * it. It has to be able to NAME the edit it is asking permission for.
 */
export function buildTools(
	holder: DocumentHolder,
	sink: OpenScreenAgentSink,
	editsAllowed = true,
	runtime: ToolRuntime = {},
) {
	const inTurn = turnQueue();
	return TOOL_ARG_SCHEMAS.map(([name, schema]) =>
		documentTool(holder, sink, name, schema, editsAllowed, runtime, inTurn),
	);
}

/**
 * Every tool's name and argument schema, in the order the model is handed them.
 * `buildTools` wraps these for the in-app agent and `electron/mcp/` exposes the
 * same list over MCP, so the two surfaces cannot drift apart.
 */
export const TOOL_ARG_SCHEMAS: ReadonlyArray<readonly [string, z.ZodObject]> = [
	["getCurrentDocument", z.object({})],
	["getTranscript", getTranscriptArgs],
	["getTranscriptWords", getTranscriptWordsArgs],
	["getCursorTrack", getCursorTrackArgs],
	["setWordText", setWordTextArgs],
	["removeWords", removeWordsArgs],
	["addTrim", addTrimArgs],
	["addTrims", addTrimsArgs],
	["setTrim", setTrimArgs],
	["setClipRange", setClipRangeArgs],
	["moveClip", moveClipArgs],
	["insertClip", insertClipArgs],
	["duplicateClip", duplicateClipArgs],
	["replaceTimeline", replaceTimelineArgs],
	["addZoom", addZoomArgs],
	["addZooms", addZoomsArgs],
	["addAutoZooms", addAutoZoomsArgs],
	["setZoom", setZoomArgs],
	["addSpeed", addSpeedArgs],
	["setSpeed", setSpeedArgs],
	["addAnnotation", addAnnotationArgs],
	["setAnnotation", setAnnotationArgs],
	["addCameraFullscreen", addCameraFullscreenArgs],
	["setCameraFullscreen", setCameraFullscreenArgs],
	["addEffect", addEffectArgs],
	["setEffect", setEffectArgs],
	["setEffectDefinition", setEffectDefinitionArgs],
	["getEffect", getEffectArgs],
	["addAudio", addAudioArgs],
	["setAudio", setAudioArgs],
	["removeTrim", removeTrimArgs],
	["removeModifier", removeModifierArgs],
	["removeClip", removeClipArgs],
	["setAspectRatio", setAspectRatioArgs],
	["setEditorSettings", setEditorSettingsArgs],
	["getCaptions", getCaptionsArgs],
	["setCaptionSettings", setCaptionSettingsArgs],
	["getCaptionTranslationUnits", getCaptionTranslationUnitsArgs],
	["putCaptionTranslation", putCaptionTranslationArgs],
	["removeCaptionTranslation", removeCaptionTranslationArgs],
	["setVocabulary", setVocabularyArgs],
];

/**
 * Prompt caching for the Anthropic-wire providers, which `createDeepAgent`
 * used to add for us (`isAnthropicModel` → `anthropicPromptCachingMiddleware`).
 * Dropping it silently would have made every Anthropic and MiniMax turn re-pay
 * for the full prompt — a cost and latency regression invisible to the offline
 * tests, which all run on the OpenAI-compatible path.
 *
 * The class-name probe is deepagents' own test, kept verbatim so MiniMax (which
 * rides `ChatAnthropic` because its wire format is Anthropic's) keeps caching.
 * `unsupportedModelBehavior: "ignore"` means a model that turns out not to
 * support cache breakpoints degrades instead of throwing.
 */
export function anthropicCachingMiddleware(chatModel: { getName?: () => string }) {
	if (chatModel.getName?.() !== "ChatAnthropic") return [];
	return [
		anthropicPromptCachingMiddleware({
			unsupportedModelBehavior: "ignore",
			minMessagesToCache: 1,
		}),
	];
}

export interface InvokeArgs {
	document: AxcutDocument;
	model: OpenScreenChatModelConfig;
	history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
	userMessage: string;
	sink: OpenScreenAgentSink;
	/** `config.allowAgentEdits !== false`, resolved by the chat-service. When
	 *  false the write tools refuse and the prompt tells the model to ask.
	 *  Defaults to allowed so a caller that predates the flag behaves as before. */
	editsAllowed?: boolean;
	/** Injected by `chat-service` from the Electron layer. Absent in tests and in
	 *  the workbench unless one is supplied on purpose. */
	cursor?: CursorTelemetryReader;
	/** Injected the same way: whether this machine can cut out the camera background. */
	cameraSegmentation?: () => SegmentationSupport;
	/** Injected the same way: the compositor's check of an effect's WGSL. */
	checkShaderEffect?: ShaderEffectChecker;
}

/** One cheap probe per asset, run before the tools are built so the very first
 *  `getCurrentDocument` can already say whether telemetry exists. */
export async function probeCursorTelemetry(
	document: AxcutDocument,
	cursor: CursorTelemetryReader | undefined,
): Promise<Record<string, boolean> | undefined> {
	if (!cursor?.probe) return undefined;
	const entries = await Promise.all(
		document.assets.map(async (asset) => {
			try {
				return [
					asset.id,
					await cursor.probe!({ assetId: asset.id, originalPath: asset.originalPath ?? null }),
				] as const;
			} catch {
				// A probe that throws leaves the asset OUT of the map, which the
				// snapshot renders as null — "not checked". Recording it as `false`
				// would turn our failure into a claim about the user's project.
				return null;
			}
		}),
	);
	const map: Record<string, boolean> = {};
	for (const entry of entries) {
		if (entry) map[entry[0]] = entry[1];
	}
	return map;
}

/**
 * ponytail: `on_tool_start` / `on_tool_end` are observed and DROPPED, not
 * forwarded to the sink. `documentTool` already announced the call with the
 * real arguments and the executor's real verdict; this branch has no access to
 * the tool's return value, so it could only ever invent `ok: true` — which is
 * exactly how a REFUSED `replaceTimeline` and a `getTranscript` that returned
 * `{"error":"No transcript…"}` both came out green. Every write was announced
 * twice, the second time as a success. A stream branch must never fabricate a
 * verdict: a tool built outside `documentTool` should be silent here (and get
 * caught by the "one pair per call" test) rather than quietly mislabelled.
 *
 * They are excluded from `nonChatEvents` as well, so the empty-response
 * diagnostic keeps listing only genuinely unhandled events.
 */
const SILENT_TOOL_EVENTS: ReadonlySet<string> = new Set(["on_tool_start", "on_tool_end"]);

export interface InvokeResult {
	text: string;
	document: AxcutDocument;
	mutated: boolean;
	/** Set when the stream finished without producing a final text (e.g. all
	 * chunks had empty `content`, or the provider returned no
	 * `content_block_delta` events). Carries a short diagnostic describing
	 * what the LangChain layer actually saw. */
	reason?: string;
}

export async function invokeOpenScreenAgent(args: InvokeArgs): Promise<InvokeResult> {
	const { document, model, history, userMessage, sink } = args;
	const editsAllowed = args.editsAllowed !== false;

	const holder: DocumentHolder = { current: document };
	const initialDocumentJSON = JSON.stringify(document);

	// ponytail: build a fresh agent per turn (same pattern as axcut). The
	// runtime side-effects (langgraph thread) are tied to the agent instance —
	// checkpoint-based stateful threads can land later by passing a
	// `checkpointer`; for v1 each turn is single-shot.
	const chatModel = await createOpenScreenChatModel(model);
	const availableByAssetId = await probeCursorTelemetry(document, args.cursor);
	const tools = buildTools(holder, sink, editsAllowed, {
		cursor: args.cursor,
		availableByAssetId,
		cameraSegmentation: args.cameraSegmentation,
		checkShaderEffect: args.checkShaderEffect,
	});
	const agent = createAgent({
		model: chatModel,
		tools,
		systemPrompt: buildSystemPrompt({ editsAllowed }),
		middleware: anthropicCachingMiddleware(chatModel),
	}).withConfig({
		// ponytail: NOT optional. LangGraph's default is 25 steps, and an
		// auto-enhance turn spends one step per silence — it would die mid-turn
		// with a GraphRecursionError, which this file's catch block relabels
		// "Empty response from model" (the same words a mute provider gets).
		// `createDeepAgent` used 1e4; that is reckless while there is still no
		// AbortSignal and no timeout anywhere on the product path — a looping
		// model would be indistinguishable from a hang. 1000 is far above any
		// real turn and still bounded.
		recursionLimit: 1000,
	});

	const messages = [...history, { role: "user" as const, content: userMessage }];

	// ponytail: declared outside the try block so the catch handler can
	// include any chunks we already saw in the diagnostic when the stream
	// throws partway through.
	let chatModelChunks: unknown[] = [];

	try {
		// ponytail: streamEvents (legacy mode, no `version: "v3"`) returns the
		// same on_chat_model_stream / on_tool_start / on_tool_end / on_chain_end
		// event stream axcut consumes. We use it both for live text deltas and
		// to know when the run has produced its final assistant message.
		const stream = (
			agent as unknown as {
				streamEvents: (state: unknown, config?: unknown) => AsyncIterable<Record<string, unknown>>;
			}
		).streamEvents({ messages }, undefined);

		let finalText = "";
		const nonChatEvents: Array<{ event: string; name: string }> = [];

		for await (const event of stream) {
			const eventType = typeof event.event === "string" ? event.event : "";
			const data = event.data as Record<string, unknown> | undefined;
			const name = typeof event.name === "string" ? (event.name as string) : "";

			if (eventType === "on_chat_model_stream") {
				const chunk = data?.chunk as Record<string, unknown> | undefined;
				if (chunk) chatModelChunks.push(chunk);
				const content = chunk?.content;
				const thinkingDelta = messageContentToThinking(content);
				if (thinkingDelta) {
					sink.thinking(thinkingDelta);
				}
				const delta = messageContentToText(content);
				if (delta) {
					sink.text(delta);
					finalText += delta;
				}
			} else if (eventType === "on_tool_error") {
				// Kept as a safety net rather than as a live path. `executeAgentTool`
				// never throws, and LangChain's ToolNode catches what does (an unknown
				// tool name, arguments the zod binding rejects) and feeds it back as
				// the tool RESULT instead of raising. This branch only fires for a
				// failure that escapes both — and then the stream is the only witness,
				// so it reports `ok: false` from evidence, never a fabricated verdict.
				sink.toolEnd(name, false, extractError(data));
			} else if (eventType && !SILENT_TOOL_EVENTS.has(eventType)) {
				nonChatEvents.push({ event: eventType, name });
			}
		}

		const mutated = JSON.stringify(holder.current) !== initialDocumentJSON;
		if (!finalText.trim()) {
			// ponytail: surface the upstream payload so we can see why MiniMax
			// (or any other anthropic-shaped provider) is producing no text.
			// The chat-model chunks are the post-parse LangChain views of
			// each SSE event; their `content`/`additional_kwargs`/
			// `response_metadata` fields tell us whether the issue is in the
			// wire format, the parser, or our `messageContentToText` shape.
			// Capped at
			// 1 chunk + a 1kB slice to keep the toast readable.
			const lastChunk = chatModelChunks[chatModelChunks.length - 1];
			const sample = lastChunk
				? JSON.stringify(lastChunk).slice(0, 1024)
				: "(no on_chat_model_stream events)";
			const reason =
				`Empty response from model (provider=${model.provider}, ` +
				`model=${model.model}, chat_model_chunks=${chatModelChunks.length}, ` +
				`other_events=${nonChatEvents.length}:${nonChatEvents
					.slice(0, 5)
					.map((e) => e.event)
					.join(",")}). Last chunk: ${sample}`;
			sink.error(reason);
			return { text: "", document: holder.current, mutated, reason };
		}
		return { text: finalText.trim(), document: holder.current, mutated };
	} catch (err) {
		// ponytail: surface the LangChain/HTTP error (with name + truncated
		// stack) so we can tell whether the stream threw (e.g. MiniMax
		// returning a non-Anthropic JSON envelope that the SDK rejects) or
		// completed with empty content. Mirrors the diagnostic shape used in
		// the success-but-empty path above.
		const e = err instanceof Error ? err : new Error(String(err));
		const stackHead = (e.stack ?? "").split("\n").slice(0, 3).join(" | ");
		const reason =
			`Empty response from model (provider=${model.provider}, ` +
			`model=${model.model}, error=${e.name}: ${e.message}` +
			(stackHead ? ` stack=${stackHead}` : "") +
			`). Last chunk: ${(
				chatModelChunks[chatModelChunks.length - 1]
					? JSON.stringify(chatModelChunks[chatModelChunks.length - 1])
					: "(no on_chat_model_stream events)"
			).slice(0, 1024)}`;
		sink.error(reason);
		return {
			text: "",
			document: holder.current,
			mutated: JSON.stringify(holder.current) !== initialDocumentJSON,
			reason,
		};
	}
}

function extractError(data: Record<string, unknown> | undefined): string | undefined {
	if (!data) return undefined;
	const error = data.error;
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return undefined;
}

// ponytail: re-exported for the agent-facing surface, but be honest about who
// uses it — no production code calls it. Its only real consumers are the
// workbench (`lib/wire.ts`, `lib/oracles.ts`), which import it straight from
// agent-tools anyway, and the tests. It is kept because the mutating/non-mutating
// split is a property of the agent surface, and this module is that surface.
export { isMutatingTool };
