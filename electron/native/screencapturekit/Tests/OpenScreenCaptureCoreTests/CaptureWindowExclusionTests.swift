import XCTest
@testable import OpenScreenCaptureCore

final class CaptureWindowExclusionTests: XCTestCase {
	func testResolvesUniqueRequestedWindowsInRequestOrder() {
		XCTAssertEqual(
			resolveCaptureExcludedWindowIDs(
				requestedWindowIDs: [42, 7, 42, 99],
				availableWindowIDs: [99, 42, 7, 500]
			),
			[42, 7, 99]
		)
	}

	func testIgnoresWindowsUnavailableToScreenCaptureKit() {
		XCTAssertEqual(
			resolveCaptureExcludedWindowIDs(
				requestedWindowIDs: [42, 404, 7],
				availableWindowIDs: [7, 42]
			),
			[42, 7]
		)
	}

	func testLegacyRequestWithoutExclusionsRemainsEmpty() {
		XCTAssertEqual(
			resolveCaptureExcludedWindowIDs(
				requestedWindowIDs: [],
				availableWindowIDs: [42]
			),
			[]
		)
	}
}

final class SystemCaptureExclusionTests: XCTestCase {
	private let windows = [
		CaptureWindowCandidate(windowID: 1, bundleID: "com.apple.finder", layer: -2_147_483_603),
		CaptureWindowCandidate(windowID: 2, bundleID: "com.apple.finder", layer: 0),
		CaptureWindowCandidate(windowID: 3, bundleID: "com.apple.notificationcenterui", layer: 23),
		CaptureWindowCandidate(windowID: 4, bundleID: "com.apple.dock", layer: -2_147_483_624),
		CaptureWindowCandidate(windowID: 5, bundleID: nil, layer: -2_147_483_603),
	]

	func testNotificationsAreAlwaysLeftOut() {
		XCTAssertEqual(systemCaptureExcludedWindowIDs(windows, hideDesktopIcons: false), [3])
	}

	func testDesktopIconsGoOnlyOnRequestAndFinderWindowsStay() {
		XCTAssertEqual(systemCaptureExcludedWindowIDs(windows, hideDesktopIcons: true), [3, 1])
	}

	func testDesktopIconsAreFinderWindowsBelowTheNormalLevelOnly() {
		XCTAssertEqual(desktopIconWindowIDs(windows), [1])
	}
}
