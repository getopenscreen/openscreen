import XCTest
import OpenScreenCaptureCore

final class MicrophoneDeviceSelectionTests: XCTestCase {
	private let devices = [(id: "studio", name: "Studio Display"), (id: "mv7", name: "Shure MV7")]

	func testChromiumUSBLabelResolvesToSelectedMicrophone() {
		XCTAssertEqual(resolveMicrophoneDeviceID(deviceID: "browser-hash", deviceName: "Shure MV7 (14ed:1012)", devices: devices), "mv7")
	}

	func testNativeIDTakesPrecedenceOverStaleName() {
		XCTAssertEqual(resolveMicrophoneDeviceID(deviceID: "mv7", deviceName: "Studio Display", devices: devices), "mv7")
	}

	func testExactNameAndWhitespace() {
		XCTAssertEqual(resolveMicrophoneDeviceID(deviceID: nil, deviceName: " Shure MV7 ", devices: devices), "mv7")
	}

	func testDoesNotGuessMissingOrPartialNames() {
		for name in [nil, "", "Shure", "Shure MV7 (Virtual)", "Shure MV7 (14ed:1012) extra"] as [String?] {
			XCTAssertNil(resolveMicrophoneDeviceID(deviceID: "browser-hash", deviceName: name, devices: devices))
		}
	}

	func testAmbiguousNamesDoNotPickFirstDevice() {
		let duplicates = devices + [(id: "other", name: "Shure MV7")]
		for name in ["Shure MV7", "Shure MV7 (14ED:1012)"] {
			XCTAssertNil(resolveMicrophoneDeviceID(deviceID: nil, deviceName: name, devices: duplicates))
		}
		XCTAssertEqual(resolveMicrophoneDeviceID(deviceID: "other", deviceName: "Shure MV7", devices: duplicates), "other")
	}

	func testExactDecoratedDeviceNameIsPreserved() {
		let decorated = devices + [(id: "literal", name: "Shure MV7 (14ed:1012)")]
		XCTAssertEqual(resolveMicrophoneDeviceID(deviceID: nil, deviceName: "Shure MV7 (14ed:1012)", devices: decorated), "literal")
	}
}
