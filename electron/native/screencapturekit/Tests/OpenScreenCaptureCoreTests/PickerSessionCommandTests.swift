import XCTest
@testable import OpenScreenCaptureCore

final class PickerSessionCommandTests: XCTestCase {
	func testAcceptsMicrophonePacketsInTheSharedCommandProtocol() throws {
		let line = #"{"command":"microphone","recordingId":7,"timestampUs":1000000,"data":"AAAAPw=="}"#
		guard case .microphone(let packet) = parsePickerSessionCommand(line) else {
			return XCTFail("Expected a microphone packet")
		}
		XCTAssertEqual(packet.recordingId, 7)
		XCTAssertEqual(packet.timestampUs, 1_000_000)
		XCTAssertNotNil(packet.sampleBuffer())
		XCTAssertNil(parsePickerSessionCommand(#"{"command":"microphone","data":"bad"}"#))
	}
	func testReadsTheBareWordsTheSingleTakeHelperAlreadyUses() {
		XCTAssertEqual(parsePickerSessionCommand("pause\n"), .pause)
		XCTAssertEqual(parsePickerSessionCommand("resume"), .resume)
		XCTAssertEqual(parsePickerSessionCommand("  stop  "), .stop)
		XCTAssertEqual(parsePickerSessionCommand("quit"), .quit)
	}

	func testPresentCarriesTheWindowsToKeepOutOfTheCapture() {
		XCTAssertEqual(
			parsePickerSessionCommand(
				#"{"command":"present","excludedWindowIds":[12,34],"modes":["display"],"hideDesktopIcons":true}"#
			),
			.present(excludedWindowIDs: [12, 34], modes: [.display], hideDesktopIcons: true)
		)
	}

	func testPresentOffersScreensAndWindowsByDefault() {
		XCTAssertEqual(
			parsePickerSessionCommand(#"{"command":"present"}"#),
			.present(excludedWindowIDs: [], modes: [.display, .window], hideDesktopIcons: false)
		)
	}

	func testStartKeepsTheRequestForTheRecordersDecoder() throws {
		guard case .start(let data)? = parsePickerSessionCommand(
			#"{"command":"start","request":{"video":{"fps":60}}}"#
		) else {
			return XCTFail("expected a start command")
		}
		let request = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
		XCTAssertEqual((request["video"] as? [String: Any])?["fps"] as? Int, 60)
	}

	func testRejectsWhatItCannotRead() {
		XCTAssertNil(parsePickerSessionCommand(""))
		XCTAssertNil(parsePickerSessionCommand("record"))
		XCTAssertNil(parsePickerSessionCommand(#"{"command":"start"}"#))
		XCTAssertNil(parsePickerSessionCommand(#"{"command":"explode"}"#))
		XCTAssertNil(parsePickerSessionCommand("{not json"))
	}
}
