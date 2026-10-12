import Foundation

/// The suffixes Chromium appends to a macOS audio input's name to build its label
/// (`GetDeviceLabel` in media/audio/mac/core_audio_util_mac.cc): one per CoreAudio
/// transport type, or the USB vendor:product pair. AVFoundation's `localizedName` carries
/// none of them, so "BlackHole 2ch (Virtual)" has to be matched as "BlackHole 2ch".
private let chromiumLabelSuffixes = [
	#" \((Built-in|Virtual|Aggregate|Bluetooth)\)$"#,
	#" \([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)$"#,
]

/// The device name a Chromium label was built from, or nil when it carries no known suffix.
/// Only one suffix is ever removed: Chromium appends exactly one.
func stripChromiumLabelSuffix(_ label: String) -> String? {
	for pattern in chromiumLabelSuffixes {
		guard let range = label.range(of: pattern, options: .regularExpression) else { continue }
		let name = String(label[..<range.lowerBound])
		return name.isEmpty ? nil : name
	}
	return nil
}

/// Resolve IDs first and only accept unambiguous names, never a substring match. A name
/// is tried as given, then without the suffix Chromium decorated it with; a name that
/// two inputs share resolves to neither, so the caller falls back to the default and says so.
public func resolveMicrophoneDeviceID(
	deviceID: String?,
	deviceName: String?,
	devices: [(id: String, name: String)]
) -> String? {
	if let id = deviceID?.trimmingCharacters(in: .whitespacesAndNewlines),
		devices.contains(where: { $0.id == id }) {
		return id
	}
	guard let name = deviceName?.trimmingCharacters(in: .whitespacesAndNewlines),
		!name.isEmpty else { return nil }
	let exact = devices.filter { $0.name == name }
	if exact.count == 1 { return exact[0].id }
	if !exact.isEmpty { return nil }
	guard let undecorated = stripChromiumLabelSuffix(name) else { return nil }
	let matches = devices.filter { $0.name == undecorated }
	return matches.count == 1 ? matches[0].id : nil
}

/// What a take that asked for the microphone records.
public enum MicrophoneCapture: Equatable {
	/// This macOS has no ScreenCaptureKit microphone (before 15).
	case unsupported
	/// No audio input at all. ScreenCaptureKit, asked for a microphone anyway, starts that
	/// take and then never starts the next one in the same process (#995).
	case noInput
	/// The input to record; nil is the system default.
	case device(String?)
}

public func resolveMicrophoneCapture(
	supported: Bool,
	deviceID: String?,
	deviceName: String?,
	devices: [(id: String, name: String)]
) -> MicrophoneCapture {
	guard supported else { return .unsupported }
	guard !devices.isEmpty else { return .noInput }
	return .device(resolveMicrophoneDeviceID(deviceID: deviceID, deviceName: deviceName, devices: devices))
}
