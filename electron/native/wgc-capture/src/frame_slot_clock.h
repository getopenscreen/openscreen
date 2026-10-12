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
 * has caught up. The slots it owes repeat the last picture, which costs no
 * readback (#925), so catching up is cheap whatever the screen does.
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

    // Whether the next frame's slot is already in the past at nowHns: the slot
    // after it is due too. Such a slot is owed, not live, so it takes the
    // picture already encoded instead of a new readback. Catching up with
    // readbacks only works while a readback costs less than a period; under
    // load a changing screen makes every tick a readback that costs more, the
    // count never catches up, and the video plays ever earlier against the audio.
    bool isBehind(int64_t nowHns) const {
        return originHns_ >= 0 && nowHns >= originHns_ + (frames_ + 1) * 10'000'000 / fps_;
    }

private:
    int fps_;
    int64_t originHns_ = -1;
    int64_t frames_ = 0;
};

/**
 * Whether a tick reads the screen back or repeats the last picture.
 *
 * A changed screen is read back, an unchanged one repeated (#925). A slot
 * already in the past (FrameSlotClock::isBehind) repeats either way, and the
 * change it skipped stays pending until a live slot reads it: WGC delivers a
 * frame only when the screen changes, so a change seen on a past slot and
 * followed by a still screen would otherwise never reach the video.
 */
class PictureReadback {
public:
    // `changed`: a new picture arrived this tick. True when this tick must
    // read back, which also takes the pending change off the books.
    bool readBackNow(bool changed, bool slotIsPast) {
        pending_ = pending_ || changed;
        if (!pending_ || slotIsPast) {
            return false;
        }
        pending_ = false;
        return true;
    }

private:
    bool pending_ = false;
};
