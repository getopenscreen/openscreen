import AudioToolbox
import CoreMedia
import Foundation

/// Wraps one Core Audio IO cycle as the `CMSampleBuffer` the mixer already reads.
///
/// The system-audio tap delivers an `AudioBufferList` and the host time it was captured at.
/// ScreenCaptureKit's audio output delivered `CMSampleBuffer`s stamped on the host clock.
/// Stamping the tap's audio on that same clock is what lets it go through the recorder's
/// existing pause and retime path, and land in `AudioTrackMixer` at the offset it belongs
/// at, exactly as ScreenCaptureKit's did.
///
/// The data is copied: the IO proc's buffers are only valid for the duration of the callback.
public func makeAudioSampleBuffer(
	copying bufferList: UnsafePointer<AudioBufferList>,
	format: CMAudioFormatDescription,
	hostTime: UInt64
) -> CMSampleBuffer? {
	guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
		asbd.mBytesPerFrame > 0,
		asbd.mSampleRate > 0
	else {
		return nil
	}
	let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: bufferList))
	guard let first = buffers.first, first.mDataByteSize > 0 else {
		return nil
	}
	// Per buffer: one channel for non-interleaved audio, every channel for interleaved.
	let frameCount = Int(first.mDataByteSize / asbd.mBytesPerFrame)
	guard frameCount > 0 else {
		return nil
	}

	var timing = CMSampleTimingInfo(
		duration: CMTime(value: 1, timescale: CMTimeScale(asbd.mSampleRate)),
		presentationTimeStamp: CMClockMakeHostTimeFromSystemUnits(hostTime),
		decodeTimeStamp: .invalid
	)
	var sampleBuffer: CMSampleBuffer?
	var status = CMSampleBufferCreate(
		allocator: kCFAllocatorDefault,
		dataBuffer: nil,
		dataReady: false,
		makeDataReadyCallback: nil,
		refcon: nil,
		formatDescription: format,
		sampleCount: frameCount,
		sampleTimingEntryCount: 1,
		sampleTimingArray: &timing,
		sampleSizeEntryCount: 0,
		sampleSizeArray: nil,
		sampleBufferOut: &sampleBuffer
	)
	guard status == noErr, let sampleBuffer else {
		return nil
	}
	status = CMSampleBufferSetDataBufferFromAudioBufferList(
		sampleBuffer,
		blockBufferAllocator: kCFAllocatorDefault,
		blockBufferMemoryAllocator: kCFAllocatorDefault,
		flags: 0,
		bufferList: bufferList
	)
	return status == noErr ? sampleBuffer : nil
}
