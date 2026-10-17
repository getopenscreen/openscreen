import AudioToolbox
import CoreMedia
import Foundation

/// Mono Float32 at 48 kHz from Chromium's audio MediaStreamTrackProcessor.
public struct ExternalMicrophonePacket: Decodable, Equatable {
	public let recordingId: Int
	public let timestampUs: Int64
	public let data: Data

	public func sampleBuffer() -> CMSampleBuffer? {
		guard timestampUs > 0, !data.isEmpty, data.count <= 19_200, data.count % 4 == 0 else {
			return nil
		}
		var samples = data.withUnsafeBytes { bytes in
			stride(from: 0, to: bytes.count, by: 4).map { bytes.loadUnaligned(fromByteOffset: $0, as: Float.self) }
		}
		guard samples.allSatisfy({ $0.isFinite }) else { return nil }
		var asbd = AudioStreamBasicDescription(
			mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
			mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
			mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
			mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0
		)
		var format: CMAudioFormatDescription?
		guard CMAudioFormatDescriptionCreate(
			allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
			magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format
		) == noErr, let format else { return nil }
		return samples.withUnsafeMutableBytes { bytes in
			var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
				mNumberChannels: 1, mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress
			))
			// On macOS Chromium TimeTicks and CoreMedia host time both use mach_absolute_time.
			// AudioData already subtracts AEC's added delay; receipt time would shift the voice.
			return makeAudioSampleBuffer(
				copying: &list, format: format,
				presentationTime: CMTime(value: timestampUs, timescale: 1_000_000)
			)
		}
	}
}

/// Removes paused intervals from delayed microphone buffers by capture time, not delivery time.
public struct MicrophoneTimeline {
	private var pauses: [(start: CMTime, end: CMTime?)] = []
	public init() {}

	public mutating func pause(at time: CMTime) {
		pauses.append((time, nil))
	}

	public mutating func resume(at time: CMTime) {
		guard !pauses.isEmpty else { return }
		pauses[pauses.count - 1].end = time
	}

	public func retime(_ buffer: CMSampleBuffer, endingAt end: CMTime? = nil) -> [CMSampleBuffer] {
		let start = CMSampleBufferGetPresentationTimeStamp(buffer)
		let count = CMSampleBufferGetNumSamples(buffer)
		var offset = CMTime.zero
		var first = 0
		var result: [CMSampleBuffer] = []
		func frame(at time: CMTime) -> Int {
			Int(CMTimeConvertScale(CMTimeSubtract(time, start), timescale: 48_000, method: .roundTowardPositiveInfinity).value)
		}
		let limit = end.map { max(0, min(count, frame(at: $0))) } ?? count
		func append(until last: Int) {
			guard last > first else { return }
			var slice: CMSampleBuffer?
			guard CMSampleBufferCopySampleBufferForRange(
				allocator: kCFAllocatorDefault, sampleBuffer: buffer,
				sampleRange: CFRange(location: first, length: last - first), sampleBufferOut: &slice
			) == noErr, let slice else { return }
			var timing = CMSampleTimingInfo(
				duration: CMTime(value: 1, timescale: 48_000),
				presentationTimeStamp: CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp(slice), offset),
				decodeTimeStamp: .invalid
			)
			var retimed: CMSampleBuffer?
			if CMSampleBufferCreateCopyWithNewTiming(
				allocator: kCFAllocatorDefault, sampleBuffer: slice,
				sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleBufferOut: &retimed
			) == noErr, let retimed { result.append(retimed) }
		}
		for pause in pauses {
			append(until: max(first, min(limit, frame(at: pause.start))))
			guard let resume = pause.end else { return result }
			first = max(first, min(limit, frame(at: resume)))
			offset = CMTimeAdd(offset, CMTimeSubtract(resume, pause.start))
		}
		append(until: limit)
		return result
	}
}
