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
		for name in [
			nil, "", "Shure", "Shure MV7 (14ed:1012) extra", "Shure MV7 (USB)", "Shure MV7 (virtual)",
			"Shure MV7 (Virtual) (Virtual)", "(Virtual)",
		] as [String?] {
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

	func testNoInputRecordsWithoutTheMicrophone() {
		XCTAssertEqual(resolveMicrophoneCapture(supported: true, deviceID: nil, deviceName: nil, devices: []), .noInput)
		XCTAssertEqual(resolveMicrophoneCapture(supported: true, deviceID: "mv7", deviceName: "Shure MV7", devices: []), .noInput)
	}

	func testUnsupportedMacOSKeepsItsOwnReason() {
		XCTAssertEqual(resolveMicrophoneCapture(supported: false, deviceID: nil, deviceName: nil, devices: []), .unsupported)
		XCTAssertEqual(resolveMicrophoneCapture(supported: false, deviceID: "mv7", deviceName: nil, devices: devices), .unsupported)
	}

	func testListedInputIsCaptured() {
		XCTAssertEqual(resolveMicrophoneCapture(supported: true, deviceID: "mv7", deviceName: nil, devices: devices), .device("mv7"))
		XCTAssertEqual(resolveMicrophoneCapture(supported: true, deviceID: nil, deviceName: nil, devices: devices), .device(nil))
	}

	/// Labels as Chromium 146 lists them on macOS 26, beside the AVCaptureDevice that
	/// CoreAudio reports for the same input (uniqueID, localizedName).
	private let macInputs = [
		(id: "BlackHole2ch_UID", name: "BlackHole 2ch"),
		(id: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone"),
		(id: "AC-3E-B1-00-00-01:input", name: "AirPods Pro"),
		(id: "AppleUSBAudioEngine:Shure:MV7:1:1", name: "Shure MV7"),
		(id: "~:AMS2_Aggregate:0", name: "Aggregate Device"),
	]

	func testChromiumTransportSuffixesResolveToTheSelectedInput() {
		let labels = [
			"BlackHole 2ch (Virtual)": "BlackHole2ch_UID",
			"MacBook Pro Microphone (Built-in)": "BuiltInMicrophoneDevice",
			"AirPods Pro (Bluetooth)": "AC-3E-B1-00-00-01:input",
			"Shure MV7 (14ed:1012)": "AppleUSBAudioEngine:Shure:MV7:1:1",
			"Aggregate Device (Aggregate)": "~:AMS2_Aggregate:0",
		]
		for (label, id) in labels {
			XCTAssertEqual(
				resolveMicrophoneDeviceID(deviceID: "40657edc-browser-hash", deviceName: label, devices: macInputs),
				id,
				label
			)
		}
	}

	func testVirtualInputBesideAnotherResolvesToTheChosenOne() {
		// The reason this matters: BlackHole being the default hid the miss on the test Mac.
		XCTAssertEqual(
			resolveMicrophoneCapture(
				supported: true,
				deviceID: "40657edc-browser-hash",
				deviceName: "BlackHole 2ch (Virtual)",
				devices: macInputs
			),
			.device("BlackHole2ch_UID")
		)
	}

	func testChromiumDefaultEntryIsNotADevice() {
		XCTAssertNil(resolveMicrophoneDeviceID(deviceID: "default", deviceName: "Default - BlackHole 2ch (Virtual)", devices: macInputs))
	}

	func testDecoratedLabelSharedByTwoInputsStaysAmbiguous() {
		let twins = macInputs + [(id: "BlackHole2ch_UID_2", name: "BlackHole 2ch")]
		XCTAssertNil(resolveMicrophoneDeviceID(deviceID: nil, deviceName: "BlackHole 2ch (Virtual)", devices: twins))
	}

	func testExactDecoratedDeviceNameIsPreserved() {
		let decorated = devices + [(id: "literal", name: "Shure MV7 (14ed:1012)")]
		XCTAssertEqual(resolveMicrophoneDeviceID(deviceID: nil, deviceName: "Shure MV7 (14ed:1012)", devices: decorated), "literal")
	}

	func testExactBluetoothNamedDeviceIsPreserved() {
		let decorated = macInputs + [(id: "literal", name: "AirPods Pro (Bluetooth)")]
		XCTAssertEqual(resolveMicrophoneDeviceID(deviceID: nil, deviceName: "AirPods Pro (Bluetooth)", devices: decorated), "literal")
	}
}
