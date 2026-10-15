import CoreMedia
import XCTest
@testable import OpenScreenCaptureCore

final class ExternalMicrophoneTests: XCTestCase {
	private func packet(_ samples: [Float] = [Float](repeating: 0.5, count: 480)) -> ExternalMicrophonePacket {
		ExternalMicrophonePacket(
			recordingId: 7, timestampUs: 100_000_000,
			data: samples.withUnsafeBytes { Data($0) }
		)
	}

	func testPacketCopiesPCMAndKeepsCaptureTime() throws {
		let sample = try XCTUnwrap(packet().sampleBuffer())
		XCTAssertEqual(CMSampleBufferGetNumSamples(sample), 480)
		XCTAssertEqual(CMSampleBufferGetPresentationTimeStamp(sample), CMTime(value: 100, timescale: 1))
		XCTAssertTrue(CMSampleBufferDataIsReady(sample))
		XCTAssertNil(packet([]).sampleBuffer())
		XCTAssertNil(packet([.nan]).sampleBuffer())
		XCTAssertNil(packet([Float](repeating: 0, count: 4_801)).sampleBuffer())
	}

	func testDelayedAudioIsClippedAtPauseResumeAndStop() throws {
		var timeline = MicrophoneTimeline()
		timeline.pause(at: CMTime(value: 100_003, timescale: 1_000))
		timeline.resume(at: CMTime(value: 100_007, timescale: 1_000))
		let slices = timeline.retime(
			try XCTUnwrap(packet().sampleBuffer()),
			endingAt: CMTime(value: 100_009, timescale: 1_000)
		)
		XCTAssertEqual(slices.map(CMSampleBufferGetNumSamples), [144, 96])
		XCTAssertEqual(slices.map(CMSampleBufferGetPresentationTimeStamp), [
			CMTime(value: 100, timescale: 1), CMTime(value: 100_003, timescale: 1_000),
		])
	}

	func testAStillPausedTakeKeepsAudioCapturedBeforePause() throws {
		var timeline = MicrophoneTimeline()
		timeline.pause(at: CMTime(value: 100_004, timescale: 1_000))
		let slices = timeline.retime(try XCTUnwrap(packet().sampleBuffer()))
		XCTAssertEqual(slices.map(CMSampleBufferGetNumSamples), [192])
		XCTAssertEqual(CMSampleBufferGetPresentationTimeStamp(slices[0]), CMTime(value: 100, timescale: 1))
	}
}
