/**
 * Decides, as the macOS helper speaks and when it exits, whether a take ended
 * without the user stopping it, so the HUD can stop with it.
 *
 * The start and stop waits only listen while they are pending, so an error the
 * helper raises between them (a dead writer, a stream that stopped) used to sit
 * in the buffer until the user pressed stop, while the HUD counted on for
 * minutes (issue #621). A helper that dies without a word — killed, crashed — is
 * the same take ending, and only its process `close` shows it.
 *
 * Before `recording-started` the start wait owns both. A take that is no longer
 * live — another helper replaced it, or a stop is already running — has nothing
 * left to stop.
 */
export function createNativeMacMidCaptureErrorWatch(
	isLiveTake: () => boolean,
	onTakeEnded: () => void,
) {
	let recordingStarted = false;
	const watch = (event: Record<string, unknown>) => {
		if (event.event === "recording-started") {
			recordingStarted = true;
		}
		if (event.event === "error" && recordingStarted && isLiveTake()) {
			onTakeEnded();
		}
	};
	/** The helper process closed. */
	const exited = () => {
		if (recordingStarted && isLiveTake()) {
			onTakeEnded();
		}
	};
	return Object.assign(watch, { exited });
}
