/**
 * What each loop shows, for anyone who cannot see it. The loops carry no words
 * of their own, so the same files serve all eight locales and only these
 * labels are translated.
 *
 * Built at render, like the Showcase copy: translate() answers in the locale
 * being rendered, so this cannot be a module-level constant.
 */

import { translate } from "@docusaurus/Translate";

import type { LoopName } from "../../lib/demo-loop";

const LOOP = "Describes a short silent video loop of the app for screen readers.";

export function loopLabel(name: LoopName): string {
	switch (name) {
		case "classic-zoom":
			return translate({
				id: "demoLoop.classic-zoom",
				description: LOOP,
				message:
					"A task board recorded in OpenScreen. The view zooms in on a checklist item and a Ship button as they are clicked, then pulls back to the whole board.",
			});
		case "3d-camera":
			return translate({
				id: "demoLoop.3d-camera",
				description: LOOP,
				message:
					"The same recording seen through the 3D camera, which tilts the screen and orbits around it while it follows the cursor.",
			});
		case "3d-cursors":
			return translate({
				id: "demoLoop.3d-cursors",
				description: LOOP,
				message:
					"One recorded pointer, redrawn in five cursor styles one after another while the recording keeps playing.",
			});
		case "automatic-subtitles":
			return translate({
				id: "demoLoop.automatic-subtitles",
				description: LOOP,
				message:
					"A narrated recording with captions under it, switching from English to French, Spanish and Korean.",
			});
		case "caption-styles":
			return translate({
				id: "demoLoop.caption-styles",
				description: LOOP,
				message:
					"One caption shown in five styles: a plain caption, a bold yellow one, a handwritten one, a monospaced one, and one showing a single word at a time.",
			});
		case "edit-by-transcript":
			return translate({
				id: "demoLoop.edit-by-transcript",
				description: LOOP,
				message:
					"In the editor's transcript, a sentence is selected and deleted, and the matching cut appears on the timeline.",
			});
		case "tighten-pauses":
			return translate({
				id: "demoLoop.tighten-pauses",
				description: LOOP,
				message:
					"Two clicks on the silence markers in the transcript, and both pauses are cut from the timeline.",
			});
		case "background-picker":
			return translate({
				id: "demoLoop.background-picker",
				description: LOOP,
				message:
					"The editor's background picker going through wallpapers, a gradient and a solid color, then turning on the animated Aurora background.",
			});
		case "every-format":
			return translate({
				id: "demoLoop.every-format",
				description: LOOP,
				message:
					"The same recording exported in 16:9, then square, then vertical, with the framing following the cursor.",
			});
		case "sensitive-data-mask":
			return translate({
				id: "demoLoop.sensitive-data-mask",
				description: LOOP,
				message:
					"A sign-in form being filled in. The email and password fields stay blurred while they are typed.",
			});
		case "camera-blur":
			return translate({
				id: "demoLoop.camera-blur",
				description: LOOP,
				message:
					"A square webcam vignette over a screen recording. The view moves in on it while the room behind the speaker blurs, then pulls back.",
			});
		case "every-layout":
			return translate({
				id: "demoLoop.every-layout",
				description: LOOP,
				message:
					"One recording with a webcam, cycling through the layouts: picture in picture, side by side, stacked, full camera, then screen only.",
			});
		case "device-frames":
			return translate({
				id: "demoLoop.device-frames",
				description: LOOP,
				message:
					"The same playing recording framed in turn as a browser window, a phone, a laptop and a desktop monitor.",
			});
		case "animated-backgrounds":
			return translate({
				id: "demoLoop.animated-backgrounds",
				description: LOOP,
				message:
					"A recording on a plain background, then on a blurred photo background that moves slowly behind it.",
			});
		case "beautiful-by-default":
			return translate({
				id: "demoLoop.beautiful-by-default",
				description: LOOP,
				message:
					"A raw screen capture, then the same take as OpenScreen opens it, already zoomed, framed and with a restyled cursor, then in several looks.",
			});
		case "simpler-editor":
			return translate({
				id: "demoLoop.simpler-editor",
				description: LOOP,
				message:
					"The OpenScreen editor. One click on a background thumbnail restyles the whole video, then the side panel switches to the transcript.",
			});
		case "edit-like-a-doc":
			return translate({
				id: "demoLoop.edit-like-a-doc",
				description: LOOP,
				message:
					"Text selected in the transcript is deleted like text in a document, and the video is cut to match.",
			});
		case "ask-the-agent":
			return translate({
				id: "demoLoop.ask-the-agent",
				description: LOOP,
				message:
					"A request typed into the editor's chat panel, and the edits the agent makes appearing on the timeline.",
			});
	}
}

