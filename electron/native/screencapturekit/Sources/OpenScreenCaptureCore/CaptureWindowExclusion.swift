/// Resolves native window IDs against the same ScreenCaptureKit snapshot used to
/// construct the stream filter. The order is stable for useful diagnostics, and
/// duplicate requests cannot produce duplicate filter entries.
public func resolveCaptureExcludedWindowIDs(
	requestedWindowIDs: [UInt32],
	availableWindowIDs: [UInt32]
) -> [UInt32] {
	let available = Set(availableWindowIDs)
	var seen = Set<UInt32>()
	return requestedWindowIDs.filter { windowID in
		available.contains(windowID) && seen.insert(windowID).inserted
	}
}

/// Notification Center's process: banners, alerts, and on macOS 14+ the desktop widgets.
public let notificationCenterBundleID = "com.apple.notificationcenterui"
public let finderBundleID = "com.apple.finder"

/// The little a display capture needs to know about a window to decide whether it belongs
/// in a demo. Built from an `SCWindow` or a `CGWindowListCopyWindowInfo` entry alike.
public struct CaptureWindowCandidate: Equatable {
	public let windowID: UInt32
	public let bundleID: String?
	/// Window level. Normal app windows sit at 0; Finder draws the desktop icons far below.
	public let layer: Int

	public init(windowID: UInt32, bundleID: String?, layer: Int) {
		self.windowID = windowID
		self.bundleID = bundleID
		self.layer = layer
	}
}

/// Finder's desktop-icon windows. Finder's ordinary windows sit at the normal level and
/// stay in the recording.
public func desktopIconWindowIDs(_ windows: [CaptureWindowCandidate]) -> [UInt32] {
	return windows.filter { $0.bundleID == finderBundleID && $0.layer < 0 }.map(\.windowID)
}

/// System windows a display capture leaves out on its own, beside the app's own HUD:
/// notifications always, the desktop icons when the user asked for it.
public func systemCaptureExcludedWindowIDs(
	_ windows: [CaptureWindowCandidate],
	hideDesktopIcons: Bool
) -> [UInt32] {
	let notifications = windows.filter { $0.bundleID == notificationCenterBundleID }.map(\.windowID)
	return notifications + (hideDesktopIcons ? desktopIconWindowIDs(windows) : [])
}
