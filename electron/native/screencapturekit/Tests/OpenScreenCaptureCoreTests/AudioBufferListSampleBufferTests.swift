import AudioToolbox
import CoreMedia
import XCTest
@testable import OpenScreenCaptureCore

final class AudioBufferListSampleBufferTests: XCTestCase {
	/// What a Core Audio tap delivers on Apple silicon: 48 kHz stereo Float32, one buffer per
	/// channel.
	private func nonInterleavedFloatFormat(sampleRate: Double = 48_000) throws -> CMAudioFormatDescription {
		var asbd = AudioStreamBasicDescription(
			mSampleRate: sampleRate,
			mFormatID: kAudioFormatLinearPCM,
			mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
			mBytesPerPacket: 4,
			mFramesPerPacket: 1,
			mBytesPerFrame: 4,
			mChannelsPerFrame: 2,
			mBitsPerChannel: 32,
			mReserved: 0
		)
		var format: CMAudioFormatDescription?
		let status = CMAudioFormatDescriptionCreate(
			allocator: kCFAllocatorDefault,
			asbd: &asbd,
			layoutSize: 0,
			layout: nil,
			magicCookieSize: 0,
			magicCookie: nil,
			extensions: nil,
			formatDescriptionOut: &format
		)
		XCTAssertEqual(status, noErr)
		return try XCTUnwrap(format)
	}

	/// Runs `body` with a two-buffer list holding `left` and `right`.
	private func withStereoBufferList<T>(
		left: [Float],
		right: [Float],
		_ body: (UnsafePointer<AudioBufferList>) throws -> T
	) rethrows -> T {
		var left = left
		var right = right
		return try left.withUnsafeMutableBytes { leftBytes in
			try right.withUnsafeMutableBytes { rightBytes in
				let list = AudioBufferList.allocate(maximumBuffers: 2)
				defer { free(list.unsafeMutablePointer) }
				list[0] = AudioBuffer(
					mNumberChannels: 1,
					mDataByteSize: UInt32(leftBytes.count),
					mData: leftBytes.baseAddress
				)
				list[1] = AudioBuffer(
					mNumberChannels: 1,
					mDataByteSize: UInt32(rightBytes.count),
					mData: rightBytes.baseAddress
				)
				return try body(UnsafePointer(list.unsafeMutablePointer))
			}
		}
	}

	func testStampsTheBufferOnTheHostClockLikeScreenCaptureKit() throws {
		let format = try nonInterleavedFloatFormat()
		let hostTime = mach_absolute_time()

		let sampleBuffer = try XCTUnwrap(withStereoBufferList(left: [0.5, -0.5, 0.25], right: [0, 0, 0]) {
			makeAudioSampleBuffer(copying: $0, format: format, hostTime: hostTime)
		})

		XCTAssertEqual(CMSampleBufferGetNumSamples(sampleBuffer), 3)
		XCTAssertEqual(
			CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
			CMClockMakeHostTimeFromSystemUnits(hostTime)
		)
		XCTAssertTrue(CMSampleBufferDataIsReady(sampleBuffer))
	}

	func testCopiesTheSamplesOutOfTheCallbacksBuffers() throws {
		let format = try nonInterleavedFloatFormat()
		let sampleBuffer = try XCTUnwrap(withStereoBufferList(left: [0.5, -0.5], right: [0.25, 1]) {
			makeAudioSampleBuffer(copying: $0, format: format, hostTime: 1)
		})
		// The source arrays are gone by now; the sample buffer must still hold their values.

		let list = AudioBufferList.allocate(maximumBuffers: 2)
		defer { free(list.unsafeMutablePointer) }
		var blockBuffer: CMBlockBuffer?
		let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
			sampleBuffer,
			bufferListSizeNeededOut: nil,
			bufferListOut: list.unsafeMutablePointer,
			bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: 2),
			blockBufferAllocator: kCFAllocatorDefault,
			blockBufferMemoryAllocator: kCFAllocatorDefault,
			flags: 0,
			blockBufferOut: &blockBuffer
		)
		XCTAssertEqual(status, noErr)
		let left = UnsafeBufferPointer(start: list[0].mData!.assumingMemoryBound(to: Float.self), count: 2)
		let right = UnsafeBufferPointer(start: list[1].mData!.assumingMemoryBound(to: Float.self), count: 2)
		XCTAssertEqual(Array(left), [0.5, -0.5])
		XCTAssertEqual(Array(right), [0.25, 1])
	}

	func testRefusesAnEmptyCycle() throws {
		let format = try nonInterleavedFloatFormat()
		XCTAssertNil(withStereoBufferList(left: [], right: []) {
			makeAudioSampleBuffer(copying: $0, format: format, hostTime: 1)
		})
	}
}
