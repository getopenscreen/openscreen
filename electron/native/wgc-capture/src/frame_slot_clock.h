#pragma once

#include <algorithm>
#include <cstdint>

/**
 * When the next frame of a constant-rate stream is due, on the wall clock.
 *
 * Media Foundation's H.264 sink writer numbers its output frames at the
 * nominal rate whatever SampleTime they carry, so frame N plays at N/fps: the
 * frame count is the stream's clock. A writer that falls behind and then
 * resyncs to "now" drops the slots it missed, and every later frame plays
 * early against the audio, which follows the wall clock
 * (getopenscreen/openscreen#945). This clock never resyncs: a late writer
 * finds the next frame already due and writes it at once, until the count
 * has caught up. Repeating an unchanged screen costs no readback (#925), so
 * catching up is cheap.
 *
 * Times are recording time in 100 ns units: elapsed since the shared start,
 * pauses excluded, so a pause owes no frames.
 */
class FrameSlotClock {
public:
    explicit FrameSlotClock(int fps) : fps_(std::max(1, fps)) {}

    // A frame was written, or its slot given up. The first one sets the
    // origin: the stream starts with its first frame, not before it.
    void advance(int64_t nowHns) {
        if (originHns_ < 0) {
            originHns_ = nowHns;
        }
        ++frames_;
    }

    // Due at once before the first frame. Computed from the origin each time,
    // never accumulated, so 1/fps rounding cannot drift a long recording.
    int64_t nextDueHns() const {
        return originHns_ < 0 ? 0 : originHns_ + frames_ * 10'000'000 / fps_;
    }

private:
    int fps_;
    int64_t originHns_ = -1;
    int64_t frames_ = 0;
};
