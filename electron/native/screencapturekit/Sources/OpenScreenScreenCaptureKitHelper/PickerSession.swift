import AppKit
import CoreGraphics
import Foundation
import OpenScreenCaptureCore
import ScreenCaptureKit

/// `--picker-session`: Apple's system picker, and every take recorded from what it returns.
///
/// Why a session instead of the usual one process per take:
///
/// - A capture that starts from `SCContentSharingPicker` needs no Screen Recording grant and
///   never raises macOS 15's "bypass the system private window picker" alert: the user's
///   pick is the consent. Measured on macOS 26.5 for display and window picks, from a
///   helper process like this one.
/// - That consent lives in the `SCContentFilter` the picker hands back, and a filter cannot
///   leave the process (it is not NSSecureCoding). So the process that asked has to be the
///   one that records -- and has to stay alive to record the same source again without
///   asking the user to pick it again for every take.
///
/// Each take still gets its own `ScreenCaptureRecorder` and its own `SCStream`, so pause,
/// the audio timeline and the writer behave exactly as in the single-take helper.
///
/// Protocol: one command per stdin line (`PickerSessionCommand`), events on stdout as
/// everywhere else, plus `picker-session-ready`, `picker-presented`, `picker-selected`,
/// `picker-cancelled`, `picker-failed` and `take-ended`. Closing stdin ends the session: nothing here may
/// outlive the app.
///
/// 15.2, not 14.0 where the picker API starts: `includedDisplays` and `includedWindows`
/// arrive in 15.2, and without them the pick cannot be mapped to a screen position, which
/// the cursor telemetry needs. Before 15.2 the app keeps its own picker.
///
/// `@unchecked Sendable`: every piece of state here is read and written on the main queue
/// only -- commands and picker callbacks are all hopped onto it before they touch anything.
@available(macOS 15.2, *)
final class PickerSession: NSObject, SCContentSharingPickerObserver, @unchecked Sendable {
	private var picked: PickedSource?
	private var recorder: ScreenCaptureRecorder?

	func run() -> Never {
		let app = NSApplication.shared
		// No Dock icon and no menu bar: the picker is system UI and needs no window here.
		app.setActivationPolicy(.accessory)
		SCContentSharingPicker.shared.add(self)

		let reader = Thread {
			while let line = readLine() {
				guard let command = parsePickerSessionCommand(line) else {
					emit([
						"event": "warning",
						"code": "picker-session-unknown-command",
						"message": line,
					])
					continue
				}
				DispatchQueue.main.async { self.handle(command) }
			}
			// stdin closed: the app is gone, or never meant to keep us.
			DispatchQueue.main.async { self.shutdown() }
		}
		reader.start()

		emit(["event": "picker-session-ready"])
		app.run()
		exit(0)
	}

	private func handle(_ command: PickerSessionCommand) {
		switch command {
		case .present(let excludedWindowIDs, let modes):
			present(excludedWindowIDs: excludedWindowIDs, modes: modes)
		case .start(let request):
			startTake(request)
		case .pause:
			recorder?.pause()
		case .resume:
			recorder?.resume()
		case .stop:
			stopTake()
		case .quit:
			shutdown()
		}
	}

	// MARK: - Picker

	private func present(excludedWindowIDs: [Int], modes: [PickerMode]) {
		var configuration = SCContentSharingPickerConfiguration()
		var allowed: SCContentSharingPickerMode = []
		if modes.contains(.display) { allowed.insert(.singleDisplay) }
		if modes.contains(.window) { allowed.insert(.singleWindow) }
		configuration.allowedPickerModes = allowed
		// Swapping the source mid-take would change the frame size under a writer whose
		// dimensions are fixed when the take starts. A new source is a new pick.
		configuration.allowsChangingSelectedContent = false
		// A picked display filter hides this process's own windows, but not the app's:
		// the HUD and the notes window belong to Electron. Measured: a window owned by the
		// parent app shows in the capture unless it is listed here.
		configuration.excludedWindowIDs = excludedWindowIDs

		let picker = SCContentSharingPicker.shared
		picker.defaultConfiguration = configuration
		picker.isActive = true
		picker.present()
		emit(["event": "picker-presented"])
	}

