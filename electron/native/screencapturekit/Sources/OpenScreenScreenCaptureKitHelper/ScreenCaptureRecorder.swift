import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import OpenScreenCaptureCore
import ScreenCaptureKit

struct Rectangle: Decodable {
	let x: Double
	let y: Double
	let width: Double
	let height: Double
}

struct RecordingRequest: Decodable {
	struct Source: Decodable {
		let type: String
		let sourceId: String
		let displayId: UInt32?
		let windowId: UInt32?
		let bounds: Rectangle?
	}

	struct Video: Decodable {
		let fps: Int
		let width: Int
		let height: Int
		let bitrate: Int?
		let hideSystemCursor: Bool
	}

	struct Audio: Decodable {
		struct SystemAudio: Decodable {
			let enabled: Bool
		}

		struct Microphone: Decodable {
			let enabled: Bool
			let deviceId: String?
			let deviceName: String?
			let gain: Double
		}

		let system: SystemAudio
		let microphone: Microphone
	}

	struct Webcam: Decodable {
		let enabled: Bool
		let deviceId: String?
		let deviceName: String?
		let width: Int
		let height: Int
		let fps: Int
	}

	struct Cursor: Decodable {
		let mode: String
	}

	struct Outputs: Decodable {
		let screenPath: String
		let manifestPath: String?
	}

	let schemaVersion: Int?
	let recordingId: Int?
	let excludedWindowIds: [UInt32]?
	let source: Source
	let video: Video
	let audio: Audio
	let webcam: Webcam
	let cursor: Cursor
	let outputs: Outputs
}

enum HelperError: Error, CustomStringConvertible {
	case invalidArguments
	case unsupportedMacOS
	case unsupportedFeature(String)
	case sourceNotFound(String)
	case invalidSourceType(String)
	case permissionDenied(String)
	case writerSetupFailed(String)

	var description: String {
		switch self {
		case .invalidArguments:
			return "Expected one JSON recording request argument."
		case .unsupportedMacOS:
			return "ScreenCaptureKit recording requires macOS 13 or newer."
		case .unsupportedFeature(let message):
			return message
		case .sourceNotFound(let message):
			return message
		case .invalidSourceType(let sourceType):
			return "Unsupported source type: \(sourceType)."
		case .permissionDenied(let message):
			return message
		case .writerSetupFailed(let message):
			return message
		}
	}
}

/// A source chosen in Apple's system picker, kept by `PickerSession` for the takes after it.
struct PickedSource {
	let filter: SCContentFilter
	/// Global frame (points, top-left origin) of what was picked, for cursor mapping.
	let frame: CGRect
	let displayId: CGDirectDisplayID?
}

