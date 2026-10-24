type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Adapt the native exporter's existing error text at the presentation boundary. */
export function exportErrorMessage(message: string, t: Translate): string {
	if (message.startsWith("validating exported video: ")) {
		return t("exportDialog.validationFailed");
	}
	if (
		message ===
		"No video frames were exported. Check that the clips contain readable video before exporting again."
	) {
		return t("exportDialog.noReadableFrames");
	}
	const clip = /^Cannot export clip ([1-9]\d*): (.+)$/s.exec(message);
	if (!clip) return message;
	const vars = { clip: clip[1] };
	const reason = clip[2];
	if (
		reason ===
		"the camera video ends before this clip starts. Record the camera again or remove its track before exporting."
	) {
		return t("exportDialog.cameraEnded", vars);
	}
	const cameraStart =
		"the camera video has no readable frame at the clip's start. Record the camera again or remove its track before exporting.";
	if (reason === cameraStart || reason.startsWith(`${cameraStart}: `)) {
		return t("exportDialog.cameraUnreadable", vars);
	}
	const screenStart = "the screen video has no readable frame at the clip's start.";
	const screenRead = "could not read the screen video.";
	if (
		reason === screenStart ||
		reason.startsWith(`${screenStart}: `) ||
		reason === screenRead ||
		reason.startsWith(`${screenRead}: `)
	) {
		return t("exportDialog.screenUnreadable", vars);
	}
	// Unknown failures retain their diagnostic detail instead of becoming a false diagnosis.
	return message;
}