const TITLE =
	"The name of a short silent video of the app, given to search engines (schema.org VideoObject).";

/** A short name for each loop: the VideoObject `name` search engines show. */
export function loopTitle(name: LoopName): string {
	switch (name) {
		case "classic-zoom":
			return translate({
				id: "demoLoop.title.classic-zoom",
				description: TITLE,
				message: "Automatic zoom on clicks",
			});
		case "3d-camera":
			return translate({
				id: "demoLoop.title.3d-camera",
				description: TITLE,
				message: "A 3D camera orbiting the screen",
			});
		case "3d-cursors":
			return translate({
				id: "demoLoop.title.3d-cursors",
				description: TITLE,
				message: "Cursor packs, drawn in 3D",
			});
		case "automatic-subtitles":
			return translate({
				id: "demoLoop.title.automatic-subtitles",
				description: TITLE,
				message: "Captions translated into other languages",
			});
		case "caption-styles":
			return translate({
				id: "demoLoop.title.caption-styles",
				description: TITLE,
				message: "Five caption styles",
			});
		case "edit-by-transcript":
			return translate({
				id: "demoLoop.title.edit-by-transcript",
				description: TITLE,
				message: "Cutting video by deleting text in the transcript",
			});
		case "tighten-pauses":
			return translate({
				id: "demoLoop.title.tighten-pauses",
				description: TITLE,
				message: "Cutting silences from the transcript",
			});
		case "background-picker":
			return translate({
				id: "demoLoop.title.background-picker",
				description: TITLE,
				message: "Changing the background behind a recording",
			});
		case "every-format":
			return translate({
				id: "demoLoop.title.every-format",
				description: TITLE,
				message: "One recording in 16:9, 1:1 and 9:16",
			});
		case "sensitive-data-mask":
			return translate({
				id: "demoLoop.title.sensitive-data-mask",
				description: TITLE,
				message: "Blurring an email address and a password",
			});
		case "camera-blur":
			return translate({
				id: "demoLoop.title.camera-blur",
				description: TITLE,
				message: "Webcam background blur",
			});
		case "every-layout":
			return translate({
				id: "demoLoop.title.every-layout",
				description: TITLE,
				message: "Webcam layouts",
			});
		case "device-frames":
			return translate({
				id: "demoLoop.title.device-frames",
				description: TITLE,
				message: "Device frames",
			});
		case "animated-backgrounds":
			return translate({
				id: "demoLoop.title.animated-backgrounds",
				description: TITLE,
				message: "Animated backgrounds",
			});
		case "beautiful-by-default":
			return translate({
				id: "demoLoop.title.beautiful-by-default",
				description: TITLE,
				message: "From a raw screen capture to a finished demo",
			});
		case "simpler-editor":
			return translate({
				id: "demoLoop.title.simpler-editor",
				description: TITLE,
				message: "The OpenScreen editor",
			});
		case "edit-like-a-doc":
			return translate({
				id: "demoLoop.title.edit-like-a-doc",
				description: TITLE,
				message: "Editing a video like a document",
			});
		case "ask-the-agent":
			return translate({
				id: "demoLoop.title.ask-the-agent",
				description: TITLE,
				message: "Asking the editor's agent for an edit",
			});
	}
}
