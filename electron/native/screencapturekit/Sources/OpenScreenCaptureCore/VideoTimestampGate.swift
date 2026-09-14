import CoreMedia

/// Keeps the video track's presentation times strictly increasing, which is the one thing
/// `AVAssetWriter` will not forgive.
///
/// # What a non-increasing timestamp costs
///
/// The writer validates every appended sample's timing in MediaToolbox's
/// `MediaSampleTimingGenerator`, and a frame whose presentation time is not after the previous
/// one — equal, earlier, or earlier than the session start — fails it with an OSStatus of
/// -16364. That fails the whole writer, not the sample. It also does not fail the append that
/// carried the bad frame: that one answers `true`, and it is the NEXT append that returns
/// `false` with `AVFoundationErrorDomain -11800` wrapping -16364. Every frame after it is
/// dropped while ScreenCaptureKit carries on delivering, so the take ends at the last complete
/// fragment and the rest is lost. Measured with the helper's exact writer settings, fragmented
/// and not; it is not a fragmentation defect like -16341.
///
/// # Where one comes from
///
/// Pause/resume. The helper measures a pause on the host clock and shifts every later sample
/// back by it, but a ScreenCaptureKit frame's presentation time is not the instant it was
/// delivered: it runs a few milliseconds ahead of the host clock, by an amount that varies from
/// frame to frame (median 4.8 ms, spread about 20 ms). When the last frame before a pause led
/// the clock by more than the first frame after it does, subtracting the exact pause length
/// lands the new frame just behind the old one. Over 200 real pause/resume cycles at 1080p60 on
/// an M1 (macOS 26.5), 6 did, by 0.2 to 1.9 ms. Every one was captured after resume, so gating
/// frames on when they were captured would not have caught them.
///
/// Dropping the frame is the whole fix for that case, because the overlap is always less than
/// one frame interval: the next frame is already past it. Audio is not involved — its track is
/// clocked by `AudioTrackMixer`, and the writer accepts audio that steps backwards.
///
/// The gate compares in the samples' own time base. Two frames closer together than the track's
/// 1/600 s media timescale are accepted and re-spaced by the writer, so there is no rounding to
/// guard against here.
public struct VideoTimestampGate {
	public enum Verdict: Equatable {
		case admit
		/// The timestamp is not a number the writer can place.
		case invalid
		/// Not after the last frame handed to the writer.
		case notAfterPrevious(previous: CMTime)
	}

	/// The presentation time of the last frame actually handed to the writer.
	public private(set) var lastRecorded: CMTime?
	/// Frames refused so far, for the diagnostic at the end of a take.
	public private(set) var rejectedCount = 0

	public init() {}

	/// Decides whether a frame may be appended. Counts a refusal, records nothing else: a frame
	/// that passes but is then not appended (the input was not ready) must not move the gate.
	public mutating func check(_ presentationTime: CMTime) -> Verdict {
		guard presentationTime.isValid, presentationTime.isNumeric else {
			rejectedCount += 1
			return .invalid
		}
		if let lastRecorded, CMTimeCompare(presentationTime, lastRecorded) <= 0 {
			rejectedCount += 1
			return .notAfterPrevious(previous: lastRecorded)
		}
		return .admit
	}

	/// Call with the frame's presentation time just before handing it to `append`.
	///
	/// Before, not after, and whatever `append` answers: the writer judges a frame as soon as it
	/// receives it, so a frame it was given is the one the next frame has to follow.
	public mutating func record(_ presentationTime: CMTime) {
		lastRecorded = presentationTime
	}
}
