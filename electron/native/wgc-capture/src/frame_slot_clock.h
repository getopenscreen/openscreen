#pragma once

#include <algorithm>
#include <cstdint>

/**
 * When the writer's next tick is due, on the recording clock.
 *
 * The slots are a fixed grid from the first frame: slot N is due at
 * origin + N/fps, computed from the origin each time and never accumulated, so
 * 1/fps rounding cannot drift a long recording.
 *
 * A late tick does not repay the slots it missed. Every sample is stamped with
 * the recording-clock time of its own tick (see main.cpp's writeVideoFrames),
 * and the sink writer keeps those times (MFEncoder::submitVideoSample gives
 * each sample its real duration), so a missed slot is already a
 * correctly timed gap: the previous frame plays through it. Repaying it with a
 * burst of back-to-back ticks would only crowd frames together after the gap.
 * The next tick is due at the first slot after the late one.
 *
 * Times are recording time in 100 ns units: elapsed since the shared start,
 * pauses excluded, so a pause owes no frames.
 */
class FrameSlotClock {
public:
    explicit FrameSlotClock(int fps) : fps_(std::max(1, fps)) {}

    // A tick that started at `tickHns` wrote its frame. The first one sets the
    // origin: the stream starts with its first frame, not before it.
    void advance(int64_t tickHns) {
        if (originHns_ < 0) {
            originHns_ = tickHns;
        }
        const int64_t slot = std::max<int64_t>(0, tickHns - originHns_) * fps_ / 10'000'000;
        slots_ = std::max(slots_ + 1, slot + 1);
    }

    // Due at once before the first frame.
    int64_t nextDueHns() const {
        return originHns_ < 0 ? 0 : originHns_ + slots_ * 10'000'000 / fps_;
    }

private:
    int fps_;
    int64_t originHns_ = -1;
    int64_t slots_ = 0;
};

/**
 * The time a screen or webcam sample carries: the recording-clock instant its
 * tick started, on the clock the audio follows. One rule for a new picture
 * and a repeated one alike. Never a count of frames: repeats stamped
 * "last + 1/fps" put a stall's time back on the frame count (#945). Never the
 * WGC frame's SystemRelativeTime either: DWM's presentation estimate, it can
 * lie ahead of the tick that pulls it, and mixing it with tick-stamped repeats
 * made the times jitter by a refresh period. Kept strictly increasing, as the
 * sink writer needs.
 */
inline int64_t sampleTimeForTick(int64_t tickHns, int64_t lastSampleHns) {
    return lastSampleHns >= 0 && tickHns <= lastSampleHns ? lastSampleHns + 1 : tickHns;
}
