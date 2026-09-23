import Foundation

/// What Apple's system picker may offer. Mirrors the helper's own source types.
public enum PickerMode: String, Equatable {
	case display
	case window
}

/// One line of the `--picker-session` stdin protocol.
///
/// The single-take helper takes its whole request on argv and reads only `pause`, `resume`
/// and `stop` afterwards. A picker session outlives any one take, so it needs a few more
/// verbs, and `start` carries the take's request instead of argv. The bare words stay bare
/// so both modes read the same three commands the same way.
public enum PickerSessionCommand: Equatable {
	/// Show Apple's picker. `excludedWindowIDs` keeps OpenScreen's own HUD and notes out of
	/// a display capture: the filter the picker hands back cannot be edited afterwards, so
	/// the exclusion has to be part of the picker's configuration.
	case present(excludedWindowIDs: [Int], modes: [PickerMode])
	/// Start a take from the retained choice. The request JSON is kept raw for the
	/// recorder's own decoder.
	case start(request: Data)
	case pause
	case resume
	case stop
	case quit
}

public func parsePickerSessionCommand(_ line: String) -> PickerSessionCommand? {
	let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
	switch trimmed {
	case "pause": return .pause
	case "resume": return .resume
	case "stop": return .stop
	case "quit": return .quit
	default: break
	}

	guard let data = trimmed.data(using: .utf8),
		let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
		let command = object["command"] as? String
	else {
		return nil
	}

	switch command {
	case "present":
		let excluded = (object["excludedWindowIds"] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.intValue }
		let requestedModes = (object["modes"] as? [String] ?? []).compactMap(PickerMode.init(rawValue:))
		return .present(
			excludedWindowIDs: excluded,
			modes: requestedModes.isEmpty ? [.display, .window] : requestedModes
		)
	case "start":
		guard let request = object["request"],
			JSONSerialization.isValidJSONObject(request),
			let requestData = try? JSONSerialization.data(withJSONObject: request)
		else {
			return nil
		}
		return .start(request: requestData)
	case "pause": return .pause
	case "resume": return .resume
	case "stop": return .stop
	case "quit": return .quit
	default: return nil
	}
}