@available(macOS 13.0, *)
final class ScreenCaptureRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
	private struct CaptureTarget {
		let filter: SCContentFilter
		let width: Int
		let height: Int
		// Global frame (points, top-left origin) of the captured region. Used by the
		// renderer to normalize cursor positions into the captured window's space.
		let captureFrame: CGRect
	}

	private let request: RecordingRequest
	private let sampleQueue = DispatchQueue(label: "app.openscreen.sck-helper.samples")
	private let stateQueue = DispatchQueue(label: "app.openscreen.sck-helper.state")
	private var stream: SCStream?
	private var writer: AVAssetWriter?
	private var videoInput: AVAssetWriterInput?
	// One AAC track, never one per source: the editor preview is an HTML5 <video>, which plays
	// audio track 0 and nothing else. See AudioTrackMixer.
	private var audioInput: AVAssetWriterInput?
	private var audioMixer: AudioTrackMixer?
	/// Drives the mixer's cursor while nothing is arriving to drive it. Owned by the sample
	/// queue: created when the writer session opens, cancelled on the same queue at teardown.
	private var audioTicker: DispatchSourceTimer?
	private var didStartWriting = false
	private var didEmitRecordingStarted = false
	private var didReportWriterFailure = false
	/// The one shutdown, however many callers ask for it. A writer failure starts it on
	/// its own task, and the `stop` Electron sends right after has to wait for that run:
	/// the command loop exits the process as soon as `stop()` returns, which would cut
	/// `finishWriter()` off before its terminal event.
	private var shutdownTask: Task<Void, Never>?
	private var isPaused = false
	private var pauseStartedAt: CMTime?
	private var totalPausedDuration = CMTime.zero
	/// Sample queue only. See `VideoTimestampGate` for the failure it exists to prevent.
	private var videoTimestampGate = VideoTimestampGate()
	private var nativeMicrophoneEnabled = false
	private var outputWidth = 1920
	private var outputHeight = 1080
	private var captureFrame = CGRect.zero
	private let microphoneOutputTypeRawValue = 2
	private let hostClock = CMClockGetHostTimeClock()
	private let picked: PickedSource?
	/// A `SystemAudioTap` (macOS 14.2+), held untyped so this class keeps its macOS 13 floor.
	private var systemAudioTap: AnyObject?
	/// Sample queue only. Cleared before the writer is finalised: a tap stops on its own
	/// queue, and a buffer it had in flight must not reach a finished writer input.
	private var acceptsTappedAudio = true
	private let tapControlQueue = DispatchQueue(label: "app.openscreen.sck-helper.system-audio-control")

	/// `picked` is a choice already made in Apple's system picker (`PickerSession`). The take
	/// then records exactly that filter: no source lookup, and no Screen Recording check,
	/// because the user's pick IS the consent -- asking for the grant here would put back
	/// the very prompt the picker path exists to remove.
	init(request: RecordingRequest, picked: PickedSource? = nil) {
		self.request = request
		self.picked = picked
	}

	/// Whether this take's system audio comes from a Core Audio tap instead of ScreenCaptureKit.
	///
	/// Only for a source from Apple's picker: that capture holds no Screen Recording grant,
	/// and ScreenCaptureKit hands a grantless capture its system audio as silence. Every other
	/// source keeps ScreenCaptureKit's audio, which its grant already covers.
	private var tapsSystemAudio: Bool {
		guard picked != nil, request.audio.system.enabled else {
			return false
		}
		if #available(macOS 14.2, *) {
			return true
		}
		return false
	}

	func start() async throws {
		try ensureRequestedPermissions(screen: picked == nil)

		let target: CaptureTarget
		if let picked {
			target = makeCaptureTarget(picked: picked)
		} else {
			let content = try await SCShareableContent.excludingDesktopWindows(
				false,
				onScreenWindowsOnly: true
			)
			target = try makeCaptureTarget(from: content)
		}
		outputWidth = target.width
		outputHeight = target.height
		captureFrame = target.captureFrame
		let configuration = makeStreamConfiguration()
		let stream = SCStream(filter: target.filter, configuration: configuration, delegate: self)

		try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
		if request.audio.system.enabled && !tapsSystemAudio {
			try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
		}
		if nativeMicrophoneEnabled {
			guard let microphoneOutputType = SCStreamOutputType(rawValue: microphoneOutputTypeRawValue) else {
				throw HelperError.unsupportedFeature(
					"Native microphone capture requires a macOS version with ScreenCaptureKit microphone output."
				)
			}
			try stream.addStreamOutput(self, type: microphoneOutputType, sampleHandlerQueue: sampleQueue)
		}
		try setupWriter()
		startSystemAudioTapIfNeeded()

		self.stream = stream
		emit([
			"event": "ready",
			"schemaVersion": 1,
		])
		try await stream.startCapture()
	}

	func stop() async {
		let task = stateQueue.sync { () -> Task<Void, Never> in
			if let shutdownTask {
				return shutdownTask
			}
			let task = Task {
				await self.performStop()
			}
			shutdownTask = task
			return task
		}
		await task.value
	}

	private func performStop() async {
		do {
			try await stream?.stopCapture()
		} catch {
			emit([
				"event": "warning",
				"code": "stop-capture-failed",
				"message": "\(error)",
			])
		}
		stopSystemAudioTap()

		await finishWriter()
	}

	private func startSystemAudioTapIfNeeded() {
		guard tapsSystemAudio, #available(macOS 14.2, *) else {
			return
		}
		let tap = SystemAudioTap { [weak self] sampleBuffer in
			guard let self else {
				return
			}
			self.sampleQueue.async {
				self.ingestTappedSystemAudio(sampleBuffer)
			}
		}
		systemAudioTap = tap
		// Off the start path: the first time, starting a tap blocks until the user answers
		// macOS' prompt, and the app gives a take only seconds to report it has started.
		// Audio that arrives late lands where it belongs, with silence in front of it.
		tapControlQueue.async {
			do {
				try tap.start()
			} catch {
				emit([
					"event": "warning",
					"code": "system-audio-unavailable",
					"message": "System audio could not be captured: \(error)",
				])
			}
		}
	}

	/// Queued behind the start rather than run beside it: a tap stopped while its start is
	/// still inside AudioDeviceStart is torn down under its own feet. Not awaited, so a
	/// prompt left unanswered cannot hold the recording's stop hostage; what the tap still
	/// delivers is dropped by `acceptsTappedAudio`.
	private func stopSystemAudioTap() {
		sampleQueue.sync {
			acceptsTappedAudio = false
		}
		guard let tap = systemAudioTap else {
			return
		}
		systemAudioTap = nil
		tapControlQueue.async {
			if #available(macOS 14.2, *), let tap = tap as? SystemAudioTap {
				tap.stop()
			}
		}
	}

	/// Sample queue. The tap's audio takes the same pause and retime path ScreenCaptureKit's
	/// system audio took in `stream(_:didOutputSampleBuffer:of:)`.
	private func ingestTappedSystemAudio(_ sampleBuffer: CMSampleBuffer) {
		guard acceptsTappedAudio else {
			return
		}
		let pauseState = currentPauseState()
		if pauseState.paused {
			return
		}
		guard let sampleBuffer = retimedSampleBuffer(sampleBuffer, subtracting: pauseState.offset) else {
			return
		}
		audioMixer?.ingest(sampleBuffer, from: .system)
	}

	func pause() {
		let didPause = stateQueue.sync {
			if shutdownTask != nil || isPaused {
				return false
			}

			isPaused = true
			pauseStartedAt = CMClockGetTime(hostClock)
			return true
		}

		if didPause {
			emit([
				"event": "recording-paused",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
			])
		}
	}

	func resume() {
		let didResume = stateQueue.sync {
			if shutdownTask != nil || !isPaused {
				return false
			}

			if let pauseStartedAt {
				let now = CMClockGetTime(hostClock)
				totalPausedDuration = CMTimeAdd(
					totalPausedDuration,
					CMTimeSubtract(now, pauseStartedAt)
				)
			}
			isPaused = false
			pauseStartedAt = nil
			return true
		}

		if didResume {
			emit([
				"event": "recording-resumed",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
			])
		}
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		emitError(code: "capture-stopped-with-error", message: "\(error)")
		Task {
			await stop()
		}
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		guard CMSampleBufferDataIsReady(sampleBuffer) else {
			return
		}
		let pauseState = currentPauseState()
		if pauseState.paused {
			return
		}
		guard let sampleBuffer = retimedSampleBuffer(sampleBuffer, subtracting: pauseState.offset) else {
			return
		}

		if type == .audio {
			audioMixer?.ingest(sampleBuffer, from: .system)
			return
		}

		if type.rawValue == microphoneOutputTypeRawValue {
			audioMixer?.ingest(sampleBuffer, from: .microphone)
			return
		}

		guard type == .screen else {
			return
		}
		guard isCompleteFrame(sampleBuffer) else {
			return
		}
		guard let videoInput, let writer else {
			return
		}
		let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
		// A frame that does not move the timeline forward fails the whole writer one append
		// later (-16364), so it is dropped here instead. After a resume that is one frame the
		// user never sees; without the check it was the end of the recording.
		switch videoTimestampGate.check(presentationTime) {
		case .admit:
			break
		case .invalid:
			reportRefusedVideoFrame(presentationTime, previous: nil, pauseOffset: pauseState.offset)
			return
		case .notAfterPrevious(let previous):
			reportRefusedVideoFrame(presentationTime, previous: previous, pauseOffset: pauseState.offset)
			return
		}
		if !didStartWriting {
			writer.startWriting()
			writer.startSession(atSourceTime: presentationTime)
			didStartWriting = true
			audioMixer?.beginTimeline(at: presentationTime)
			startAudioTicker()
		}
		// Checked before the readiness gate, not only at a false append: a failed
		// writer is not guaranteed to call itself ready, and an append that is never
		// attempted can never report the failure (issue #621).
		if writer.status == .failed {
			reportWriterFailure("writer status")
			return
		}

		if videoInput.isReadyForMoreMediaData {
			videoTimestampGate.record(presentationTime)
			let appended = videoInput.append(sampleBuffer)
			if appended, !didEmitRecordingStarted {
				didEmitRecordingStarted = true
				emit([
					"event": "recording-started",
					"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
					"width": outputWidth,
					"height": outputHeight,
					"captureBounds": captureBoundsPayload(),
				])
			} else if !appended {
				reportWriterFailure("video append")
			}
		}
	}

	/// A failed AVAssetWriter keeps accepting appends and keeps answering false, so
	/// a recorder that discards that Bool records nothing while the HUD counts on.
	/// That is how a two-minute take was already lost by its fourth second and only
	/// said so at finishWriting(). The Windows helper checks every WriteSample
	/// HRESULT and escalates; this is the macOS half of the same contract -- report
	/// once, at the append that actually failed, carrying the live writer.error.
	///
	/// Deliberately not the code finishWriter() emits, and the difference is load
	/// bearing. That one is the terminal result of stopping, and the Electron side
	/// settles its stop on exactly one of `recording-stopped` or `writer-failed`.
	/// Give both sites the same code behind this one-shot guard and a writer that
	/// died mid-capture emits nothing at all at stop, so the stop promise never
	/// settles and every failure becomes the "Saving..." hang instead of an error.
	/// This event answers "when did the writer die"; that one answers "did stopping
	/// work". Two questions, two codes.
	///
	/// It also ends the capture, the way `didStopWithError` does. A failed writer
	/// never recovers, so every frame after it is dropped; issue #621 is a take
	/// whose writer died at 75 s while capture ran on for 22 more minutes. The
	/// process stays up and still answers `stop`, so the Electron stop path works
	/// unchanged and reads this event back as the reason.
	private func reportWriterFailure(_ stage: String) {
		guard !didReportWriterFailure, let writer else {
			return
		}
		didReportWriterFailure = true
		emitError(
			code: "writer-failed-during-capture",
			message: "Recording stopped: the video file could not be written (\(stage): "
				+ (writer.error.map { "\($0)" }
					?? "AVAssetWriter status \(writer.status.rawValue)")
				+ ").",
		)
		Task {
			await stop()
		}
	}

	/// Once per take, with the numbers that tell the cause apart. A refusal with a non-zero pause
	/// offset, a few milliseconds behind the previous frame, is the pause shift measured in
	/// `VideoTimestampGate`. One with no pause offset at all is a source handing over time that
	/// goes backwards, which nothing here has observed yet and is worth a report.
	private func reportRefusedVideoFrame(_ presentationTime: CMTime, previous: CMTime?, pauseOffset: CMTime) {
		guard videoTimestampGate.rejectedCount == 1 else {
			return
		}
		emit([
			"event": "warning",
			"code": "video-frame-timestamp-refused",
			"message": "Dropped a video frame whose timestamp did not advance.",
			"presentationTimeSeconds": presentationTime.isNumeric ? CMTimeGetSeconds(presentationTime) : -1,
			"previousSeconds": previous.map { CMTimeGetSeconds($0) } ?? -1,
			"pauseOffsetSeconds": pauseOffset.isNumeric ? CMTimeGetSeconds(pauseOffset) : 0,
		])
	}

	private func ensureRequestedPermissions(screen: Bool) throws {
		if screen && !CGPreflightScreenCaptureAccess() {
			let granted = CGRequestScreenCaptureAccess()
			if !granted {
				throw HelperError.permissionDenied("Screen recording permission is required for ScreenCaptureKit capture.")
			}
		}

		if request.audio.microphone.enabled {
			switch AVCaptureDevice.authorizationStatus(for: .audio) {
			case .authorized:
				break
			case .notDetermined:
				let semaphore = DispatchSemaphore(value: 0)
				AVCaptureDevice.requestAccess(for: .audio) { _ in
					semaphore.signal()
				}
				let waitResult = semaphore.wait(timeout: .now() + 30)
				if waitResult == .timedOut || AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
					throw HelperError.permissionDenied("Microphone permission is required for native microphone capture.")
				}
			default:
				throw HelperError.permissionDenied("Microphone permission is required for native microphone capture.")
			}
		}
	}

	private func captureBoundsPayload() -> [String: Double] {
		return [
			"x": captureFrame.origin.x,
			"y": captureFrame.origin.y,
			"width": captureFrame.size.width,
			"height": captureFrame.size.height,
		]
	}

	private func makeCaptureTarget(picked: PickedSource) -> CaptureTarget {
		let size = captureSize(
			for: picked.filter,
			fallbackPointSize: picked.frame.size,
			fallbackDisplayId: picked.displayId ?? CGMainDisplayID()
		)
		return CaptureTarget(
			filter: picked.filter,
			width: size.width,
			height: size.height,
			captureFrame: picked.frame
		)
	}

	private func makeCaptureTarget(from content: SCShareableContent) throws -> CaptureTarget {
		switch request.source.type {
		case "display":
			guard let displayId = request.source.displayId else {
				throw HelperError.sourceNotFound("Display capture requires source.displayId.")
			}
			guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
				throw HelperError.sourceNotFound("No ScreenCaptureKit display found for id \(displayId).")
			}
			let requestedWindowIDs = request.excludedWindowIds ?? []
			let resolvedWindowIDs = resolveCaptureExcludedWindowIDs(
				requestedWindowIDs: requestedWindowIDs,
				availableWindowIDs: content.windows.map(\.windowID)
			)
			let resolvedWindowIDSet = Set(resolvedWindowIDs)
			let excludedWindows = content.windows.filter {
				resolvedWindowIDSet.contains($0.windowID)
			}
			let filter = SCContentFilter(display: display, excludingWindows: excludedWindows)
			emit([
				"event": "capture-window-exclusion",
				"requestedWindowIds": requestedWindowIDs,
				"resolvedWindowIds": resolvedWindowIDs,
				"excludedWindowCount": excludedWindows.count,
			])
			let size = captureSize(
				for: filter,
				fallbackPointSize: display.frame.size,
				fallbackDisplayId: display.displayID
			)
			return CaptureTarget(
				filter: filter,
				width: size.width,
				height: size.height,
				captureFrame: display.frame
			)
		case "window":
			guard let windowId = request.source.windowId else {
				throw HelperError.sourceNotFound("Window capture requires source.windowId.")
			}
			guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
				throw HelperError.sourceNotFound("No ScreenCaptureKit window found for id \(windowId).")
			}
			let candidateDisplay = content.displays.first {
				$0.frame.intersects(window.frame) || $0.frame.contains(CGPoint(x: window.frame.midX, y: window.frame.midY))
			}
			let filter = SCContentFilter(desktopIndependentWindow: window)
			let size = captureSize(
				for: filter,
				fallbackPointSize: window.frame.size,
				// Unrelated to `initializeCoreGraphicsWindowServerConnection()`: that call
				// exists purely for its side effect at process startup, this one wants the
				// actual display ID as a fallback when no display intersects the window.
				fallbackDisplayId: candidateDisplay?.displayID ?? CGMainDisplayID()
			)
			return CaptureTarget(
				filter: filter,
				width: size.width,
				height: size.height,
				captureFrame: window.frame
			)
		default:
			throw HelperError.invalidSourceType(request.source.type)
		}
	}

	private func makeStreamConfiguration() -> SCStreamConfiguration {
		let configuration = SCStreamConfiguration()
		configuration.width = outputWidth
		configuration.height = outputHeight
		// Belt and braces for the defect `captureOutputSize` exists to prevent. Left at its
		// default of `false`, ScreenCaptureKit "only scales down" (SDK header), so any frame
		// smaller than the buffer is drawn at native size in a corner and the rest stays
		// background black — a whole recording letterboxed inside its own frame (issue #418).
		// With the buffer now derived from the filter the two agree and this changes nothing;
		// it is here so that a future source whose size we mispredict comes out scaled rather
		// than cornered.
		configuration.scalesToFit = true
		configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, request.video.fps)))
		configuration.queueDepth = 6
		configuration.showsCursor = !request.video.hideSystemCursor
		configuration.pixelFormat = kCVPixelFormatType_32BGRA
		configuration.sampleRate = 48_000
		configuration.channelCount = 2
		configuration.excludesCurrentProcessAudio = true
		configuration.capturesAudio = request.audio.system.enabled && !tapsSystemAudio

		if request.audio.microphone.enabled {
			guard supportsNativeMicrophoneCapture(streamConfig: configuration) else {
				nativeMicrophoneEnabled = false
				emit([
					"event": "warning",
					"code": "microphone-unavailable",
					"message": "Native microphone capture requires ScreenCaptureKit microphone support on this macOS version.",
				])
				return configuration
			}
			nativeMicrophoneEnabled = true
			configuration.capturesAudio = true
			configuration.setValue(true, forKey: "captureMicrophone")
			if let deviceId = resolveMicrophoneCaptureDeviceID() {
				configuration.setValue(deviceId, forKey: "microphoneCaptureDeviceID")
			} else if requestedASpecificMicrophone {
				emit([
					"event": "warning",
					"code": "microphone-defaulted",
					"message": "The requested microphone could not be resolved; capturing the default input.",
				])
			}
		} else {
			nativeMicrophoneEnabled = false
		}

		return configuration
	}

	private func setupWriter() throws {
		let outputUrl = URL(fileURLWithPath: request.outputs.screenPath)
		try? FileManager.default.removeItem(at: outputUrl)
		try FileManager.default.createDirectory(
			at: outputUrl.deletingLastPathComponent(),
			withIntermediateDirectories: true
		)

		let writer = try AVAssetWriter(outputURL: outputUrl, fileType: .mp4)
		// Costs nothing on a clean stop -- finishWriting() still writes a normal
		// moov -- and is the difference between a readable file and a total loss
		// when the helper dies before reaching it. The Windows helper gets the
		// same property from MFCreateFMPEG4MediaSink; see issues #252/#292/#327.
		writer.movieFragmentInterval = CMTime(seconds: 1, preferredTimescale: 600)
		let settings: [String: Any] = [
			AVVideoCodecKey: AVVideoCodecType.h264,
			AVVideoWidthKey: outputWidth,
			AVVideoHeightKey: outputHeight,
			AVVideoCompressionPropertiesKey: [
				AVVideoAverageBitRateKey: request.video.bitrate ?? 18_000_000,
				AVVideoExpectedSourceFrameRateKey: request.video.fps,
				// Without this the encoder defaults to B-frames, and a reordered
				// stream needs a composition offset per sample. AVAssetWriter emits
				// those in a version 0 `trun`, where ISO/IEC 14496-12 8.8.8.2 defines
				// the field as UNSIGNED -- so a negative offset goes out as
				// 0xFFFFFFF6 and the fragment writer refuses the fragment it is
				// about to emit. That refusal is -11800 / -16341, raised from the
				// single site in MediaToolbox that writes moof/traf/trun, which is
				// why it appears if and only if movieFragmentInterval is set and
				// lands exactly on a fragment boundary.
				//
				// Turning reordering off makes every offset zero and PTS == DTS, so
				// the fragment stays representable. A screen recorder gives up
				// nothing for it: B-frames buy compression on lookahead-friendly
				// content and cost encode latency, which is the wrong trade for
				// real-time capture.
				//
				// Measured on macOS 26.5 / M1, 1080p with system audio. How reliably
				// the bug bites scales with append rate, so quote the rate with the
				// result: at ~57 fps, the rate the app actually drives, reordering
				// on dies at 13.0s while reordering off stops clean at 31.6s; at
				// 30 fps it is intermittent, dying at 1.0s and 2.0s but once
				// surviving 22.2s. That intermittency is why the byte-level evidence
				// leads here and the run counts only corroborate: the offsets are
				// out of spec in every fragmented file whether or not that
				// particular run happened to die. Reordering off is 3/3 clean across
				// both rates, and a SIGKILL at 25s still leaves 27 readable `moof`.
				AVVideoAllowFrameReorderingKey: false,
			],
		]
		let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
		input.expectsMediaDataInRealTime = true

		guard writer.canAdd(input) else {
			throw HelperError.writerSetupFailed("Unable to add H.264 video input to AVAssetWriter.")
		}

		writer.add(input)
		self.writer = writer
		self.videoInput = input

		// A single mixed AAC track at the bitrate Windows encodes its own mixed track with
		// (24 000 B/s), so the two platforms produce comparable files.
		if request.audio.system.enabled || nativeMicrophoneEnabled {
			let input = try addAudioInput(to: writer, bitRate: 192_000)
			audioInput = input
			audioMixer = AudioTrackMixer(
				input: input,
				includesSystemAudio: request.audio.system.enabled,
				includesMicrophone: nativeMicrophoneEnabled,
				microphoneGain: request.audio.microphone.gain,
				clock: { [weak self] in self?.timelineNow() ?? .invalid }
			)
		}
	}

	/// The instant the writer's timeline has reached: the host clock, less the time spent
	/// paused — the same transform `retimedSampleBuffer` applies to every sample, so this and
	/// the presentation timestamps are answers in one domain.
	///
	/// Frozen while paused, because `pauseStartedAt` stops moving and `totalPausedDuration`
	/// does not yet include the pause in progress. On resume the offset grows by exactly the
	/// pause, so the position continues from where it froze: the pause interrupts the audio
	/// clock without shifting anything recorded after it. That is the same property the
	/// Windows mixer gets by re-deriving its anchor on resume, derived here instead of tracked.
	private func timelineNow() -> CMTime {
		let (paused, offset, pausedAt) = stateQueue.sync {
			(isPaused, totalPausedDuration, pauseStartedAt)
		}
		let now = paused ? (pausedAt ?? CMClockGetTime(hostClock)) : CMClockGetTime(hostClock)
		return CMTimeSubtract(now, offset)
	}

	/// A take that nothing is playing into is exactly the take whose audio timeline has to keep
	/// moving, so the mixer cannot be driven by buffer arrival alone. 10 ms is the chunk size it
	/// emits at; the leeway lets the system coalesce the wakeups, since being a few milliseconds
	/// late only means the next tick emits two chunks instead of one.
	private func startAudioTicker() {
		guard audioMixer != nil, audioTicker == nil else {
			return
		}

		let timer = DispatchSource.makeTimerSource(queue: sampleQueue)
		timer.schedule(
			deadline: .now() + .milliseconds(10),
			repeating: .milliseconds(10),
			leeway: .milliseconds(5)
		)
		timer.setEventHandler { [weak self] in
			guard let self else {
				return
			}
			// A still screen delivers no complete frames, so the frame path alone
			// could sit on a dead writer for as long as nothing on screen moves.
			if self.writer?.status == .failed {
				self.reportWriterFailure("writer status")
				return
			}
			self.audioMixer?.tick()
		}
		audioTicker = timer
		timer.resume()
	}

	private func finishWriter() async {
		guard let writer else {
			return
		}

		// A take that ended before its first frame -- a start that failed after the writer
		// was set up, or a stop right away -- never called `startWriting`. Finishing (or
		// even marking inputs finished on) a writer in that state raises an Objective-C
		// exception, which kills the process: here, in a picker session, that would take
		// every later take and the user's pick down with it. There is nothing to finalise:
		// drop whatever file the writer may have created and say the take produced none.
		if writer.status == .unknown {
			sampleQueue.sync {
				audioTicker?.cancel()
				audioTicker = nil
			}
			try? FileManager.default.removeItem(atPath: request.outputs.screenPath)
			emitError(
				code: "writer-failed",
				message: "The recording stopped before its first frame was written."
			)
			return
		}

		// Capture has stopped, so nothing is in flight on the sample queue any more; hopping
		// onto it once is what makes the mixer's final flush safe without a lock, and it is
		// also where the ticker has to die, since that is the queue it fires on.
		//
		// `endSession` is the trailing half of the same bug the clock-driven cursor fixes at
		// the front. Without it the file ended at the last sample anything happened to deliver,
		// so a ten-second take that went quiet at six yielded a six-second recording; the
		// helper had never called it at all. `end` comes from the same clock the mixer runs on
		// and is read after `stopCapture()` returned, so it is at or past every sample already
		// appended — which is what makes it safe to hand to `endSession`, since a source time
		// before an appended sample would trim that sample back out.
		sampleQueue.sync {
			audioTicker?.cancel()
			audioTicker = nil

			let end = timelineNow()
			audioMixer?.finish(atSourceTime: end)
			if didStartWriting, writer.status == .writing {
				writer.endSession(atSourceTime: end)
			}
		}

		let refusedVideoFrames = sampleQueue.sync { videoTimestampGate.rejectedCount }
		if refusedVideoFrames > 1 {
			emit([
				"event": "warning",
				"code": "video-frame-timestamps-refused",
				"message": "Dropped \(refusedVideoFrames) video frames whose timestamps did not advance.",
				"count": refusedVideoFrames,
			])
		}

		videoInput?.markAsFinished()
		audioInput?.markAsFinished()

		await withCheckedContinuation { continuation in
			writer.finishWriting {
				continuation.resume()
			}
		}

		if writer.status == .completed {
			emit([
				"event": "recording-stopped",
				"screenPath": request.outputs.screenPath,
			])
		} else {
			emitError(
				code: "writer-failed",
				message: writer.error.map { "\($0)" } ?? "AVAssetWriter failed with status \(writer.status.rawValue)."
			)
		}
	}

	private func addAudioInput(to writer: AVAssetWriter, bitRate: Int) throws -> AVAssetWriterInput {
		let settings: [String: Any] = [
			AVFormatIDKey: kAudioFormatMPEG4AAC,
			AVSampleRateKey: 48_000,
			AVNumberOfChannelsKey: 2,
			AVEncoderBitRateKey: bitRate,
		]
		let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
		input.expectsMediaDataInRealTime = true

		guard writer.canAdd(input) else {
			throw HelperError.writerSetupFailed("Unable to add AAC audio input to AVAssetWriter.")
		}

		writer.add(input)
		return input
	}

	private func currentPauseState() -> (paused: Bool, offset: CMTime) {
		stateQueue.sync {
			(isPaused, totalPausedDuration)
		}
	}

	private func retimedSampleBuffer(_ sampleBuffer: CMSampleBuffer, subtracting offset: CMTime) -> CMSampleBuffer? {
		if !offset.isValid || offset == .zero {
			return sampleBuffer
		}

		let sampleCount = CMSampleBufferGetNumSamples(sampleBuffer)
		if sampleCount <= 0 {
			return sampleBuffer
		}

		var timing = Array(repeating: CMSampleTimingInfo(), count: sampleCount)
		let timingStatus = CMSampleBufferGetSampleTimingInfoArray(
			sampleBuffer,
			entryCount: sampleCount,
			arrayToFill: &timing,
			entriesNeededOut: nil
		)
		// Both failures drop the sample rather than pass it on unshifted. An unshifted frame sits
		// a whole pause ahead of the timeline, and every correctly shifted frame after it would
		// then fall behind it — refused by the timestamp gate for as long as the pause lasted.
		if timingStatus != noErr {
			emit([
				"event": "warning",
				"code": "sample-retime-failed",
				"message": "Unable to read sample timing info: \(timingStatus).",
			])
			return nil
		}

		for index in timing.indices {
			if timing[index].presentationTimeStamp.isValid {
				timing[index].presentationTimeStamp = CMTimeSubtract(
					timing[index].presentationTimeStamp,
					offset
				)
			}
			if timing[index].decodeTimeStamp.isValid {
				timing[index].decodeTimeStamp = CMTimeSubtract(timing[index].decodeTimeStamp, offset)
			}
		}

		var retimedBuffer: CMSampleBuffer?
		let copyStatus = CMSampleBufferCreateCopyWithNewTiming(
			allocator: kCFAllocatorDefault,
			sampleBuffer: sampleBuffer,
			sampleTimingEntryCount: sampleCount,
			sampleTimingArray: &timing,
			sampleBufferOut: &retimedBuffer
		)
		if copyStatus != noErr {
			emit([
				"event": "warning",
				"code": "sample-retime-failed",
				"message": "Unable to copy sample timing info: \(copyStatus).",
			])
			return nil
		}

		return retimedBuffer
	}

	private func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
		guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
			sampleBuffer,
			createIfNecessary: false
		) as? [[SCStreamFrameInfo: Any]],
			let attachment = attachments.first,
			let statusRawValue = attachment[SCStreamFrameInfo.status] as? Int,
			let status = SCFrameStatus(rawValue: statusRawValue)
		else {
			return true
		}

		return status == .complete
	}

	/// Output-buffer size for a filter, capped by the resolution the app asked for.
	///
	/// The filter is asked first, because `contentRect × pointPixelScale` is by definition the
	/// pixel size ScreenCaptureKit is about to rasterise — see `captureOutputSize`, which also
	/// explains what a buffer sized any other way does to the frame (issue #418).
	///
	/// Those two properties are macOS 14. On 13 the fallback is the region's own point size
	/// times the display's scale factor, which is the same product one step further from the
	/// source. It is NOT `CGDisplayPixelsWide`/`High`: those follow the display *mode* rather
	/// than the filter, and the mismatch between them is the bug.
	private func captureSize(
		for filter: SCContentFilter,
		fallbackPointSize: CGSize,
		fallbackDisplayId: CGDirectDisplayID
	) -> (width: Int, height: Int) {
		let contentSize: CGSize
		let pointPixelScale: CGFloat
		if #available(macOS 14.0, *) {
			contentSize = filter.contentRect.size
			pointPixelScale = CGFloat(filter.pointPixelScale)
		} else {
			contentSize = fallbackPointSize
			pointPixelScale = CGFloat(Self.scaleFactor(for: fallbackDisplayId))
		}
		return captureOutputSize(
			contentSize: contentSize,
			pointPixelScale: pointPixelScale,
			maxWidth: request.video.width,
			maxHeight: request.video.height
		)
	}

	private static func scaleFactor(for displayId: CGDirectDisplayID) -> Int {
		guard let mode = CGDisplayCopyDisplayMode(displayId) else {
			return 1
		}

		return max(1, mode.pixelWidth / max(1, mode.width))
	}

	private func supportsNativeMicrophoneCapture(streamConfig: SCStreamConfiguration) -> Bool {
		streamConfig.responds(to: Selector(("setCaptureMicrophone:"))) &&
			streamConfig.responds(to: Selector(("setMicrophoneCaptureDeviceID:"))) &&
			SCStreamOutputType(rawValue: microphoneOutputTypeRawValue) != nil
	}

	/// Did the user actually ask for a particular microphone?
	///
	/// The same test the Windows helper makes before emitting this warning
	/// (`wantedAParticularMicrophone` in wgc-capture/src/wasapi_loopback_capture.cpp),
	/// and it has to be made here too because `resolveMicrophoneCaptureDeviceID()`
	/// returns nil for two very different situations. One is a chosen microphone that
	/// nothing here could find, which is worth saying out loud. The other is no choice
	/// at all, which is the common case and has to stay silent: the HUD leaves both
	/// fields unset until its picker moves off "default", and persists the literal id
	/// "default" when the user picks Chromium's own Default entry — so both shapes
	/// arrive here meaning "the system default is fine", not "your microphone is gone".
	private var requestedASpecificMicrophone: Bool {
		let deviceId =
			request.audio.microphone.deviceId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		let deviceName =
			request.audio.microphone.deviceName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		// "default" has to veto the name, not sit beside it. Chromium's picker
		// persists BOTH fields from whichever entry was clicked, and its Default
		// entry is labelled "Default - Microphone (…)" — a string no AVCaptureDevice
		// localizedName ever matches. Reading the name here meant that picking
		// "Default" warned about a microphone the user never chose.
		if deviceId == "default" { return false }
		return !deviceId.isEmpty || !deviceName.isEmpty
	}

	private func resolveMicrophoneCaptureDeviceID() -> String? {
		resolveMicrophoneDeviceID(
			deviceID: request.audio.microphone.deviceId,
			deviceName: request.audio.microphone.deviceName,
			devices: AVCaptureDevice.devices(for: .audio).map {
				(id: $0.uniqueID, name: $0.localizedName)
			}
		)
	}
}

