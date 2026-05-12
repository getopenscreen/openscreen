import AVFoundation
import CoreMedia
import Foundation
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
		case .writerSetupFailed(let message):
			return message
		}
	}
}

func emit(_ fields: [String: Any]) {
	if let data = try? JSONSerialization.data(withJSONObject: fields, options: []),
		let line = String(data: data, encoding: .utf8)
	{
		print(line)
		fflush(stdout)
	}
}

func emitError(code: String, message: String) {
	emit([
		"event": "error",
		"code": code,
		"message": message,
	])
}

@available(macOS 13.0, *)
final class ScreenCaptureRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
	private let request: RecordingRequest
	private let sampleQueue = DispatchQueue(label: "app.openscreen.sck-helper.samples")
	private let stateQueue = DispatchQueue(label: "app.openscreen.sck-helper.state")
	private var stream: SCStream?
	private var writer: AVAssetWriter?
	private var videoInput: AVAssetWriterInput?
	private var didStartWriting = false
	private var isStopping = false

	init(request: RecordingRequest) {
		self.request = request
	}

	func start() async throws {
		try rejectUnsupportedPhaseFeatures()

		let content = try await SCShareableContent.excludingDesktopWindows(
			false,
			onScreenWindowsOnly: true
		)
		let filter = try makeContentFilter(from: content)
		let configuration = makeStreamConfiguration()
		let stream = SCStream(filter: filter, configuration: configuration, delegate: self)

		try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
		try setupWriter()

		self.stream = stream
		emit(["event": "ready", "schemaVersion": 1])
		try await stream.startCapture()
		emit([
			"event": "recording-started",
			"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
		])
	}

	func stop() async {
		let shouldStop = stateQueue.sync {
			if isStopping {
				return false
			}
			isStopping = true
			return true
		}
		if !shouldStop {
			return
		}

		do {
			try await stream?.stopCapture()
		} catch {
			emit([
				"event": "warning",
				"code": "stop-capture-failed",
				"message": "\(error)",
			])
		}

		await finishWriter()
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		emitError(code: "capture-stopped-with-error", message: "\(error)")
		Task {
			await stop()
		}
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		guard type == .screen else {
			return
		}
		guard CMSampleBufferDataIsReady(sampleBuffer) else {
			return
		}
		guard let videoInput, let writer else {
			return
		}

		let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
		if !didStartWriting {
			writer.startWriting()
			writer.startSession(atSourceTime: presentationTime)
			didStartWriting = true
		}

		if videoInput.isReadyForMoreMediaData {
			videoInput.append(sampleBuffer)
		}
	}

	private func rejectUnsupportedPhaseFeatures() throws {
		if request.audio.system.enabled {
			throw HelperError.unsupportedFeature(
				"System audio capture is planned for the roadmap system-audio phase."
			)
		}
		if request.audio.microphone.enabled {
			throw HelperError.unsupportedFeature(
				"Microphone capture is planned for the roadmap microphone phase."
			)
		}
		if request.webcam.enabled {
			throw HelperError.unsupportedFeature(
				"Webcam composition is planned for the roadmap webcam phase."
			)
		}
	}

	private func makeContentFilter(from content: SCShareableContent) throws -> SCContentFilter {
		switch request.source.type {
		case "display":
			guard let displayId = request.source.displayId else {
				throw HelperError.sourceNotFound("Display capture requires source.displayId.")
			}
			guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
				throw HelperError.sourceNotFound("No ScreenCaptureKit display found for id \(displayId).")
			}
			return SCContentFilter(display: display, excludingWindows: [])
		case "window":
			guard let windowId = request.source.windowId else {
				throw HelperError.sourceNotFound("Window capture requires source.windowId.")
			}
			guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
				throw HelperError.sourceNotFound("No ScreenCaptureKit window found for id \(windowId).")
			}
			return SCContentFilter(desktopIndependentWindow: window)
		default:
			throw HelperError.invalidSourceType(request.source.type)
		}
	}

	private func makeStreamConfiguration() -> SCStreamConfiguration {
		let configuration = SCStreamConfiguration()
		configuration.width = request.video.width
		configuration.height = request.video.height
		configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, request.video.fps)))
		configuration.queueDepth = 6
		configuration.showsCursor = !request.video.hideSystemCursor
		configuration.pixelFormat = kCVPixelFormatType_32BGRA
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
		let settings: [String: Any] = [
			AVVideoCodecKey: AVVideoCodecType.h264,
			AVVideoWidthKey: request.video.width,
			AVVideoHeightKey: request.video.height,
			AVVideoCompressionPropertiesKey: [
				AVVideoAverageBitRateKey: request.video.bitrate ?? 18_000_000,
				AVVideoExpectedSourceFrameRateKey: request.video.fps,
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
	}

	private func finishWriter() async {
		guard let writer else {
			return
		}

		videoInput?.markAsFinished()

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
}

@main
struct OpenScreenScreenCaptureKitHelper {
	static func main() async {
		do {
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
					if command == "stop" {
						await recorder.stop()
						exit(0)
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
