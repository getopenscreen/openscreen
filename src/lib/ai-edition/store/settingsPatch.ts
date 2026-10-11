// A settings patch applied to a document, with what it implies for the rest of it. Pure, so the
// editor's hook and the agent's tools apply a setting through the same code.

import { refitFrameAnnotations } from "../annotations/placement";
import { resolveAspectRatioValue } from "../document/outputFormat";
import type { AxcutDocument } from "../schema";
import { type EditorSettingsPatch, getEditorSettings, patchEditorSettings } from "./editorSettings";

/**
 * `patchEditorSettings`, plus what a new format does to the annotations placed on the frame:
 * each keeps its shape and its centre (`refitFrameAnnotations`), in the same write, so one undo
 * takes both back.
 */
export function applySettingsPatch(doc: AxcutDocument, patch: EditorSettingsPatch): AxcutDocument {
	const next = patchEditorSettings(doc, patch);
	// ponytail: only a format picked in the settings refits. Under Auto the frame can also
	// reshape when clips change, and those annotations keep their shares of the frame; refit
	// there too if that shows up in practice.
	if (patch.aspectRatio === undefined) return next;
	const annotations = refitFrameAnnotations(
		next.annotations,
		resolveAspectRatioValue(doc, getEditorSettings(doc).aspectRatio),
		resolveAspectRatioValue(next, getEditorSettings(next).aspectRatio),
	);
	return annotations === next.annotations ? next : { ...next, annotations };
}