@main
struct OpenScreenScreenCaptureKitHelper {
	// This helper is a plain command-line executable, so nothing has connected it to the
	// window server yet. `SCContentFilter(desktopIndependentWindow:)` reaches into SkyLight
	// (`SLSGetDisplaysWithRect`) to find the display a window sits on, and SkyLight aborts
	// with `CGS_REQUIRE_INIT` when CoreGraphics was never initialised in the process — so
	// every window capture crashed before it produced a frame, while display capture (which
	// never resolves a rect) worked fine. Touching any CoreGraphics display API first
	// performs that initialisation.
	private static func initializeCoreGraphicsWindowServerConnection() {
		_ = CGMainDisplayID()
	}

	/// The flag that turns this helper into a one-shot answer to "may we record the
	/// screen", printed as the usual single JSON line and nothing else.
	private static let screenAccessStatusFlag = "--screen-access-status"

	/// The flag that turns this helper into a long-lived session around Apple's system
	/// picker. See `PickerSession`.
	private static let pickerSessionFlag = "--picker-session"

	/// The flag that raises macOS' "record system audio" prompt and exits once it is
	/// answered. See `SystemAudioTap.requestAccess`.
	private static let requestSystemAudioFlag = "--request-system-audio"

	static func main() async {
		do {
			initializeCoreGraphicsWindowServerConnection()

			// Answered from a process that exists for one read and then dies, because a FRESH
			// PROCESS is the only place the answer can be trusted.
			// `CGPreflightScreenCaptureAccess()` caches its result for the life of the calling
			// process: once it has answered false it answers false forever, whatever the user
			// does in System Settings afterwards. The app is long-lived, and Chromium's
			// `getMediaAccessStatus("screen")` goes through that same function, so from the
			// first miss until the next relaunch the app cannot observe its own permission
			// being granted. That staleness -- not the missing prompt alone -- is what left
			// the permission unreachable without a restart.
			//
			// Deliberately BEFORE the macOS 13 guard and the request decode below: the question
			// is asked on every macOS the app supports, and answering it needs neither
			// ScreenCaptureKit nor a recording request.
			if CommandLine.arguments.count == 2, CommandLine.arguments[1] == screenAccessStatusFlag {
				emit([
					"event": "screen-access",
					"granted": CGPreflightScreenCaptureAccess(),
				])
				exit(0)
			}

			if CommandLine.arguments.count == 2, CommandLine.arguments[1] == requestSystemAudioFlag {
				guard #available(macOS 14.2, *) else {
					emitError(
						code: "system-audio-unsupported",
						message: "Core Audio process taps need macOS 14.2 or later."
					)
					exit(2)
				}
				do {
					try SystemAudioTap.requestAccess()
					emit(["event": "system-audio-access-requested"])
					exit(0)
				} catch {
					emitError(code: "system-audio-request-failed", message: "\(error)")
					exit(1)
				}
			}

			if CommandLine.arguments.count == 2, CommandLine.arguments[1] == pickerSessionFlag {
				guard #available(macOS 15.2, *) else {
					emitError(
						code: "picker-session-unsupported",
						message: "The system picker session needs macOS 15.2 or later."
					)
					exit(2)
				}
				PickerSession().run()
			}

			guard CommandLine.arguments.count == 2 else {
				throw HelperError.invalidArguments
			}

			guard #available(macOS 13.0, *) else {
				throw HelperError.unsupportedMacOS
			}

			let requestData = Data(CommandLine.arguments[1].utf8)
			let decoder = JSONDecoder()
			let request = try decoder.decode(RecordingRequest.self, from: requestData)
			let recorder = ScreenCaptureRecorder(request: request)
			let stopTask = Task.detached {
				while let line = readLine() {
					let command = line.trimmingCharacters(in: .whitespacesAndNewlines)
					switch command {
					case "pause":
						recorder.pause()
					case "resume":
						recorder.resume()
					case "stop":
						await recorder.stop()
						exit(0)
					default:
						break
					}
				}
			}

			try await recorder.start()
			await stopTask.value
		} catch let error as HelperError {
			emitError(code: "helper-error", message: error.description)
			exit(1)
		} catch {
			emitError(code: "helper-error", message: "\(error)")
			exit(1)
		}
	}
}