	func contentSharingPicker(
		_ picker: SCContentSharingPicker,
		didUpdateWith filter: SCContentFilter,
		for stream: SCStream?
	) {
		DispatchQueue.main.async { self.didPick(filter, stream: stream) }
	}

	func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
		DispatchQueue.main.async {
			// A cancel for a running stream is the user stopping it from the menu bar, which
			// the take's own stop path already reports.
			if stream == nil {
				emit(["event": "picker-cancelled"])
			}
		}
	}

	func contentSharingPickerStartDidFailWithError(_ error: Error) {
		DispatchQueue.main.async {
			emit([
				"event": "picker-failed",
				"message": "\(error)",
			])
		}
	}

	private func didPick(_ filter: SCContentFilter, stream: SCStream?) {
		// Updates for an existing stream are Apple's "change what you share", switched off
		// by allowsChangingSelectedContent; one that arrives anyway must not swap the source.
		guard stream == nil else {
			return
		}

		let display = filter.includedDisplays.first
		let window = filter.includedWindows.first
		let frame = window?.frame ?? display?.frame ?? filter.contentRect
		let displayId = display?.displayID ?? Self.display(containing: frame)
		picked = PickedSource(filter: filter, frame: frame, displayId: displayId)

		var event: [String: Any] = [
			"event": "picker-selected",
			"kind": window != nil ? "window" : "display",
			"bounds": [
				"x": frame.origin.x,
				"y": frame.origin.y,
				"width": frame.size.width,
				"height": frame.size.height,
			],
			"pointPixelScale": filter.pointPixelScale,
		]
		if let displayId {
			event["displayId"] = displayId
		}
		if let window {
			event["windowId"] = window.windowID
			event["title"] = window.title ?? ""
			event["appName"] = window.owningApplication?.applicationName ?? ""
		}
		emit(event)
	}

	private static func display(containing frame: CGRect) -> CGDirectDisplayID? {
		var displays = [CGDirectDisplayID](repeating: 0, count: 8)
		var count: UInt32 = 0
		let center = CGRect(x: frame.midX, y: frame.midY, width: 1, height: 1)
		guard CGGetDisplaysWithRect(center, UInt32(displays.count), &displays, &count) == .success,
			count > 0
		else {
			return nil
		}
		return displays[0]
	}

	// MARK: - Takes

	private func startTake(_ requestData: Data) {
		guard recorder == nil else {
			emitError(code: "take-already-running", message: "A take is already recording in this session.")
			return
		}
		guard let picked else {
			emitError(code: "no-source-picked", message: "Nothing was picked in the system picker yet.")
			emit(["event": "take-ended"])
			return
		}

		let request: RecordingRequest
		do {
			request = try JSONDecoder().decode(RecordingRequest.self, from: requestData)
		} catch {
			emitError(code: "helper-error", message: "\(error)")
			emit(["event": "take-ended"])
			return
		}

		let recorder = ScreenCaptureRecorder(request: request, picked: picked)
		self.recorder = recorder
		let take = ObjectIdentifier(recorder)
		Task {
			do {
				try await recorder.start()
			} catch {
				// Same code the single-take helper reports on its way out, so the app reads a
				// failed start the same way on both paths.
				let message = (error as? HelperError)?.description ?? "\(error)"
				emitError(code: "helper-error", message: message)
				await recorder.stop()
				DispatchQueue.main.async { self.finishTake(take) }
			}
		}
	}

	private func stopTake() {
		guard let recorder else {
			emit(["event": "take-ended"])
			return
		}
		let take = ObjectIdentifier(recorder)
		Task {
			await recorder.stop()
			DispatchQueue.main.async { self.finishTake(take) }
		}
	}

	/// The session's replacement for the single-take helper exiting: the one event that
	/// says this take's output is complete.
	private func finishTake(_ finished: ObjectIdentifier) {
		guard let current = recorder, ObjectIdentifier(current) == finished else {
			return
		}
		recorder = nil
		emit(["event": "take-ended"])
	}

	private func shutdown() {
		SCContentSharingPicker.shared.isActive = false
		guard let recorder else {
			exit(0)
		}
		Task {
			await recorder.stop()
			exit(0)
		}
	}
}
