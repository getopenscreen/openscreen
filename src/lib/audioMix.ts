/**
 * Mic gain applied when mixing the microphone with system audio into the recorder's
 * destination stream. Boosted slightly above unity so the voice is clearly audible
 * over typical system-audio levels.
 */
export const MIC_GAIN_BOOST = 1.4;

/**
 * Duration of the mic fade-in applied at the start of a recording. Masks the
 * click/pop that the mic produces at its first packet (echo-canceller warm-up,
 * DC offset, gain-stage step) without audibly muting speech.
 */
export const MIC_FADE_IN_S = 0.02;

export type MixAudioTracksInput = {
	systemAudioTrack?: MediaStreamTrack | null | undefined;
	micAudioTrack?: MediaStreamTrack | null | undefined;
};

export type MixAudioTracksResult = {
	/** AudioContext created to mix the two tracks. `null` when no mixing was needed. */
	context: AudioContext | null;
	/** The track to add to the recorder's MediaStream, or `null` when neither input was given. */
	track: MediaStreamTrack | null;
};

/**
 * Combine system audio and the microphone into a single audio track for the recorder.
 *
 * - Both tracks present: builds an AudioContext + GainNode + MediaStreamDestination
 *   that mixes them, applying a short fade-in on the mic gain so the very first packet
 *   doesn't click. Caller owns the returned `context` and must `.close()` it on teardown.
 * - Exactly one track present: returns it verbatim, no AudioContext created.
 * - Neither present: returns `{ context: null, track: null }`.
 */
export function mixAudioTracks({
	systemAudioTrack,
	micAudioTrack,
}: MixAudioTracksInput): MixAudioTracksResult {
	if (systemAudioTrack && micAudioTrack) {
		const context = new AudioContext();
		const systemSource = context.createMediaStreamSource(new MediaStream([systemAudioTrack]));
		const micSource = context.createMediaStreamSource(new MediaStream([micAudioTrack]));
		const micGain = context.createGain();
		micGain.gain.setValueAtTime(0, context.currentTime);
		micGain.gain.linearRampToValueAtTime(MIC_GAIN_BOOST, context.currentTime + MIC_FADE_IN_S);
		const destination = context.createMediaStreamDestination();
		systemSource.connect(destination);
		micSource.connect(micGain).connect(destination);
		return { context, track: destination.stream.getAudioTracks()[0] };
	}
	return {
		context: null,
		track: systemAudioTrack ?? micAudioTrack ?? null,
	};
}
