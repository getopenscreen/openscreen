import AudioToolbox
import CoreAudio
import CoreMedia
import Foundation
import OpenScreenCaptureCore

/// System audio from a Core Audio process tap, for takes recorded from Apple's picker.
///
/// A picker-based capture needs no Screen Recording grant, but its system audio does:
/// without the grant ScreenCaptureKit delivers the audio buffers and fills them with zeros
/// (measured on macOS 26.5). A process tap is gated by a separate, narrower permission --
/// "System Audio Recording Only", `NSAudioCaptureUsageDescription` -- that covers the sound
/// the Mac plays and nothing on screen. With it, a picked take records system audio with no
/// Screen Recording grant at all, in the same process and without a relaunch (also measured).
///
/// Starting the tap blocks until the user answers macOS' prompt the first time it is asked,
/// so callers keep it off any path with a deadline.
///
/// Buffers are handed over as `CMSampleBuffer`s stamped on the host clock, the domain
/// ScreenCaptureKit's audio used, so they take the recorder's existing pause and retime path.
@available(macOS 14.2, *)
final class SystemAudioTap {
	private let queue = DispatchQueue(label: "app.openscreen.sck-helper.system-audio-tap")
	private let onBuffer: (CMSampleBuffer) -> Void
	private var tapID = AudioObjectID(kAudioObjectUnknown)
	private var aggregateID = AudioObjectID(kAudioObjectUnknown)
	private var procID: AudioDeviceIOProcID?

	init(onBuffer: @escaping (CMSampleBuffer) -> Void) {
		self.onBuffer = onBuffer
	}

	struct TapError: Error, CustomStringConvertible {
		let call: String
		let status: OSStatus
		var description: String { "\(call) failed (OSStatus \(status))" }
	}

	private static func check(_ status: OSStatus, _ call: String) throws {
		guard status == noErr else {
			throw TapError(call: call, status: status)
		}
	}

	/// Starts the tap. Blocks while macOS' permission prompt is on screen.
	///
	/// All or nothing: a failure part-way releases whatever was already created, so a tap
	/// that never started holds no Core Audio objects, whoever does or does not stop it later.
	func start() throws {
		var didStart = false
		defer {
			if !didStart {
				stop()
			}
		}

		// Nothing to exclude: the helper plays no sound, which is all ScreenCaptureKit's
		// `excludesCurrentProcessAudio` ever took out.
		let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
		description.uuid = UUID()
		description.isPrivate = true
		description.muteBehavior = .unmuted
		try Self.check(AudioHardwareCreateProcessTap(description, &tapID), "AudioHardwareCreateProcessTap")

		let format = try tapFormat()
		let aggregate: [String: Any] = [
			kAudioAggregateDeviceNameKey: "OpenScreen system audio",
			kAudioAggregateDeviceUIDKey: UUID().uuidString,
			kAudioAggregateDeviceIsPrivateKey: true,
			kAudioAggregateDeviceIsStackedKey: false,
			kAudioAggregateDeviceTapAutoStartKey: true,
			kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString]],
		]
		try Self.check(
			AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID),
			"AudioHardwareCreateAggregateDevice"
		)

		let onBuffer = self.onBuffer
		try Self.check(
			AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, input, inputTime, _, _ in
				let timestamp = inputTime.pointee
				let hostTime = timestamp.mFlags.contains(.hostTimeValid)
					? timestamp.mHostTime
					: mach_absolute_time()
				if let sampleBuffer = makeAudioSampleBuffer(copying: input, format: format, hostTime: hostTime) {
					onBuffer(sampleBuffer)
				}
			},
			"AudioDeviceCreateIOProcIDWithBlock"
		)
		try Self.check(AudioDeviceStart(aggregateID, procID), "AudioDeviceStart")
		didStart = true
	}

	func stop() {
		if let procID {
			AudioDeviceStop(aggregateID, procID)
			AudioDeviceDestroyIOProcID(aggregateID, procID)
			self.procID = nil
		}
		if aggregateID != kAudioObjectUnknown {
			AudioHardwareDestroyAggregateDevice(aggregateID)
			aggregateID = AudioObjectID(kAudioObjectUnknown)
		}
		if tapID != kAudioObjectUnknown {
			AudioHardwareDestroyProcessTap(tapID)
			tapID = AudioObjectID(kAudioObjectUnknown)
		}
	}

	private func tapFormat() throws -> CMAudioFormatDescription {
		var asbd = AudioStreamBasicDescription()
		var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
		var address = AudioObjectPropertyAddress(
			mSelector: kAudioTapPropertyFormat,
			mScope: kAudioObjectPropertyScopeGlobal,
			mElement: kAudioObjectPropertyElementMain
		)
		try Self.check(
			AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &asbd),
			"kAudioTapPropertyFormat"
		)
		var format: CMAudioFormatDescription?
		try Self.check(
			CMAudioFormatDescriptionCreate(
				allocator: kCFAllocatorDefault,
				asbd: &asbd,
				layoutSize: 0,
				layout: nil,
				magicCookieSize: 0,
				magicCookie: nil,
				extensions: nil,
				formatDescriptionOut: &format
			),
			"CMAudioFormatDescriptionCreate"
		)
		guard let format else {
			throw TapError(call: "CMAudioFormatDescriptionCreate", status: -1)
		}
		return format
	}

	/// Raises macOS' "record system audio" prompt, for the permissions window and the HUD's
	/// system-audio toggle, so the first take never waits on it. Returns once the prompt is
	/// answered (or at once when it was already answered). There is no public way to read the
	/// answer: a refused tap runs, and records silence.
	static func requestAccess() throws {
		let tap = SystemAudioTap { _ in }
		defer { tap.stop() }
		try tap.start()
	}
}
