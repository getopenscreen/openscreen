import CoreMedia
import XCTest

import OpenScreenCaptureCore

/// Does the writer only ever see video timestamps that move forward?
///
/// A single frame that does not is -16364, and it ends the recording: see `VideoTimestampGate`.
final class VideoTimestampGateTests: XCTestCase {
	private func seconds(_ value: Double) -> CMTime {
		CMTime(seconds: value, preferredTimescale: 1_000_000_000)
	}

	func testFirstFrameIsAdmitted() {
		var gate = VideoTimestampGate()
		XCTAssertEqual(gate.check(seconds(2419.6)), .admit)
	}

	func testIncreasingFramesAreAdmitted() {
		var gate = VideoTimestampGate()
		for index in 0..<120 {
			let time = seconds(10 + Double(index) / 60)
			XCTAssertEqual(gate.check(time), .admit)
			gate.record(time)
		}
		XCTAssertEqual(gate.rejectedCount, 0)
	}

	/// The pause/resume case as it was measured on real ScreenCaptureKit frames: the first frame
	/// after resume, shifted back by the pause, landed 1.78 ms before the last frame appended
	/// before it.
	func testFrameShiftedBehindThePreviousOneByAResumeIsRefused() {
		var gate = VideoTimestampGate()
		let lastBeforePause = seconds(2419.6246833760001)
		gate.record(lastBeforePause)

		let firstAfterResume = CMTimeSubtract(seconds(2420.5588043749999), seconds(0.93589941600000004))
		XCTAssertEqual(gate.check(firstAfterResume), .notAfterPrevious(previous: lastBeforePause))

		// The overlap is less than one frame, so the frame after it is already clear.
		let next = CMTimeSubtract(seconds(2420.5588043749999 + 1.0 / 60), seconds(0.93589941600000004))
		XCTAssertEqual(gate.check(next), .admit)
		XCTAssertEqual(gate.rejectedCount, 1)
	}

	func testDuplicateTimestampIsRefused() {
		var gate = VideoTimestampGate()
		gate.record(seconds(5))
		XCTAssertEqual(gate.check(seconds(5)), .notAfterPrevious(previous: seconds(5)))
	}

	/// Equal instants in different time bases are still the same instant.
	func testDuplicateInAnotherTimescaleIsRefused() {
		var gate = VideoTimestampGate()
		gate.record(CMTime(value: 3000, timescale: 600))
		XCTAssertEqual(
			gate.check(seconds(5)),
			.notAfterPrevious(previous: CMTime(value: 3000, timescale: 600))
		)
	}

	func testInvalidTimestampIsRefused() {
		var gate = VideoTimestampGate()
		XCTAssertEqual(gate.check(.invalid), .invalid)
		XCTAssertEqual(gate.check(.indefinite), .invalid)
		XCTAssertEqual(gate.rejectedCount, 2)
	}

	/// A frame that passed but was never appended — the input was not ready — must not raise the
	/// bar for the frames after it.
	func testCheckingDoesNotMoveTheGate() {
		var gate = VideoTimestampGate()
		gate.record(seconds(1))
		XCTAssertEqual(gate.check(seconds(3)), .admit)
		XCTAssertEqual(gate.check(seconds(2)), .admit)
		XCTAssertEqual(gate.lastRecorded, seconds(1))
	}
}
