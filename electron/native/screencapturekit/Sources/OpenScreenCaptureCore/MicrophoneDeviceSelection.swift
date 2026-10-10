import Foundation

/// Chromium decorates USB labels with a vendor/product suffix; AVFoundation does not.
/// Resolve IDs first and only accept unambiguous names, never a substring match.
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
	let normalized = name.replacingOccurrences(
		of: #" \([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)$"#,
		with: "",
		options: .regularExpression
	)
	guard normalized != name else { return nil }
	let matches = devices.filter { $0.name == normalized }
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
